/**
 * Per-(domain, instance) prompt-override admin-API
 * (PR-W2, phase-a appendix #15).
 *
 * Five scope-discriminated routes per scope ∈ {`domains`,
 * `agent-instances`} — ten endpoints total:
 *
 *   GET    /api/admin/{scope}/:id/prompts
 *     List the overrides currently in effect for this scope
 *     plus the shipped baseline manifest. Baseline bodies are
 *     inline so the UI's left-rail picker can render
 *     side-by-side without a second round-trip.
 *
 *   GET    /api/admin/{scope}/:id/prompts/:name/:locale
 *     Fetch one prompt body. Surfaces `source: 'override' |
 *     'baseline'` so the UI knows whether the editor opens with
 *     an existing override or a fresh fork from baseline.
 *
 *   POST   /api/admin/{scope}/:id/prompts/:name/:locale/preview
 *     Body: `{ proposedBody: string }`. Returns the server-
 *     canonical line-level diff + sovereignty token + 5-min
 *     TTL. The token is bound to (scope, scopeId, name, locale,
 *     proposedBodyHash, baselineVersion) — the baseline-version
 *     binding is wave-15 specific so a baseline rev between
 *     preview and apply rejects with 422 `baseline_version_drifted`
 *     (operator must re-preview).
 *
 *   POST   /api/admin/{scope}/:id/prompts/:name/:locale/apply
 *     Body: `{ proposedBody, token, confirmDiff: true }`. Token
 *     verify covers signature + expiry + payload-match. UPSERT
 *     the prompt_overrides row; audit row written BEFORE the
 *     UPSERT (audit-before-mutate invariant). Bumps
 *     `overrides_version` semver-style on every apply (patch
 *     bump for body-only changes; major bump if baseline_version
 *     changed). For v0.1 we always bump patch — the version is a
 *     monotonic apply counter, not a content-semantic version.
 *
 *   DELETE /api/admin/{scope}/:id/prompts/:name/:locale
 *     Clears the override (resolver falls through to next-most-
 *     specific scope). Audit row written BEFORE the DELETE.
 *
 * Threat-model:
 *   - CSRF + admin-team + audit-write-before-mutate on every
 *     state-changing route. `body` reaches the LLM verbatim —
 *     same trust class as `domains.llm_policy.system_prompt`.
 *   - 100 KB body cap enforced at Zod boundary + DB CHECK
 *     (defense in depth).
 *   - Sovereignty token non-replayable across (scope, scopeId,
 *     name, locale, proposedBodyHash, baselineVersion).
 *   - UUID-validate `:id` before SQL cast (mirrors PR 28
 *     pattern); reject `:name` against `PROMPT_NAMES` and
 *     `:locale` against `{en, pl}` BEFORE any DB read.
 *   - For scope=`agent-instances`, the resolved `domain_id` is
 *     `agent_instances.scope_domain_ids[0]`. We refuse to write
 *     when scope_domain_ids is empty (422 `instance_has_no_scope`).
 *   - Body bytes never enter the audit table (`payload_hash`
 *     only, per §3.13).
 *
 * Mirrors `domains-llm-policy.ts:128-246` token-by-token; the
 * diff is line-level instead of key-level because prompt bodies
 * are plain text not JSON.
 *
 * v0.1 deliberate scope-cuts (documented here so a future
 * reviewer doesn't reopen them without cause):
 *   - Single-operator semantics: the token binds (body,
 *     baselineVersion) but NOT the current override body/version
 *     that the diff was computed from. Two operators applying
 *     concurrently would race; the audit trail records both
 *     applies for transparency. Multi-operator concurrent edit
 *     lands when the deployment shape demands it.
 *   - Token replay within TTL: a successfully used token stays
 *     valid for the full 5-min TTL — a client retry after a
 *     network blip can re-apply. The UPSERT is idempotent body-
 *     wise; only the `overrides_version` patch-bumps and a
 *     second audit row writes. Single-use tokens are a v0.2
 *     hardening if the operator-visible "applied twice" line in
 *     the audit log becomes noisy.
 *   - `overrides_version` next-value SELECT before UPSERT can
 *     race two concurrent applies onto the same version string.
 *     Same single-operator caveat — the row state is identical
 *     after either ordering; only the counter desynchronises.
 *     Atomic incrementing inside the UPSERT (`overrides_version
 *     = (split + bump)`) is a v0.2 candidate.
 *   - Orphaned-instance domain: for scope=`agent-instances` the
 *     resolved `domain_id` is `scope_domain_ids[0]` without
 *     verifying the referenced domain still exists. The
 *     prompt_overrides FK on `domain_id` REJECTS the UPSERT if
 *     the domain has been deleted (defense in depth); list/
 *     preview surface the baseline for an orphaned instance.
 *     Adding a pre-check is a UX-message improvement, not a
 *     safety one.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  PROMPT_LOCALES,
  PROMPT_NAMES,
  PROMPT_VERSION_MANIFEST,
  loadPrompt,
  type PromptName,
} from "@opencoo/shared/prompts";

import { writeAuditLog, type AuditAction } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";
import {
  computePayloadHash,
  issueSovereigntyDiffToken,
  verifySovereigntyDiffToken,
} from "../sovereignty-token.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** 100 KB matches the DB CHECK. Defense in depth — the route
 *  rejects oversized bodies at the Zod boundary before the
 *  Postgres CHECK gets to. We measure UTF-8 byte length rather
 *  than JS string length so a 50 000-char Polish or emoji-laden
 *  body that codes to more than 100 KB on the wire is caught
 *  here before the DB CHECK's `length(body)` (which is
 *  character count in Postgres) lets it through. */
