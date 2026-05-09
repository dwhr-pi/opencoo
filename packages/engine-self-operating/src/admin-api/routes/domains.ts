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
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

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
 *  structural. */
const updateDomainSchema = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    locale: z.enum(["en", "pl", "auto"]).optional(),
    is_aggregator: z.boolean().optional(),
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
      const { display_name, locale, is_aggregator } = parsed.data;
      const bodyKeys: string[] = [];
      if (display_name !== undefined) bodyKeys.push("display_name");
      if (locale !== undefined) bodyKeys.push("locale");
      if (is_aggregator !== undefined) bodyKeys.push("is_aggregator");
      if (bodyKeys.length === 0) {
        // Empty body — nothing to do. Surface as 422 so the operator
        // notices, rather than writing a no-op audit row.
        return reply.code(422).send({
          error: "validation_failed",
          issues: [{ message: "at least one of display_name / locale / is_aggregator is required" }],
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
      let currentRow: {
        rows: Array<{
          id: string;
          slug: string;
          name: string;
          class: string;
          locale: string;
          llm_policy: Record<string, unknown>;
          is_aggregator: boolean;
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
                 is_aggregator
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
          noOp: true,
        });
      }

      // UPDATE with COALESCE on each optional field — only the
      // fields the operator submitted are touched. RETURNING the
      // full row shape so the response mirrors GET. The trailing
      // `updated_at = NOW()` is implicit (`$onUpdate` on the
      // schema) — repeating it here keeps the SQL side honest.
      //
      // Wrapped in try/catch (mirrors DELETE) so a connectivity
      // blip can't leak `err.message` through Fastify's default
      // error handler.
      let updated: {
        rows: Array<{
          id: string;
          slug: string;
          name: string;
          class: string;
          locale: string;
          llm_policy: Record<string, unknown>;
          is_aggregator: boolean;
        }>;
      };
      try {
        updated = (await args.db.execute(sql`
          UPDATE domains
          SET name = COALESCE(${display_name ?? null}, name),
              locale = COALESCE(${locale ?? null}, locale),
              is_aggregator = COALESCE(${is_aggregator ?? null}, is_aggregator),
              updated_at = NOW()
          WHERE id = ${id}::uuid
          RETURNING id::text AS id,
                    slug,
                    name,
                    class::text AS class,
                    locale,
                    llm_policy,
                    is_aggregator
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
