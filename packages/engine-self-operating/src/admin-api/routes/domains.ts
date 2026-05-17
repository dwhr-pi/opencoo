/**
 * Review Dashboard — domains routes (PR 29 read-only listing +
 * phase-a appendix #2 create handler + phase-a appendix #10 PR-R1
 * edit / soft-delete / hard-delete handlers).
 *
 * `GET /api/admin/domains` — list rows for the Domains tab and
 *   the LLM Policy editor's per-domain picker. Default filters
 *   `disabled_at IS NULL`; `?include_disabled=1` returns
 *   retired rows too. The row shape exposes `disabledAt` so the
 *   UI can render the "Disabled" badge.
 * `POST /api/admin/domains` — create a new domain. Closes
 *   PRD §5 #1 ("default domain without manual DB edits").
 *   Inserts the domains row inside a DB transaction; calls
 *   `provisionDomainRepo` to seed the Gitea repo. On
 *   provisioning failure the transaction rolls back — the
 *   operator never sees a half-created domain (no DB row + no
 *   audit row).
 * `PATCH /api/admin/domains/:id` — edit `display_name`,
 *   `locale`, or `is_aggregator`. `slug` and `class` are NOT
 *   mutable (slug rename = re-create; class is structural).
 *   Aggregator uniqueness is pre-checked + audit row lists the
 *   changed field NAMES (never values, since `display_name` is
 *   operator-set free-form). `changedFields` lists REAL diffs
 *   computed against the current row, not body-key presence —
 *   a PATCH that resends current values returns 200 + noOp:true
 *   and writes no audit row.
 * `DELETE /api/admin/domains/:id?hard=1` — soft-delete by
 *   default (sets `disabled_at = now()`); hard-delete with
 *   `?hard=1`. Hard-delete is refused with 409 `fk_restricted`
 *   when ANY ON DELETE RESTRICT FK references the row
 *   (`sources_bindings`, `redaction_events`, `catalog_candidate`,
 *   `miner_suppressions`); the response payload includes a
 *   `blockers` map naming each table's count so the operator
 *   knows where to migrate from. `binding_count` is preserved
 *   alongside `blockers` for backward compat with existing
 *   consumers. Re-enabling a soft-deleted domain is NOT in v0.1
 *   — soft-delete is a one-way valve in this release; the
 *   operator creates a fresh domain to recover.
 */
import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { safeErrorMessage } from "@opencoo/shared/scrub";

import { WORLDVIEW_COMPILE_JOB_NAME } from "../../pipelines/worldview/trigger.js";
import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";
import { extractOperatorPat } from "../pat.js";
import {
  isPgForeignKeyViolation,
  isPgUniqueViolation,
} from "../pg-error.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Slug regex pinned to the Postgres `domains_slug_format`
 *  CHECK constraint (`^[a-z][a-z0-9-]{1,62}$`). Validating in
 *  the Zod parser surfaces a 422 before the DB INSERT — better
 *  diagnostics than a Postgres constraint-violation surface. */
const SLUG_REGEX = /^[a-z][a-z0-9-]{1,62}$/;

const DOMAIN_CLASSES = ["knowledge", "catalog-workflows", "catalog-skills"] as const;

/** PR-W3 (phase-a appendix #15) — governance-cadence enum literals.
 *  Pinned in sync with `packages/shared/src/db/schema/enums.ts` —
 *  the Zod parser surfaces a 422 on unknown values before the SQL
 *  ENUM cast would otherwise produce a generic PG error. */
const GOVERNANCE_CADENCES = [
  "continuous",
  "nightly",
  "weekly",
  "quarterly",
  "adhoc",
] as const;

const createDomainSchema = z
  .object({
    slug: z.string().regex(SLUG_REGEX),
    class: z.enum(DOMAIN_CLASSES),
    display_name: z.string().min(1).max(120),
    default_locale: z.enum(["en", "pl", "auto"]),
  })
  .strict();

/** PR-R1 — `PATCH /api/admin/domains/:id` body. Partial update of
 *  `display_name`, `locale`, `is_aggregator`. `.strict()` rejects
 *  any other key (specifically `slug` + `class`) so a body like
 *  `{display_name: "x", slug: "y"}` cannot smuggle a slug change
 *  through the audit row. Slug rename = re-create the domain
 *  (downstream Gitea repo path is keyed off the slug); class is
 *  structural.
 *
 *  PR-W3 (phase-a appendix #15) — extended with five operational
 *  config fields:
 *    - `retention_days` (1–365, nullable) — clears with `null`.
 *    - `governance_cadence` (enum) — NOT NULL on the column; the
 *      Zod enum mirrors `governance_cadence` from `enums.ts`.
 *    - `review_role` (1–64 chars, nullable) — operator-facing label
 *      for the role gating review. Free-form; NEVER recorded as a
 *      VALUE in the audit metadata (changedFields lists names only).
 *    - `worldview_enabled` (boolean) — at-rest gate. The trigger
 *      pipeline already filters `WHERE worldview_enabled = true`
 *      (see `composition/worldview-bundle.ts`), so flipping to
 *      `false` stops future enqueues. In-flight queue jobs are NOT
 *      cancelled by this PR (see TODO in the handler) — operator
 *      visibility is the lever for v0.1; programmatic cancel is a
 *      v0.2 enhancement once BullMQ surfaces a typed cancel API
 *      that doesn't race the worker's domain re-read.
 *    - `llm_budget_monthly_cap_usd` (≥0, ≤100_000, nullable) —
 *      numeric(10,2). Returned to the client as a string to preserve
 *      precision (cost-summary.ts already does this). */