const BODY_BYTE_CAP = 100_000;

const PERSISTED_LOCALES = PROMPT_LOCALES.filter((l) => l !== "auto");

const proposedBodySchema = z
  .string()
  .refine(
    (s) => Buffer.byteLength(s, "utf8") <= BODY_BYTE_CAP,
    `body exceeds ${BODY_BYTE_CAP}-byte UTF-8 cap`,
  );

const previewSchema = z
  .object({
    proposedBody: proposedBodySchema,
  })
  .strict();

const applySchema = z
  .object({
    proposedBody: proposedBodySchema,
    token: z.string().min(1),
    confirmDiff: z.literal(true),
    /** Baseline version the operator saw at preview time. The
     *  apply route compares this to `current shipped` BEFORE
     *  verifying the token so a baseline rev between preview and
     *  apply surfaces as a distinct 422 `baseline_version_drifted`
     *  rather than the generic `payload_mismatch`. */
    baselineVersion: z.string().min(1),
  })
  .strict();

/** Discriminator for the routes' :scope path segment. */
type Scope = "domains" | "agent-instances";

/** Resolve the `domain_id` we persist on the override row given
 *  the scope of the request. For `domains` scope this is just
 *  the `:id`; for `agent-instances` scope we look up the
 *  instance's `scope_domain_ids[0]` so the row's `domain_id`
 *  matches the resolver's filter. */
async function resolveDomainId(
  db: Db,
  scope: Scope,
  scopeId: string,
): Promise<
  | { readonly ok: true; readonly domainId: string }
  | { readonly ok: false; readonly status: 404 | 422; readonly reason: string }
> {
  if (scope === "domains") {
    const r = (await db.execute(sql`
      SELECT id::text AS id FROM domains WHERE id = ${scopeId}::uuid
    `)) as unknown as { rows: Array<{ id: string }> };
    const row = r.rows[0];
    if (row === undefined) {
      return { ok: false, status: 404, reason: "domain_not_found" };
    }
    return { ok: true, domainId: row.id };
  }
  const r = (await db.execute(sql`
    SELECT scope_domain_ids FROM agent_instances WHERE id = ${scopeId}::uuid
  `)) as unknown as {
    rows: Array<{ scope_domain_ids: ReadonlyArray<string> | null }>;
  };
  const row = r.rows[0];
  if (row === undefined) {
    return { ok: false, status: 404, reason: "instance_not_found" };
  }
  const scopeArr = row.scope_domain_ids ?? [];
  if (scopeArr.length === 0) {
    return { ok: false, status: 422, reason: "instance_has_no_scope" };
  }
  return { ok: true, domainId: scopeArr[0]! };
}