const updateDomainSchema = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    locale: z.enum(["en", "pl", "auto"]).optional(),
    is_aggregator: z.boolean().optional(),
    retention_days: z.number().int().min(1).max(365).nullable().optional(),
    governance_cadence: z.enum(GOVERNANCE_CADENCES).optional(),
    review_role: z.string().min(1).max(64).nullable().optional(),
    worldview_enabled: z.boolean().optional(),
    llm_budget_monthly_cap_usd: z
      .number()
      .min(0)
      .max(100_000)
      .nullable()
      .optional(),
  })
  .strict();

/** Provisioning callable injected by the composition root.
 *  Carries the operator's PAT so Gitea writes happen as the
 *  caller (not a separate admin token). The PAT is request-
 *  lifetime ONLY — never persisted, never logged. */
export interface ProvisionDomainRepoFn {
  (args: {
    readonly slug: string;
    readonly domainClass: (typeof DOMAIN_CLASSES)[number];
    readonly defaultLocale: "en" | "pl" | "auto";
    readonly org: string;
    readonly pat: string;
  }): Promise<{ readonly repoUrl: string }>;
}

/** Phase-a appendix #12 PR-Z8 (G10) — `/refresh-all` ping callable.
 *  Invoked AFTER the domain row is committed and the Gitea repo is
 *  provisioned, with the COMPLETE set of active (not-disabled)
 *  domains the engine knows about. Implementation lives in
 *  `composition/wiki-mcp-refresh.ts`. The callable swallows every
 *  failure mode (network, 401, 5xx) so a misconfigured or
 *  half-deployed MCP server cannot block legitimate domain
 *  creation — the route returns 201 regardless.
 *
 *  Signature carries a `repos` snapshot the route builds from the
 *  `domains` table; the helper does not re-query the DB. */
export interface PingWikiMcpRefreshFn {
  (repos: ReadonlyArray<{
    readonly slug: string;
    readonly owner: string;
    readonly name?: string;
    readonly default?: boolean;
    readonly aggregator?: boolean;
  }>): Promise<void>;
}

/** PR-W1 (phase-a appendix #13) — narrow BullMQ Queue surface for
 *  the recompile-worldview endpoint. Pinned to `add` to keep the
 *  type independent of the bullmq import in route consumers (tests
 *  + admin-api index wiring). */
export interface WorldviewCompileQueueLike {
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
}

export interface RegisterDomainsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** Phase-a appendix #2 — provisioning helper for the
   *  POST handler. The composition root supplies the real
   *  helper; tests inject a stub. */
  readonly provisionDomainRepo?: ProvisionDomainRepoFn;
  /** Gitea organisation that owns provisioned repos.
   *  Sourced from `GITEA_PROVISION_ORG` (default 'opencoo'). */
  readonly provisionOrg?: string;
  /** Phase-a appendix #12 PR-Z8 (G10) — `/refresh-all` ping callable.
   *  Optional: when undefined, the domain-create handler skips the
   *  refresh and writes a debug log. Production composition wires
   *  the real helper when `GITEA_WIKI_MCP_URL` + `MCP_BEARER_TOKEN`
   *  are both set. */
  readonly pingWikiMcpRefresh?: PingWikiMcpRefreshFn;
  /** PR-W1 (phase-a appendix #13) — BullMQ producer-side handle for
   *  the worldview-compile queue. Optional: when undefined the
   *  recompile-worldview endpoint returns 503 (composition incomplete),
   *  matching the rest of the admin-API's boot-tolerance pattern. */
  readonly worldviewQueue?: WorldviewCompileQueueLike;
}