/** Server-canonical line-level diff. Splits both sides on `\n`
 *  and emits `{op: 'same'|'add'|'del', line: string, index: number}`
 *  per source line. v0.1 is byte-level not LCS-shortest-edit
 *  — operators reviewing the diff get a clear "this line
 *  changed" signal without us shipping a diff library. The
 *  computation is server-side so a client cannot smuggle a
 *  fake diff into the apply step. */
export interface DiffLine {
  readonly op: "same" | "add" | "del";
  readonly line: string;
  /** 0-based index in `before` for `same`/`del` ops, or in
   *  `after` for `add` ops. Lets the UI render line numbers
   *  consistently across the two halves. */
  readonly index: number;
}

export function lineDiff(before: string, after: string): ReadonlyArray<DiffLine> {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: DiffLine[] = [];
  const max = Math.max(a.length, b.length);
  // Naive zip diff — for v0.1 prompts (median ~200 lines, max
  // ~800) this is fine and produces a readable diff. A real
  // Myers LCS lands in v0.2 if operators report "the diff
  // jumps around" when they re-indent.
  for (let i = 0; i < max; i++) {
    const al = a[i];
    const bl = b[i];
    if (al === bl) {
      // Trailing-empty case: both undefined → skip.
      if (al === undefined) continue;
      out.push({ op: "same", line: al, index: i });
      continue;
    }
    if (al !== undefined) out.push({ op: "del", line: al, index: i });
    if (bl !== undefined) out.push({ op: "add", line: bl, index: i });
  }
  return out;
}

/** Coerce the :name path param into a `PromptName` or fail
 *  cleanly. The CHECK constraint at the DB layer also rejects,
 *  but failing fast at the route boundary surfaces a clearer
 *  error to the UI. */
function parsePromptName(raw: string): PromptName | null {
  return (PROMPT_NAMES as readonly string[]).includes(raw)
    ? (raw as PromptName)
    : null;
}

function parsePersistedLocale(raw: string): "en" | "pl" | null {
  return raw === "en" || raw === "pl" ? raw : null;
}

export interface RegisterPromptOverridesRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly sessionHmacKey: Buffer;
}

export function registerPromptOverridesRoutes(
  args: RegisterPromptOverridesRoutesArgs,
): void {
  // Both scopes share the same handler set, parametrised by the
  // `:scope` literal in the path. The `prefix` array lets us
  // register identical routes twice without code duplication.
  const scopes: Scope[] = ["domains", "agent-instances"];

  for (const scope of scopes) {
    registerListOverrides({ ...args, scope });
    registerGetOverride({ ...args, scope });
    registerPreviewOverride({ ...args, scope });
    registerApplyOverride({ ...args, scope });
    registerDeleteOverride({ ...args, scope });
  }
}

interface ScopedRegisterArgs extends RegisterPromptOverridesRoutesArgs {
  readonly scope: Scope;
}

/* ----------------------- GET list --------------------------------- */

function registerListOverrides(args: ScopedRegisterArgs): void {
  args.app.get(
    `/api/admin/${args.scope}/:id/prompts`,
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const resolved = await resolveDomainId(args.db, args.scope, id);
      if (!resolved.ok) {
        return reply.code(resolved.status).send({ error: resolved.reason });
      }
      const overrides = await listOverridesForScope(
        args.db,
        args.scope,
        id,
        resolved.domainId,
      );
      const baselines = PROMPT_NAMES.flatMap((name) =>
        PERSISTED_LOCALES.map((locale) => {
          const baseline = loadPrompt({ name, locale });
          return {
            name,
            locale,
            version: baseline.version,
            body: baseline.body,
          };
        }),
      );
      return reply.code(200).send({ overrides, baselines });
    },
  );
}

interface ListedOverride {
  readonly name: PromptName;
  readonly locale: "en" | "pl";
  readonly scope: Scope;
  readonly overridesVersion: string;
  readonly baselineVersion: string;
  readonly isStale: boolean;
  readonly updatedAt: string;
  readonly updatedByUsername: string | null;
}