export function registerDomainsRoutes(args: RegisterDomainsRoutesArgs): void {
  args.app.get("/api/admin/domains", async (req, reply) => {
    // Default listing hides soft-deleted domains; ?include_disabled=1
    // returns every row including retired ones (for the UI's "Show
    // disabled" toggle). The composite index added by migration 0011
    // (`disabled_at`, `slug`) keeps both paths fast.
    const includeDisabled =
      (req.query as Record<string, string> | undefined)?.["include_disabled"] ===
      "1";
    const filterClause = includeDisabled
      ? sql``
      : sql`WHERE disabled_at IS NULL`;
    // Correlated sub-select for `binding_count` lets the row drill-
    // down disable the Hard-delete button without a second round-
    // trip — the listing already knows whether bindings would block
    // a hard-delete.
    //
    // The SELECT is wrapped in try/catch so a connectivity blip
    // can't leak `err.message` through Fastify's default error
    // handler (which echoes it verbatim into the JSON body). Mirrors
    // the DELETE handler's shape on `internal_error`.
    let result: {
      rows: Array<{
        id: string;
        slug: string;
        name: string;
        class: string;
        locale: string;
        llm_policy: Record<string, unknown>;
        is_aggregator: boolean;
        disabled_at: Date | string | null;
        binding_count: number;
        retention_days: number | null;
        governance_cadence: string;
        review_role: string | null;
        worldview_enabled: boolean;
        llm_budget_monthly_cap_usd: string | null;
      }>;
    };
    try {
      result = (await args.db.execute(sql`
        SELECT d.id::text AS id,
               d.slug,
               d.name,
               d.class::text AS class,
               d.locale,
               d.llm_policy,
               d.is_aggregator,
               d.disabled_at,
               d.retention_days,
               d.governance_cadence::text AS governance_cadence,
               d.review_role,
               d.worldview_enabled,
               d.llm_budget_monthly_cap_usd::text AS llm_budget_monthly_cap_usd,
               (
                 SELECT COUNT(*)::int
                 FROM sources_bindings sb
                 WHERE sb.domain_id = d.id
               ) AS binding_count
        FROM domains d
        ${filterClause}
        ORDER BY d.slug ASC
      `)) as unknown as typeof result;
    } catch (err) {
      req.log?.warn({
        msg: "domain_list.internal_error",
        err: err instanceof Error ? err.name : "unknown",
      });
      return reply.code(500).send({ error: "internal_error" });
    }
    return {
      rows: result.rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        class: r.class,
        locale: r.locale,
        llmPolicy: r.llm_policy,
        isAggregator: r.is_aggregator,
        disabledAt: toIsoOrNull(r.disabled_at),
        bindingCount: r.binding_count,
        retentionDays: r.retention_days,
        governanceCadence: r.governance_cadence,
        reviewRole: r.review_role,
        worldviewEnabled: r.worldview_enabled,
        llmBudgetMonthlyCapUsd: r.llm_budget_monthly_cap_usd,
      })),
    };
  });

  // Phase-a appendix #2 — domain create.
  args.app.post(
    "/api/admin/domains",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const parsed = createDomainSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const { slug, class: domainClass, display_name, default_locale } = parsed.data;

      // Slug-collision guard BEFORE provisioning so we never
      // bother Gitea with a request that's destined to fail.
      const existing = (await args.db.execute(sql`
        SELECT 1 FROM domains WHERE slug = ${slug} LIMIT 1
      `)) as unknown as { rows: Array<unknown> };
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: "slug_taken", slug });
      }

      // Operator PAT — required for provisioning; the route
      // does not persist or log it.
      const operatorPat = extractOperatorPat(req);
      if (operatorPat === undefined) {
        // Should not reach here when verifyAdmin ran (it
        // already verified Bearer presence). Safety net.
        return reply.code(401).send({
          error: "unauthorized",
          reason: "missing_authorization_header",
        });
      }

      const provision = args.provisionDomainRepo;
      if (provision === undefined) {
        return reply.code(500).send({
          error: "provisioning_unavailable",
          reason:
            "Composition did not register a provisionDomainRepo handler",
        });
      }
      const provisionOrg = args.provisionOrg ?? "opencoo";

      // Transaction wraps the INSERT; provisioning happens
      // inside so a Gitea failure rolls back the partial row.
      let result: { readonly id: string; readonly repoUrl: string };
      try {
        result = await args.db.transaction(async (tx) => {
          const inserted = (await tx.execute(sql`
            INSERT INTO domains (slug, name, class, locale)
            VALUES (${slug}, ${display_name}, ${sql.raw(`'${domainClass}'`)}::domain_class, ${default_locale})
            RETURNING id::text AS id
          `)) as unknown as { rows: Array<{ id: string }> };
          const id = inserted.rows[0]?.id;
          if (id === undefined) {
            throw new Error("INSERT into domains returned no row");
          }

          // Provision Gitea repo as the caller. Failures throw
          // and roll back the INSERT.
          const provisionResult = await provision({
            slug,
            domainClass,
            defaultLocale: default_locale,
            org: provisionOrg,
            pat: operatorPat,
          });

          return { id, repoUrl: provisionResult.repoUrl };
        });
      } catch (err) {
        // The pre-check above narrows the slug-collision window but
        // doesn't close it: two concurrent POSTs can both pass the
        // SELECT and race on the UNIQUE-constrained INSERT. Postgres
        // raises SQLSTATE 23505 (unique_violation); surface that as
        // 409 slug_taken so the operator sees the same shape as the
        // pre-check path, not 502 provisioning_failed.
        if (isPgUniqueViolation(err)) {
          return reply.code(409).send({ error: "slug_taken", slug });
        }
        // Genuine provisioning failure (Gitea unreachable, seed-file
        // commit failed, etc.). PAT and upstream-message scrubbed —
        // engine logger captured the detail (gitea-provisioning helper
        // scrubs the PAT from its own thrown errors).
        req.log?.warn({
          msg: "domain_create.provisioning_failed",
          slug,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(502).send({
          error: "provisioning_failed",
          slug,
        });
      }

      // Audit row AFTER successful tx commit. Metadata never
      // includes PAT bytes — only slug, class, repo url, caller.
      await writeAuditLog(args.db, {
        action: "domain.create",
        userId: ctx.userId,
        metadata: {
          slug,
          class: domainClass,
          repo_url: result.repoUrl,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      // Phase-a appendix #12 PR-Z8 (G10) — fire-and-forget
      // /refresh-all ping to gitea-wiki-mcp-server so its in-memory
      // REPOS list picks up the newly-provisioned repo without any
      // operator hand-edit of `REPOS` env JSON. Read the full
      // active-domains set from the DB (the MCP server's
      // /refresh-all replaces wholesale, not appends, so partial
      // payloads would drop existing repos). Awaiting the SELECT
      // is cheap (single-table read on the slug + class + flags);
      // the actual HTTP dispatch is forget-on-throw inside
      // pingWikiMcpRefresh.
      const refresh = args.pingWikiMcpRefresh;
      if (refresh !== undefined) {
        const orgForBody = provisionOrg;
        try {
          const activeRows = (await args.db.execute(sql`
            SELECT slug, is_aggregator
            FROM domains
            WHERE disabled_at IS NULL
            ORDER BY slug ASC
          `)) as unknown as {
            rows: Array<{ slug: string; is_aggregator: boolean }>;
          };
          const repos = activeRows.rows.map((r) => ({
            slug: r.slug,
            owner: orgForBody,
            name: r.slug,
            // The MCP server picks `default: true` from this set
            // OR auto-promotes the first when none is flagged.
            // opencoo never elevates a knowledge domain to the
            // MCP server's "default" slot; the auto-promote path
            // covers the one-domain case. Aggregator status is
            // load-bearing for `worldview://company` resolution.
            aggregator: r.is_aggregator === true,
          }));
          // Fire-and-forget — pin the rejection-safe promise so
          // unhandled-rejection guards stay quiet, but do NOT
          // await it (slow MCP server must not stretch the 201).
          void refresh(repos).catch(() => undefined);
        } catch (err) {
          // SELECT failure shouldn't happen on a fresh commit, but
          // if it does we eat it — domain creation already
          // succeeded; the ping is informational.
          req.log?.warn({
            msg: "domain_create.refresh_select_failed",
            err: err instanceof Error ? err.name : "unknown",
          });
        }
      }

      return reply.code(201).send({
        id: result.id,
        slug,
        repoUrl: result.repoUrl,
      });
    },
  );

  // PR-R1 — domain edit. Partial update of `display_name`, `locale`,
  // `is_aggregator`. `slug` and `class` are NOT mutable (the Zod
  // `.strict()` on `updateDomainSchema` rejects either with 422).
  // Aggregator uniqueness is pre-checked against ACTIVE rows
  // (`disabled_at IS NULL`); a disabled aggregator does NOT block a
  // fresh one. The DB-level partial UNIQUE INDEX
  // `domains_is_aggregator_singleton` (migration 0005) is the
  // ultimate guard; the pre-check produces the typed 409 instead of
  // a generic 23505.
  args.app.patch(
    "/api/admin/domains/:id",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const parsed = updateDomainSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const {
        display_name,
        locale,
        is_aggregator,
        retention_days,
        governance_cadence,
        review_role,
        worldview_enabled,
        llm_budget_monthly_cap_usd,
      } = parsed.data;
      // PR-W3 — `Object.hasOwn` (not `!== undefined`) so a body that
      // EXPLICITLY sends `null` (clear-the-column) still counts as
      // "present in body". The nullable fields rely on this to
      // distinguish "field not in body" (skip) from "field is null"
      // (clear).
      const body = parsed.data as Record<string, unknown>;
      const bodyKeys: string[] = [];
      if (Object.hasOwn(body, "display_name")) bodyKeys.push("display_name");
      if (Object.hasOwn(body, "locale")) bodyKeys.push("locale");
      if (Object.hasOwn(body, "is_aggregator")) bodyKeys.push("is_aggregator");
      if (Object.hasOwn(body, "retention_days")) bodyKeys.push("retention_days");
      if (Object.hasOwn(body, "governance_cadence")) {
        bodyKeys.push("governance_cadence");
      }
      if (Object.hasOwn(body, "review_role")) bodyKeys.push("review_role");
      if (Object.hasOwn(body, "worldview_enabled")) {
        bodyKeys.push("worldview_enabled");
      }
      if (Object.hasOwn(body, "llm_budget_monthly_cap_usd")) {
        bodyKeys.push("llm_budget_monthly_cap_usd");
      }
      if (bodyKeys.length === 0) {
        // Empty body — nothing to do. Surface as 422 so the operator
        // notices, rather than writing a no-op audit row.
        return reply.code(422).send({
          error: "validation_failed",
          issues: [
            {
              message:
                "at least one editable field is required (display_name, locale, is_aggregator, retention_days, governance_cadence, review_role, worldview_enabled, llm_budget_monthly_cap_usd)",
            },
          ],
        });
      }

      // Aggregator-uniqueness pre-check (only when promoting). A
      // disabled aggregator does not count: an operator can disable
      // the old aggregator and immediately promote a different
      // domain. Using LIMIT 1 keeps this O(1) on the partial index.
      //
      // Wrapped in try/catch alongside the UPDATE below: the 409
      // path returns BEFORE the catch fires (no PG-level
      // "aggregator already set" error code exists — the SELECT
      // either errors on connectivity or returns rows), so the
      // catch only handles genuine connectivity failures and
      // emits the same `internal_error` shape DELETE uses.
      //
      // The aggregator-conflict check runs BEFORE the no-op shortcut:
      // a hand-crafted PATCH that resends `is_aggregator: true` while
      // the row already holds the flag AND another active domain ALSO
      // holds it (stale state) must surface 409, not silently pass as
      // a no-op. Uniqueness validates intent regardless of diff.
      if (is_aggregator === true) {
        let conflict: { rows: Array<unknown> };
        try {
          conflict = (await args.db.execute(sql`
            SELECT 1 FROM domains
            WHERE is_aggregator = true
              AND id <> ${id}::uuid
              AND disabled_at IS NULL
            LIMIT 1
          `)) as unknown as typeof conflict;
        } catch (err) {
          req.log?.warn({
            msg: "domain_update.internal_error",
            domain_id: id,
            err: err instanceof Error ? err.name : "unknown",
          });
          return reply.code(500).send({ error: "internal_error" });
        }
        if (conflict.rows.length > 0) {
          return reply.code(409).send({ error: "aggregator_already_set" });
        }
      }

      // Compute REAL diffs against the current row. Without this, a
      // PATCH that resends current values would write a misleading
      // audit row claiming "display_name changed" — `changedFields`
      // must list values that actually moved. If nothing moved, the
      // route returns 200 + noOp:true and writes no audit row.
      //
      // PR-W3 (phase-a appendix #15) — extended with the five new
      // editable columns. `llm_budget_monthly_cap_usd` is cast to text
      // so the numeric round-trip survives JSON encoding; the
      // comparison below stringifies the incoming number to the same
      // canonical 2-decimal form Postgres emits.
      let currentRow: {
        rows: Array<{
          id: string;
          slug: string;
          name: string;
          class: string;
          locale: string;
          llm_policy: Record<string, unknown>;
          is_aggregator: boolean;
          retention_days: number | null;
          governance_cadence: string;
          review_role: string | null;
          worldview_enabled: boolean;
          llm_budget_monthly_cap_usd: string | null;
        }>;
      };
      try {
        currentRow = (await args.db.execute(sql`
          SELECT id::text AS id,
                 slug,
                 name,
                 class::text AS class,
                 locale,
                 llm_policy,
                 is_aggregator,
                 retention_days,
                 governance_cadence::text AS governance_cadence,
                 review_role,
                 worldview_enabled,
                 llm_budget_monthly_cap_usd::text AS llm_budget_monthly_cap_usd
          FROM domains
          WHERE id = ${id}::uuid
          LIMIT 1
        `)) as unknown as typeof currentRow;
      } catch (err) {
        req.log?.warn({
          msg: "domain_update.internal_error",
          domain_id: id,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(500).send({ error: "internal_error" });
      }
      const current = currentRow.rows[0];
      if (current === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }

      const changedFields: string[] = [];
      if (display_name !== undefined && display_name !== current.name) {
        changedFields.push("display_name");
      }
      if (locale !== undefined && locale !== current.locale) {
        changedFields.push("locale");
      }
      if (
        is_aggregator !== undefined &&
        is_aggregator !== current.is_aggregator
      ) {
        changedFields.push("is_aggregator");
      }
      if (
        Object.hasOwn(body, "retention_days") &&
        (retention_days ?? null) !== current.retention_days
      ) {
        changedFields.push("retention_days");
      }
      if (
        governance_cadence !== undefined &&
        governance_cadence !== current.governance_cadence
      ) {
        changedFields.push("governance_cadence");
      }
      if (
        Object.hasOwn(body, "review_role") &&
        (review_role ?? null) !== current.review_role
      ) {
        changedFields.push("review_role");
      }
      if (
        worldview_enabled !== undefined &&
        worldview_enabled !== current.worldview_enabled
      ) {
        changedFields.push("worldview_enabled");
      }
      if (Object.hasOwn(body, "llm_budget_monthly_cap_usd")) {
        // Postgres returns numeric(10,2) as a string already in the
        // canonical "X.YY" form. The incoming number is normalised to
        // the same shape so a PATCH that resends 75 doesn't compare
        // against "75.00" and falsely register a change.
        const currentCap = current.llm_budget_monthly_cap_usd;
        const proposedCap =
          llm_budget_monthly_cap_usd === null ||
          llm_budget_monthly_cap_usd === undefined
            ? null
            : Number(llm_budget_monthly_cap_usd).toFixed(2);
        if (proposedCap !== currentCap) {
          changedFields.push("llm_budget_monthly_cap_usd");
        }
      }

      if (changedFields.length === 0) {
        // No-op: the operator (or a hand-crafted client) submitted a
        // PATCH whose values match the current row. Return 200 with
        // noOp:true so the client can distinguish "nothing changed"
        // from "saved a real edit"; no UPDATE, no audit row.
        return reply.code(200).send({
          id: current.id,
          slug: current.slug,
          name: current.name,
          class: current.class,
          locale: current.locale,
          llmPolicy: current.llm_policy,
          isAggregator: current.is_aggregator,
          retentionDays: current.retention_days,
          governanceCadence: current.governance_cadence,
          reviewRole: current.review_role,
          worldviewEnabled: current.worldview_enabled,
          llmBudgetMonthlyCapUsd: current.llm_budget_monthly_cap_usd,
          noOp: true,
        });
      }

      // UPDATE: only the columns the operator submitted are touched.
      // For the original three fields the COALESCE shape still works
      // (none are nullable in a way that the operator can clear). The
      // PR-W3 additions include nullable columns: `retention_days`,
      // `review_role`, `llm_budget_monthly_cap_usd` can be CLEARED by
      // explicit `null`, so they use a `CASE WHEN <flag> THEN <value>
      // ELSE <col> END` shape driven by an "in body" boolean. The
      // composition keeps the SQL declarative (no string-concat) and
      // makes the clear path explicit at the call site.
      //
      // Wrapped in try/catch (mirrors DELETE) so a connectivity
      // blip can't leak `err.message` through Fastify's default
      // error handler.
      const setRetention = Object.hasOwn(body, "retention_days");
      const setReviewRole = Object.hasOwn(body, "review_role");
      const setCap = Object.hasOwn(body, "llm_budget_monthly_cap_usd");
      const capForDb =
        llm_budget_monthly_cap_usd === null ||
        llm_budget_monthly_cap_usd === undefined
          ? null
          : Number(llm_budget_monthly_cap_usd).toFixed(2);
      let updated: {
        rows: Array<{
          id: string;
          slug: string;
          name: string;
          class: string;
          locale: string;
          llm_policy: Record<string, unknown>;
          is_aggregator: boolean;
          retention_days: number | null;
          governance_cadence: string;
          review_role: string | null;
          worldview_enabled: boolean;
          llm_budget_monthly_cap_usd: string | null;
        }>;
      };
      try {
        // Defensive `::boolean` casts on the `CASE WHEN <flag>` predicates:
        // Drizzle binds JS booleans as Postgres `bool` parameters and the
        // CASE WHEN reads them correctly today, but pinning the cast
        // documents intent and protects against a future driver/Postgres
        // upgrade where a bound parameter might land as text.
        updated = (await args.db.execute(sql`
          UPDATE domains
          SET name = COALESCE(${display_name ?? null}, name),
              locale = COALESCE(${locale ?? null}, locale),
              is_aggregator = COALESCE(${is_aggregator ?? null}, is_aggregator),
              retention_days = CASE WHEN ${setRetention}::boolean THEN ${retention_days ?? null}::int ELSE retention_days END,
              governance_cadence = COALESCE(${governance_cadence ?? null}::governance_cadence, governance_cadence),
              review_role = CASE WHEN ${setReviewRole}::boolean THEN ${review_role ?? null}::text ELSE review_role END,
              worldview_enabled = COALESCE(${worldview_enabled ?? null}, worldview_enabled),
              llm_budget_monthly_cap_usd = CASE WHEN ${setCap}::boolean THEN ${capForDb}::numeric ELSE llm_budget_monthly_cap_usd END,
              updated_at = NOW()
          WHERE id = ${id}::uuid
          RETURNING id::text AS id,
                    slug,
                    name,
                    class::text AS class,
                    locale,
                    llm_policy,
                    is_aggregator,
                    retention_days,
                    governance_cadence::text AS governance_cadence,
                    review_role,
                    worldview_enabled,
                    llm_budget_monthly_cap_usd::text AS llm_budget_monthly_cap_usd
        `)) as unknown as typeof updated;
      } catch (err) {
        req.log?.warn({
          msg: "domain_update.internal_error",
          domain_id: id,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(500).send({ error: "internal_error" });
      }
      const row = updated.rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }

      // PR-W3 — when `worldview_enabled` flipped to `false`, the trigger
      // pipeline at `composition/worldview-bundle.ts` already filters
      // `WHERE worldview_enabled = true`, so no NEW recompile jobs will
      // be enqueued for this domain. Jobs already in-flight on the
      // BullMQ queue (or actively running in a worker) will run to
      // completion — they re-read the domain row before writing, so a
      // race-window edit during a compile is observable but bounded.
      // TODO(v0.2): programmatic cancel of in-flight `worldview.compile`
      // jobs. BullMQ's `Queue.remove(jobId)` would close the lane, but
      // the route doesn't have the active jobIds in scope; a typed
      // cancel API would require either a queue scan or a sidecar
      // table. Deferred until customer evidence shows it's load-bearing.

      // Audit row — slug + id + caller + the field NAMES that
      // changed. Field VALUES are NEVER recorded (display_name is
      // operator-set free-form, low-risk, but listing names only
      // matches the source-binding-update audit shape and avoids
      // any log-injection concern).
      await writeAuditLog(args.db, {
        action: "domain.update",
        userId: ctx.userId,
        metadata: {
          id: row.id,
          slug: row.slug,
          changedFields,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({
        id: row.id,
        slug: row.slug,
        name: row.name,
        class: row.class,
        locale: row.locale,
        llmPolicy: row.llm_policy,
        isAggregator: row.is_aggregator,
        retentionDays: row.retention_days,
        governanceCadence: row.governance_cadence,
        reviewRole: row.review_role,
        worldviewEnabled: row.worldview_enabled,
        llmBudgetMonthlyCapUsd: row.llm_budget_monthly_cap_usd,
      });
    },
  );

  // PR-R1 — domain delete. Default = soft (sets `disabled_at`);
  // `?hard=1` = hard. Hard-delete is refused with 409
  // `fk_restricted` when ANY of the four ON DELETE RESTRICT FK
  // tables reference the row (sources_bindings, redaction_events,
  // catalog_candidate, miner_suppressions). The pre-check
  // aggregates per-table counts in a single round-trip; the post-
  // DELETE catch-23503 path stays as defense-in-depth for the
  // race window. The 409 response includes a `blockers` map so
  // the UI can render "N redaction events reference this domain —
  // migrate first" pointing the operator at the right tab.
  // `binding_count` stays in the payload for backward compat with
  // existing UI / test consumers that still gate on it.
  //
  // Re-enabling a soft-deleted domain via PATCH is NOT in v0.1
  // scope (soft-delete is a one-way valve in this release). The
  // operator creates a fresh domain to recover.
  args.app.delete(
    "/api/admin/domains/:id",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const hard =
        (req.query as Record<string, string> | undefined)?.["hard"] === "1";

      // Look up the slug for the audit metadata. Cheap pre-check
      // (no write lock). The TOCTOU between this SELECT and the
      // mutating statement is closed by `RETURNING id` on the
      // UPDATE/DELETE (mirrors PR-Q10b on source-bindings).
      const existing = (await args.db.execute(sql`
        SELECT slug, disabled_at FROM domains WHERE id = ${id}::uuid LIMIT 1
      `)) as unknown as {
        rows: Array<{ slug: string; disabled_at: Date | string | null }>;
      };
      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }
      const slug = existingRow.slug;

      if (!hard) {
        // Soft-delete path. Also clear `is_aggregator` in the same
        // statement: the partial UNIQUE INDEX
        // `domains_is_aggregator_singleton` (migration 0005) does
        // NOT filter on `disabled_at`, so a disabled aggregator
        // would still occupy the singleton slot and block any
        // attempt to promote another domain. Clearing the flag at
        // soft-disable time keeps the operator workflow
        // (Disable old → promote new) unblocked.
        //
        // RETURNING id + the `disabled_at IS NULL` guard
        // distinguishes "concurrent disable raced us" (the row
        // exists but is already disabled) from "row never
        // existed". Both surface 404 to the caller; the audit row
        // is only written on the success branch.
        const disabled = (await args.db.execute(sql`
          UPDATE domains
          SET disabled_at = NOW(),
              is_aggregator = false,
              updated_at = NOW()
          WHERE id = ${id}::uuid
            AND disabled_at IS NULL
          RETURNING id
        `)) as unknown as { rows: Array<{ id: string }> };
        if (disabled.rows.length === 0) {
          // Row exists (existence pre-check passed) but is already
          // disabled — TOCTOU race or operator double-click. Surface
          // 404 (mirrors source-bindings DELETE on already-gone row)
          // so the UI shows the same "no longer present" affordance.
          return reply.code(404).send({ error: "not_found", id });
        }
        await writeAuditLog(args.db, {
          action: "domain.disable",
          userId: ctx.userId,
          metadata: {
            id,
            slug,
            hard: false,
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });
        return reply.code(204).send();
      }

      // Hard-delete path. Aggregate counts across EVERY FK-bearing
      // table that references domains.id with ON DELETE RESTRICT
      // BEFORE attempting DELETE. This:
      //   1. closes the "binding_count = 0 still 409" surprise the
      //      single-table check produced when a redaction_events /
      //      catalog_candidate / miner_suppressions row blocks the
      //      delete (see PR-R1 follow-up Copilot triage),
      //   2. names the actual blocker(s) in the response payload so
      //      the operator knows where to migrate from,
      //   3. keeps the success path clean of catch-block logic.
      // The post-DELETE catch-23503 path stays as defense-in-depth
      // for the (rare) race between this pre-check and the DELETE.
      const blockers = await countDomainBlockers(args.db, id);
      const bindingCount = blockers.sources_bindings;
      const totalBlockers =
        blockers.sources_bindings +
        blockers.redaction_events +
        blockers.catalog_candidate +
        blockers.miner_suppressions;
      if (totalBlockers > 0) {
        await writeAuditLog(args.db, {
          action: "domain.delete",
          userId: ctx.userId,
          metadata: {
            id,
            slug,
            hard: true,
            binding_count: bindingCount,
            blockers,
            caller_username: ctx.username,
            outcome: "fk_restricted",
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });
        req.log?.warn({
          msg: "domain_delete.fk_restricted",
          domain_id: id,
          blockers,
        });
        return reply.code(409).send({
          error: "fk_restricted",
          binding_count: bindingCount,
          blockers,
          message:
            "domain is referenced by other tables; cannot hard-delete",
        });
      }

      try {
        const deleted = (await args.db.execute(sql`
          DELETE FROM domains WHERE id = ${id}::uuid RETURNING id
        `)) as unknown as { rows: Array<{ id: string }> };
        if (deleted.rows.length === 0) {
          // TOCTOU: another operator deleted the row between the
          // pre-check and this statement. No audit row written for
          // a non-existent row.
          return reply.code(404).send({ error: "not_found", id });
        }
      } catch (err) {
        if (isPgForeignKeyViolation(err)) {
          // Race window: a referencing row (in any of the four
          // FK tables) was inserted between our pre-check and the
          // DELETE. Re-aggregate so the response + audit row
          // reflect the post-race state.
          const raceBlockers = await countDomainBlockers(args.db, id);
          await writeAuditLog(args.db, {
            action: "domain.delete",
            userId: ctx.userId,
            metadata: {
              id,
              slug,
              hard: true,
              binding_count: raceBlockers.sources_bindings,
              blockers: raceBlockers,
              caller_username: ctx.username,
              outcome: "fk_restricted",
            },
            sourceIp: req.ip,
            userAgent: req.headers["user-agent"],
          });
          req.log?.warn({
            msg: "domain_delete.fk_restricted",
            domain_id: id,
            blockers: raceBlockers,
          });
          return reply.code(409).send({
            error: "fk_restricted",
            binding_count: raceBlockers.sources_bindings,
            blockers: raceBlockers,
            message:
              "domain is referenced by other tables; cannot hard-delete",
          });
        }
        // Genuine internal failure — connectivity, syntax, etc.
        // Log the error class (not the body, which Postgres may
        // include row identifiers in) and surface a generic 500.
        req.log?.warn({
          msg: "domain_delete.internal_error",
          domain_id: id,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(500).send({ error: "internal_error" });
      }

      await writeAuditLog(args.db, {
        action: "domain.delete",
        userId: ctx.userId,
        metadata: {
          id,
          slug,
          hard: true,
          binding_count: bindingCount,
          blockers,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return reply.code(204).send();
    },
  );

  // PR-W1 (phase-a appendix #13) — on-demand worldview recompile.
  // Closes G1 by giving operators a one-click "rebuild worldview.md
  // now" affordance from the Domains drill-down (matching the PR-Z3
  // Scan-now pattern on the Sources tab). The trailer-driven trigger
  // + 24h safety net cover the auto path; this endpoint is the
  // human-in-the-loop escape hatch.
  //
  // Pattern mirrors `:id/scan-now`: CSRF + admin-team gated,
  // audit-row-before-enqueue, 503 on missing composition, 500 on
  // queue.add throw with the audit row still in place for forensics.
  // The Y1 hotfix lesson is preserved — we hold the Queue REFERENCE
  // and call `queue.add(...)` as a method (BullMQ reads `this.trace`
  // internally; a detached `const add = queue.add` would lose the
  // receiver and throw).
  const SLUG_PARAM_REGEX = /^[a-z][a-z0-9-]{1,62}$/;
  const recompileBodySchema = z
    .object({
      triggerType: z.enum(["manual"]).optional(),
    })
    .strict()
    .optional();

  args.app.post(
    "/api/admin/domains/:slug/recompile-worldview",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const slug = (req.params as { slug: string }).slug;
      if (!SLUG_PARAM_REGEX.test(slug)) {
        return reply.code(400).send({ error: "invalid_slug" });
      }
      const parsed = recompileBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      // Body is OPTIONAL — defaults to manual. Even when the operator
      // POSTs `{ triggerType: 'manual' }` the result is the same; we
      // refuse anything else to keep the audit shape clean.
      const triggerType = "manual" as const;

      // Composition gate — see source-bindings.ts /scan-now for the
      // load-bearing comment on the receiver-binding lesson. We pin
      // the queue reference and call `add(...)` as a method.
      const queue = args.worldviewQueue;
      if (queue === undefined || typeof queue.add !== "function") {
        return reply.code(503).send({
          error: "worldview_queue_unavailable",
          reason:
            "Composition did not register a writable worldview queue — check engine logs for `production_context` failures",
        });
      }

      // Resolve domain id. 404 fires here for an unknown slug; the
      // audit row is NOT written when the domain doesn't exist (no
      // mutation attempted).
      const domainResult = (await args.db.execute(sql`
        SELECT id::text AS id, slug, disabled_at
        FROM domains
        WHERE slug = ${slug}
        LIMIT 1
      `)) as unknown as {
        rows: Array<{
          id: string;
          slug: string;
          disabled_at: Date | string | null;
        }>;
      };
      const domain = domainResult.rows[0];
      if (domain === undefined) {
        return reply.code(404).send({ error: "not_found", slug });
      }
      if (domain.disabled_at !== null) {
        // Disabled domain — no recompile makes sense; the wiki repo
        // is hidden from listings and ingestion has stopped.
        return reply.code(409).send({
          error: "domain_disabled",
          slug,
        });
      }

      // jobId pattern: collision-free under burst clicks (Date.now()
      // alone is ms-precision; the random suffix hardens against a
      // programmatic burst inside the same ms).
      const jobId = `recompile-worldview-${domain.id}-${Date.now()}-${randomBytes(3).toString("hex")}`;

      // Audit BEFORE enqueue (audit-before-side-effect invariant —
      // a partial enqueue still leaves a forensic trail). Metadata
      // captures slug + domain_id + trigger_type + caller_username
      // ONLY. NEVER any operator-supplied freeform text
      // (THREAT-MODEL §3.13).
      await writeAuditLog(args.db, {
        action: "domain.recompile_worldview",
        userId: ctx.userId,
        metadata: {
          domain_id: domain.id,
          slug: domain.slug,
          trigger_type: triggerType,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      try {
        // Use the shared constant so the route, the trigger pipeline,
        // and the worker all agree on the BullMQ job-name surface — a
        // typo here would silently route operator-initiated recompiles
        // to a queue the worker isn't listening on.
        await queue.add(
          WORLDVIEW_COMPILE_JOB_NAME,
          {
            domainId: domain.id,
            domainSlug: domain.slug,
            triggerType,
          },
          {
            jobId,
            removeOnComplete: 100,
            removeOnFail: 1000,
          },
        );
      } catch (err) {
        req.log?.warn({
          msg: "domain_recompile_worldview.enqueue_failed",
          domain_id: domain.id,
          err: safeErrorMessage(err),
        });
        return reply.code(500).send({
          error: "enqueue_failed",
          reason: safeErrorMessage(err),
        });
      }

      return reply.code(202).send({ enqueued: true, jobId });
    },
  );
}

/** Per-FK-table reference counts for `domains.id`. The four tables
 *  hold ON DELETE RESTRICT FKs, so any non-zero count blocks a hard-
 *  delete. Aggregated in a single round-trip via correlated sub-
 *  selects to keep the pre-check cheap. */
interface DomainBlockers {
  readonly sources_bindings: number;
  readonly redaction_events: number;
  readonly catalog_candidate: number;
  readonly miner_suppressions: number;
}

async function countDomainBlockers(
  db: Db,
  id: string,
): Promise<DomainBlockers> {
  const result = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM sources_bindings WHERE domain_id = ${id}::uuid) AS sources_bindings,
      (SELECT COUNT(*)::int FROM redaction_events WHERE domain_id = ${id}::uuid) AS redaction_events,
      (SELECT COUNT(*)::int FROM catalog_candidate WHERE catalog_domain_id = ${id}::uuid) AS catalog_candidate,
      (SELECT COUNT(*)::int FROM miner_suppressions WHERE catalog_domain_id = ${id}::uuid) AS miner_suppressions
  `)) as unknown as {
    rows: Array<{
      sources_bindings: number;
      redaction_events: number;
      catalog_candidate: number;
      miner_suppressions: number;
    }>;
  };
  const row = result.rows[0];
  return {
    sources_bindings: row?.sources_bindings ?? 0,
    redaction_events: row?.redaction_events ?? 0,
    catalog_candidate: row?.catalog_candidate ?? 0,
    miner_suppressions: row?.miner_suppressions ?? 0,
  };
}

/** Coerce a Postgres timestamptz value (Date when node-postgres
 *  parsed it, string when pglite returned it raw) to an ISO 8601
 *  string. Returns `null` for null inputs and for unparseable
 *  values (defense-in-depth — the UI just renders "Disabled" off
 *  truthiness anyway). */
function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