async function listOverridesForScope(
  db: Db,
  scope: Scope,
  scopeId: string,
  domainId: string,
): Promise<ReadonlyArray<ListedOverride>> {
  // For `domains` scope: list rows where instance_id IS NULL.
  // For `agent-instances` scope: list rows where instance_id =
  // the supplied id. We never surface "sibling" instance rows
  // from the picker — each scope sees only its own overrides
  // (the resolver layers them at run time).
  const result = (await db.execute(
    scope === "domains"
      ? sql`
          SELECT
            po.prompt_name, po.locale, po.overrides_version, po.baseline_version,
            po.updated_at, u.gitea_username AS username
          FROM prompt_overrides po
          LEFT JOIN users u ON u.id = po.updated_by_user_id
          WHERE po.domain_id = ${domainId}::uuid
            AND po.instance_id IS NULL
          ORDER BY po.prompt_name, po.locale
        `
      : sql`
          SELECT
            po.prompt_name, po.locale, po.overrides_version, po.baseline_version,
            po.updated_at, u.gitea_username AS username
          FROM prompt_overrides po
          LEFT JOIN users u ON u.id = po.updated_by_user_id
          WHERE po.domain_id = ${domainId}::uuid
            AND po.instance_id = ${scopeId}::uuid
          ORDER BY po.prompt_name, po.locale
        `,
  )) as unknown as {
    rows: Array<{
      prompt_name: string;
      locale: string;
      overrides_version: string;
      baseline_version: string;
      updated_at: string | Date;
      username: string | null;
    }>;
  };
  return result.rows.map((r) => {
    const name = r.prompt_name as PromptName;
    const currentBaseline = PROMPT_VERSION_MANIFEST[name];
    return {
      name,
      locale: r.locale as "en" | "pl",
      scope,
      overridesVersion: r.overrides_version,
      baselineVersion: r.baseline_version,
      isStale: r.baseline_version !== currentBaseline,
      updatedAt:
        typeof r.updated_at === "string"
          ? r.updated_at
          : r.updated_at.toISOString(),
      updatedByUsername: r.username,
    };
  });
}

/* ----------------------- GET single ------------------------------- */

function registerGetOverride(args: ScopedRegisterArgs): void {
  args.app.get(
    `/api/admin/${args.scope}/:id/prompts/:name/:locale`,
    async (req, reply) => {
      const params = req.params as {
        id: string;
        name: string;
        locale: string;
      };
      if (!z.string().uuid().safeParse(params.id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const name = parsePromptName(params.name);
      if (name === null) {
        return reply.code(400).send({ error: "unknown_prompt_name" });
      }
      const locale = parsePersistedLocale(params.locale);
      if (locale === null) {
        return reply.code(400).send({ error: "unknown_locale" });
      }
      const resolved = await resolveDomainId(args.db, args.scope, params.id);
      if (!resolved.ok) {
        return reply.code(resolved.status).send({ error: resolved.reason });
      }
      const row = await fetchOverrideRow(
        args.db,
        args.scope,
        params.id,
        resolved.domainId,
        name,
        locale,
      );
      const baseline = loadPrompt({ name, locale });
      if (row === null) {
        return reply.code(200).send({
          name,
          locale,
          scope: args.scope,
          body: baseline.body,
          version: baseline.version,
          source: "baseline" as const,
        });
      }
      return reply.code(200).send({
        name,
        locale,
        scope: args.scope,
        body: row.body,
        version: row.overrides_version,
        source: "override" as const,
        baselineVersion: row.baseline_version,
        isStale: row.baseline_version !== baseline.version,
      });
    },
  );
}

async function fetchOverrideRow(
  db: Db,
  scope: Scope,
  scopeId: string,
  domainId: string,
  name: PromptName,
  locale: "en" | "pl",
): Promise<
  | null
  | {
      readonly body: string;
      readonly overrides_version: string;
      readonly baseline_version: string;
    }
> {
  const r = (await db.execute(
    scope === "domains"
      ? sql`
          SELECT body, overrides_version, baseline_version
          FROM prompt_overrides
          WHERE domain_id = ${domainId}::uuid
            AND instance_id IS NULL
            AND prompt_name = ${name}
            AND locale = ${locale}
          LIMIT 1
        `
      : sql`
          SELECT body, overrides_version, baseline_version
          FROM prompt_overrides
          WHERE domain_id = ${domainId}::uuid
            AND instance_id = ${scopeId}::uuid
            AND prompt_name = ${name}
            AND locale = ${locale}
          LIMIT 1
        `,
  )) as unknown as {
    rows: Array<{
      body: string;
      overrides_version: string;
      baseline_version: string;
    }>;
  };
  return r.rows[0] ?? null;
}

/* ----------------------- POST preview ----------------------------- */

function registerPreviewOverride(args: ScopedRegisterArgs): void {
  args.app.post(
    `/api/admin/${args.scope}/:id/prompts/:name/:locale/preview`,
    { preHandler: requireCsrf },
    async (req, reply) => {
      const params = req.params as {
        id: string;
        name: string;
        locale: string;
      };
      if (!z.string().uuid().safeParse(params.id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const name = parsePromptName(params.name);
      if (name === null) {
        return reply.code(400).send({ error: "unknown_prompt_name" });
      }
      const locale = parsePersistedLocale(params.locale);
      if (locale === null) {
        return reply.code(400).send({ error: "unknown_locale" });
      }
      const parsed = previewSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const resolved = await resolveDomainId(args.db, args.scope, params.id);
      if (!resolved.ok) {
        return reply.code(resolved.status).send({ error: resolved.reason });
      }

      const baseline = loadPrompt({ name, locale });
      const existing = await fetchOverrideRow(
        args.db,
        args.scope,
        params.id,
        resolved.domainId,
        name,
        locale,
      );
      const before = existing?.body ?? baseline.body;
      const diff = lineDiff(before, parsed.data.proposedBody);

      // Token binds (scope, scopeId, name, locale, body-hash,
      // baselineVersion) — reusing the existing primitive's
      // SovereigntyDiffPayload shape by encoding the prompt-
      // override scope into `domainId` (it's the "what does
      // this token identify" slot).
      const tokenIdentity = `${args.scope}:${params.id}:${name}:${locale}`;
      const { token, expiresAt } = issueSovereigntyDiffToken({
        key: args.sessionHmacKey,
        payload: {
          domainId: tokenIdentity,
          proposed: {
            body: parsed.data.proposedBody,
            baselineVersion: baseline.version,
          },
        },
      });

      return reply.code(200).send({
        diff,
        token,
        expiresAt,
        baselineVersion: baseline.version,
        currentSource: existing === null ? "baseline" : "override",
      });
    },
  );
}

/* ----------------------- POST apply ------------------------------- */

function registerApplyOverride(args: ScopedRegisterArgs): void {
  args.app.post(
    `/api/admin/${args.scope}/:id/prompts/:name/:locale/apply`,
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const params = req.params as {
        id: string;
        name: string;
        locale: string;
      };
      if (!z.string().uuid().safeParse(params.id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const name = parsePromptName(params.name);
      if (name === null) {
        return reply.code(400).send({ error: "unknown_prompt_name" });
      }
      const locale = parsePersistedLocale(params.locale);
      if (locale === null) {
        return reply.code(400).send({ error: "unknown_locale" });
      }
      const parsed = applySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const resolved = await resolveDomainId(args.db, args.scope, params.id);
      if (!resolved.ok) {
        return reply.code(resolved.status).send({ error: resolved.reason });
      }

      const baseline = loadPrompt({ name, locale });

      // Baseline-drift check BEFORE token verify so the operator
      // gets a distinct 422 `baseline_version_drifted` rather
      // than the generic `payload_mismatch`. The token's hash
      // covers baselineVersion too, so a drift would surface as
      // payload_mismatch downstream — but we want to name the
      // exact cause so the UI can render "the shipped prompt
      // was updated; click to re-fork from the new baseline"
      // instead of a blanket "re-preview" prompt.
      if (parsed.data.baselineVersion !== baseline.version) {
        return reply.code(422).send({
          error: "baseline_version_drifted",
          previewBaselineVersion: parsed.data.baselineVersion,
          currentBaselineVersion: baseline.version,
        });
      }

      const tokenIdentity = `${args.scope}:${params.id}:${name}:${locale}`;
      const verifyResult = verifySovereigntyDiffToken({
        key: args.sessionHmacKey,
        token: parsed.data.token,
        currentPayload: {
          domainId: tokenIdentity,
          proposed: {
            body: parsed.data.proposedBody,
            baselineVersion: baseline.version,
          },
        },
      });
      if (!verifyResult.ok) {
        // payload_mismatch here means the operator edited the
        // body between preview and apply (baseline-drift was
        // already caught above). The UI reads the `reason` and
        // tells the operator to re-preview.
        const code =
          verifyResult.reason === "signature_mismatch" ||
          verifyResult.reason === "malformed"
            ? 403
            : 422;
        return reply.code(code).send({
          error: "sovereignty_token_invalid",
          reason: verifyResult.reason,
        });
      }

      // Audit row BEFORE the UPSERT — same invariant as
      // `domain.llm_policy.apply`. `payload_hash` references
      // the exact body bytes; the body itself never enters the
      // audit table.
      const action: AuditAction = "prompt_override.apply";
      const payloadHash = computePayloadHash({
        domainId: tokenIdentity,
        proposed: {
          body: parsed.data.proposedBody,
          baselineVersion: baseline.version,
        },
      });
      await writeAuditLog(args.db, {
        action,
        userId: ctx.userId,
        metadata: {
          scope: args.scope,
          scope_id: params.id,
          name,
          locale,
          baseline_version: baseline.version,
          payload_hash: payloadHash,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      // UPSERT (one row per (domain, instance, name, locale)).
      // Bump overrides_version monotonically by counting prior
      // applies — clean enough for v0.1; a content-hash-based
      // version is a v0.2 nicety once the UI shows it.
      const instanceIdParam =
        args.scope === "domains" ? null : params.id;
      const nextOverridesVersion = await computeNextOverridesVersion(
        args.db,
        args.scope,
        resolved.domainId,
        instanceIdParam,
        name,
        locale,
      );
      const proposedBody = parsed.data.proposedBody;
      const upserted = (await args.db.execute(
        instanceIdParam === null
          ? sql`
              INSERT INTO prompt_overrides
                (domain_id, instance_id, prompt_name, locale, body,
                 overrides_version, baseline_version, updated_by_user_id)
              VALUES
                (${resolved.domainId}::uuid, NULL, ${name}, ${locale},
                 ${proposedBody}, ${nextOverridesVersion},
                 ${baseline.version}, ${ctx.userId}::uuid)
              ON CONFLICT (domain_id, instance_id, prompt_name, locale)
              DO UPDATE SET
                body = EXCLUDED.body,
                overrides_version = EXCLUDED.overrides_version,
                baseline_version = EXCLUDED.baseline_version,
                updated_by_user_id = EXCLUDED.updated_by_user_id,
                updated_at = NOW()
              RETURNING id::text AS id, overrides_version
            `
          : sql`
              INSERT INTO prompt_overrides
                (domain_id, instance_id, prompt_name, locale, body,
                 overrides_version, baseline_version, updated_by_user_id)
              VALUES
                (${resolved.domainId}::uuid, ${instanceIdParam}::uuid, ${name},
                 ${locale}, ${proposedBody}, ${nextOverridesVersion},
                 ${baseline.version}, ${ctx.userId}::uuid)
              ON CONFLICT (domain_id, instance_id, prompt_name, locale)
              DO UPDATE SET
                body = EXCLUDED.body,
                overrides_version = EXCLUDED.overrides_version,
                baseline_version = EXCLUDED.baseline_version,
                updated_by_user_id = EXCLUDED.updated_by_user_id,
                updated_at = NOW()
              RETURNING id::text AS id, overrides_version
            `,
      )) as unknown as {
        rows: Array<{ id: string; overrides_version: string }>;
      };
      const row = upserted.rows[0];
      if (row === undefined) {
        return reply.code(500).send({ error: "upsert_returned_no_row" });
      }

      return reply.code(200).send({
        ok: true,
        id: row.id,
        overridesVersion: row.overrides_version,
        baselineVersion: baseline.version,
      });
    },
  );
}

/** Monotonic semver-shaped `overrides_version`. v0.1 is patch-
 *  bump only — the version is an operator-facing apply counter,
 *  not a content-semantic version. If no prior row exists we
 *  start at `1.0.0`. Bumping major/minor on baseline drift is a
 *  v0.2 candidate. */
async function computeNextOverridesVersion(
  db: Db,
  scope: Scope,
  domainId: string,
  instanceId: string | null,
  name: PromptName,
  locale: "en" | "pl",
): Promise<string> {
  const r = (await db.execute(
    instanceId === null
      ? sql`
          SELECT overrides_version FROM prompt_overrides
          WHERE domain_id = ${domainId}::uuid
            AND instance_id IS NULL
            AND prompt_name = ${name}
            AND locale = ${locale}
          LIMIT 1
        `
      : sql`
          SELECT overrides_version FROM prompt_overrides
          WHERE domain_id = ${domainId}::uuid
            AND instance_id = ${instanceId}::uuid
            AND prompt_name = ${name}
            AND locale = ${locale}
          LIMIT 1
        `,
  )) as unknown as { rows: Array<{ overrides_version: string }> };
  // Suppress unused-param warning — `scope` is part of the
  // call-site identity but not used in the query (the SQL
  // already distinguishes via instance_id NULL vs not).
  void scope;
  const existing = r.rows[0]?.overrides_version ?? null;
  if (existing === null) return "1.0.0";
  const m = existing.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (m === null) return "1.0.0";
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return `${major}.${minor}.${patch + 1}`;
}

/* ----------------------- DELETE ----------------------------------- */

function registerDeleteOverride(args: ScopedRegisterArgs): void {
  args.app.delete(
    `/api/admin/${args.scope}/:id/prompts/:name/:locale`,
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const params = req.params as {
        id: string;
        name: string;
        locale: string;
      };
      if (!z.string().uuid().safeParse(params.id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const name = parsePromptName(params.name);
      if (name === null) {
        return reply.code(400).send({ error: "unknown_prompt_name" });
      }
      const locale = parsePersistedLocale(params.locale);
      if (locale === null) {
        return reply.code(400).send({ error: "unknown_locale" });
      }
      const resolved = await resolveDomainId(args.db, args.scope, params.id);
      if (!resolved.ok) {
        return reply.code(resolved.status).send({ error: resolved.reason });
      }

      // Read the existing row FIRST so the audit metadata can
      // capture overrides_version + baseline_version + a body
      // hash before the row goes away. Without this the audit
      // trail would only show "the operator deleted SOMETHING"
      // — we want "the operator deleted version 1.0.3 forked
      // from baseline 1.2.0 with body-hash <h>" so a future
      // forensic walk can correlate the delete to the prior
      // apply audit row.
      const instanceIdParam =
        args.scope === "domains" ? null : params.id;
      const existing = await fetchOverrideRow(
        args.db,
        args.scope,
        params.id,
        resolved.domainId,
        name,
        locale,
      );

      const action: AuditAction = "prompt_override.delete";
      await writeAuditLog(args.db, {
        action,
        userId: ctx.userId,
        metadata: {
          scope: args.scope,
          scope_id: params.id,
          name,
          locale,
          ...(existing !== null
            ? {
                overrides_version: existing.overrides_version,
                baseline_version: existing.baseline_version,
                payload_hash: computePayloadHash({
                  domainId: `${args.scope}:${params.id}:${name}:${locale}`,
                  proposed: {
                    body: existing.body,
                    baselineVersion: existing.baseline_version,
                  },
                }),
              }
            : {}),
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      const deleted = (await args.db.execute(
        instanceIdParam === null
          ? sql`
              DELETE FROM prompt_overrides
              WHERE domain_id = ${resolved.domainId}::uuid
                AND instance_id IS NULL
                AND prompt_name = ${name}
                AND locale = ${locale}
              RETURNING id::text AS id
            `
          : sql`
              DELETE FROM prompt_overrides
              WHERE domain_id = ${resolved.domainId}::uuid
                AND instance_id = ${instanceIdParam}::uuid
                AND prompt_name = ${name}
                AND locale = ${locale}
              RETURNING id::text AS id
            `,
      )) as unknown as { rows: Array<{ id: string }> };

      // 200 even on no-op: idempotent DELETE is operator-
      // friendly (operator clicked "revert" twice, no harm).
      return reply.code(200).send({
        ok: true,
        deleted: deleted.rows.length,
      });
    },
  );
}
