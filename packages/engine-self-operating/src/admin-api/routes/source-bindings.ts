/**
 * Sources tab + Review Dashboard — source-bindings routes
 * (PR 28 list, phase-a appendix #2 create, phase-a fixup
 * widens the list to all bindings).
 *
 * `GET /api/admin/source-bindings` — read-only list of EVERY
 *   binding row, ordered newest-first, capped at 200. Per
 *   architecture §13 the Sources tab is "list + add" of every
 *   binding; the needs-attention queue is the Review Dashboard's
 *   job (§7.3, separate endpoint set). Earlier this handler
 *   filtered to `WHERE review_mode = 'review' OR enabled = false`
 *   and PR 40 dropped that filter — the auto-mode + enabled
 *   bindings the operator creates through the UI now show up
 *   in the Sources list as designed.
 * `POST /api/admin/source-bindings` — create a new binding.
 *   Closes the regression PR 29 introduced (architecture.md
 *   §13 promised "Sources — list + add", PR 29 shipped only
 *   `+ list`).
 *
 * The POST handler:
 *   1. Validates `(adapter_slug, target_domain_slug)` against
 *      the registry and `domains` table.
 *   2. Validates `credentials` against the adapter's
 *      JSON-Schema descriptor (mode-aware: polling = flat;
 *      webhook = `auth` + `webhook_secret` halves).
 *   3. Encrypts each credential half via `credentialStore.write`
 *      — polling = one write, webhook = two writes.
 *   4. INSERTs the binding row with `credentials_id` (and, for
 *      webhook adapters, `webhook_secret_credentials_id`).
 *   5. Writes the audit-log row with `caller_username`,
 *      `adapter_slug`, `target_domain_slug` — NEVER the
 *      credential bytes.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import {
  defaultReviewModeFor,
  getSourceAdapterBindingConfigSchema,
  getSourceAdapterDescriptor,
  type BindingConfigSchema,
  type DomainClass,
  type PollingCredentialSchema,
  type SourceAdapterCredentialDescriptor,
} from "@opencoo/shared/source-adapter";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

const reviewModeUpdateSchema = z
  .object({
    reviewMode: z.enum(["auto", "review", "approve"]),
  })
  .strict();

/** PR-Q10 — `PATCH /api/admin/source-bindings/:id` body. v0.1 only
 *  exposes the `enabled` toggle; review-mode flips go through the
 *  dedicated `/review-mode` endpoint and binding metadata edits are
 *  v0.2. The `.strict()` rejects any other key so a body like
 *  `{enabled: false, review_mode: 'auto'}` doesn't smuggle a second
 *  state change through the audit row. */
const bindingPatchSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** 3-state health, or `null` for neutral (paused or never-fired binding).
 *  See `computeBindingStatus` for the rules. */
type BindingStatus = "healthy" | "advisory" | "alert" | null;

interface BindingRow {
  readonly id: string;
  readonly domainSlug: string;
  readonly adapterSlug: string;
  readonly reviewMode: string;
  readonly enabled: boolean;
  readonly lastScannedAt: string | null;
  readonly notes: string | null;
  /** Human-readable name: `notes` if set, else `${adapterSlug} → ${domainSlug}`.
   *  `notes` is the current display-label convention; v0.2 should add a dedicated
   *  `display_name` column. Operators should treat `notes` as the binding's display
   *  label until then. */
  readonly name: string;
  readonly status: BindingStatus;
  /** ISO timestamp of the most-recent webhook_events.received_at. */
  readonly lastEventAt: string | null;
  /** Scrubbed + 200-char-truncated error message from ingestion_intake.
   *  Prefers `error_text` (free-form message) over `error_class` (enum literal).
   *  THREAT-MODEL §3.6 invariant 11: no credential bytes in the response. */
  readonly lastError: string | null;
  /** Count of webhook_events rows with status='pending' for this binding.
   *  Used by the Review Dashboard to surface bindings that need attention.
   *  Phase-a appendix #4 PR-C addition. */
  readonly pendingEventsCount: number;
  /** Count of webhook_events rows with `signature_ok=false` in the last 24h.
   *  Already computed for status derivation; surfaced on the row so the
   *  Sources row drill-down (PR-Q10) can show the operator how many HMAC
   *  failures landed without re-querying. */
  readonly sigFailCount24h: number;
}

/** Coerce pg's timestamp result (Date when node-postgres parsed it,
 *  string when pglite returned it raw) to an ISO string.
 *
 *  Returns `null` rather than throwing if the value cannot be parsed
 *  (e.g. pglite returns a non-ISO string on rare schema mismatches).
 *  Callers already handle `null` per the `BindingRow` type signature.
 *
 *  Exported for unit testing only — not part of the public module API. */
export function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const REVIEW_MODES = ["auto", "approve", "review"] as const;

const createBindingSchema = z
  .object({
    adapter_slug: z.string().min(1),
    target_domain_slug: z.string().min(1),
    review_mode: z.enum(REVIEW_MODES).optional(),
    credentials: z.record(z.string(), z.unknown()),
    /**
     * PR-Q9: operational settings (NOT credentials). Validated
     * against the adapter's `bindingConfigSchema` BEFORE the
     * binding row is INSERTed; persisted to
     * `sources_bindings.config` jsonb on success.
     *
     * Optional at the wire level so polling adapters with no
     * required config (currently none, but future-proof) and
     * webhook adapters whose required fields are all defaulted
     * (e.g. fireflies) accept a body without `config`. The
     * server-side binding-config validator reasserts the
     * adapter-specific required-set.
     */
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export interface RegisterSourceBindingsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** Phase-a appendix #2 — encrypts credential halves before
   *  the binding row INSERT. When undefined, POST returns 500
   *  (composition-incomplete). The GET handler is unaffected. */
  readonly credentialStore?: CredentialStore;
  /** BullMQ ingestion queue, probed for DLQ depth in the GET handler.
   *  Optional: when undefined the DLQ signal contributes nothing to
   *  status (treated as 0 — no alert from DLQ alone). */
  readonly ingestionQueue?: { getJobCounts: (...states: string[]) => Promise<Record<string, number>> };
}

export function registerSourceBindingsRoutes(
  args: RegisterSourceBindingsRoutesArgs,
): void {
  args.app.get("/api/admin/source-bindings", async () => {
    // Status query: three correlated sub-selects, one per signal
    // (latest event time, 24h sig-fail count, latest 24h intake error).
    // `name` falls back to `adapter_slug → domain_slug` when notes is null
    // — a dedicated column is a v0.2 enhancement.
    const result = (await args.db.execute(sql`
      SELECT b.id::text AS id,
             d.slug AS domain_slug,
             b.adapter_slug,
             b.review_mode::text AS review_mode,
             b.enabled,
             b.last_scanned_at,
             b.notes,
             COALESCE(b.notes, b.adapter_slug || ' → ' || d.slug) AS name,
             (
               SELECT w.received_at
               FROM webhook_events w
               WHERE w.binding_id = b.id
               ORDER BY w.received_at DESC
               LIMIT 1
             ) AS last_event_at,
             (
               SELECT COUNT(*)::int
               FROM webhook_events w
               WHERE w.binding_id = b.id
                 AND w.signature_ok = false
                 AND w.received_at >= NOW() - INTERVAL '24 hours'
             ) AS sig_fail_count_24h,
             (
               SELECT COALESCE(ii.error_text, ii.error_class::text)
               FROM ingestion_intake ii
               WHERE ii.binding_id = b.id
                 AND (ii.error_class IS NOT NULL OR ii.error_text IS NOT NULL)
                 AND ii.created_at >= NOW() - INTERVAL '24 hours'
               ORDER BY ii.created_at DESC
               LIMIT 1
             ) AS latest_error_class,
             (
               SELECT COUNT(*)::int
               FROM webhook_events w
               WHERE w.binding_id = b.id
                 AND w.status = 'pending'
             ) AS pending_events_count
      FROM sources_bindings b
      JOIN domains d ON d.id = b.domain_id
      ORDER BY b.created_at DESC
      LIMIT 200
    `)) as unknown as {
      rows: Array<{
        id: string;
        domain_slug: string;
        adapter_slug: string;
        review_mode: string;
        enabled: boolean;
        last_scanned_at: Date | string | null;
        notes: string | null;
        name: string;
        last_event_at: Date | string | null;
        sig_fail_count_24h: number;
        latest_error_class: string | null;
        pending_events_count: number;
      }>;
    };

    // DLQ depth is a single shared probe — v0.1 uses one ingestion queue;
    // per-binding queues are v0.2. A failed probe is non-fatal: keep 0 so
    // the UI doesn't flash spurious alerts.
    const dlqDepth = await probeDlqDepth(args.ingestionQueue);

    const rows: BindingRow[] = result.rows.map((r) => {
      const lastEventAt = toIso(r.last_event_at);
      const lastError =
        r.latest_error_class !== null
          ? safeErrorMessage(r.latest_error_class)
          : null;
      const status = computeBindingStatus({
        enabled: r.enabled,
        lastEventAt,
        sigFailCount24h: r.sig_fail_count_24h,
        latestErrorClass: r.latest_error_class,
        dlqDepth,
      });
      return {
        id: r.id,
        domainSlug: r.domain_slug,
        adapterSlug: r.adapter_slug,
        reviewMode: r.review_mode,
        enabled: r.enabled,
        lastScannedAt: toIso(r.last_scanned_at),
        notes: r.notes,
        name: r.name,
        status,
        lastEventAt,
        lastError,
        pendingEventsCount: r.pending_events_count,
        sigFailCount24h: r.sig_fail_count_24h,
      };
    });
    return { rows };
  });

  // Phase-a appendix #2 — binding create.
  args.app.post(
    "/api/admin/source-bindings",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const parsed = createBindingSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const { adapter_slug, target_domain_slug, credentials } = parsed.data;
      const submittedConfig = parsed.data.config ?? {};

      const descriptor = getSourceAdapterDescriptor(adapter_slug);
      if (descriptor === undefined) {
        return reply.code(422).send({
          error: "unknown_adapter_slug",
          adapter_slug,
        });
      }

      // Resolve target domain.
      const domainResult = (await args.db.execute(sql`
        SELECT id::text AS id, class::text AS class
        FROM domains
        WHERE slug = ${target_domain_slug}
        LIMIT 1
      `)) as unknown as {
        rows: Array<{ id: string; class: string }>;
      };
      const domain = domainResult.rows[0];
      if (domain === undefined) {
        return reply.code(422).send({
          error: "unknown_target_domain_slug",
          target_domain_slug,
        });
      }

      // Validate credentials against the adapter's JSON Schema.
      const credValidation = validateCredentialsAgainstSchema(
        credentials,
        descriptor,
      );
      if (!credValidation.ok) {
        return reply.code(422).send({
          error: "credential_schema_mismatch",
          // Path-only diagnostics; never the value.
          missing: credValidation.missing,
        });
      }

      // PR-Q9: validate operational settings against the adapter's
      // `bindingConfigSchema` BEFORE we encrypt credentials or
      // INSERT the row. A misconfigured binding fails at creation
      // time (422) instead of at the first webhook delivery
      // (500 → factory_threw).
      //
      // The schema lookup is structural — every wired adapter has
      // a registry entry. A missing entry would surface as a
      // composition bug, but we route it as a generic 422 rather
      // than 500 because the adapter-slug validator above already
      // covers unknown slugs and we have no useful diagnostic to
      // emit beyond `binding_config_schema_unavailable`.
      const bindingConfigSchema =
        getSourceAdapterBindingConfigSchema(adapter_slug);
      if (bindingConfigSchema === undefined) {
        return reply.code(422).send({
          error: "binding_config_schema_unavailable",
          adapter_slug,
        });
      }
      const configValidation = validateBindingConfigAgainstSchema(
        submittedConfig,
        bindingConfigSchema,
      );
      if (!configValidation.ok) {
        return reply.code(422).send({
          error: "binding_config_schema_mismatch",
          missing: configValidation.missing,
        });
      }

      const store = args.credentialStore;
      if (store === undefined) {
        return reply.code(500).send({
          error: "credential_store_unavailable",
          reason: "Composition did not register a credentialStore",
        });
      }

      // Encrypt each half via credentialStore.write — polling =
      // one write, webhook = two. Failures surface as a 500 with
      // no upstream detail (the cause is logged separately).
      let credentialsId: CredentialId;
      let webhookSecretCredentialsId: CredentialId | null;
      try {
        const encrypted = await encryptBindingCredentials({
          store,
          descriptor,
          adapterSlug: adapter_slug,
          targetDomainSlug: target_domain_slug,
          credentials,
        });
        credentialsId = encrypted.credentialsId;
        webhookSecretCredentialsId = encrypted.webhookSecretCredentialsId;
      } catch (err) {
        req.log?.warn({
          msg: "binding_create.credential_store_failed",
          adapter_slug,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(500).send({
          error: "credential_store_failed",
        });
      }

      // Default review_mode if the operator omitted.
      const effectiveReviewMode =
        parsed.data.review_mode ??
        defaultReviewModeFor({
          adapterSlug: adapter_slug,
          domainClass: domain.class as DomainClass,
        });

      // Insert binding row. Use sql.raw for the static enum
      // literal cast and sql parameters for the dynamic ids.
      const webhookSecretSql =
        webhookSecretCredentialsId === null
          ? sql`NULL`
          : sql`${webhookSecretCredentialsId}::uuid`;
      let id: string;
      try {
        // PR-Q9: persist `config` jsonb. Stringify the validated
        // object so pg's jsonb codec receives well-formed JSON
        // text (Drizzle's `sql` parameter binding does NOT auto-
        // serialize objects for jsonb columns). The empty-object
        // default mirrors the column's DDL DEFAULT '{}'::jsonb.
        const configJson = JSON.stringify(submittedConfig);
        const inserted = (await args.db.execute(sql`
          INSERT INTO sources_bindings
            (domain_id, adapter_slug, review_mode, credentials_id, webhook_secret_credentials_id, config)
          VALUES (
            ${domain.id}::uuid,
            ${adapter_slug},
            ${sql.raw(`'${effectiveReviewMode}'`)}::review_mode,
            ${credentialsId}::uuid,
            ${webhookSecretSql},
            ${configJson}::jsonb
          )
          RETURNING id::text AS id
        `)) as unknown as { rows: Array<{ id: string }> };
        const row = inserted.rows[0];
        if (row === undefined) {
          return reply.code(500).send({ error: "insert_returned_no_row" });
        }
        id = row.id;
      } catch (err) {
        req.log?.warn({
          msg: "binding_create.insert_failed",
          adapter_slug,
          err: err instanceof Error ? err.message : String(err),
        });
        // Best-effort cleanup: the encrypted credential rows already
        // committed via `credentialStore.write` above; without this
        // they would leak as orphans (no FK from credentials → binding,
        // and no scheduled cleanup pass for orphan credentials in v0.1).
        // `CredentialStore.delete` is idempotent (interface.ts:31); a
        // failure here logs and continues so the operator still gets
        // the 500 from the original INSERT failure.
        try {
          await store.delete(credentialsId);
        } catch (cleanupErr) {
          req.log?.warn({
            msg: "binding_create.credentials_cleanup_failed",
            adapter_slug,
            err:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          });
        }
        if (webhookSecretCredentialsId !== null) {
          try {
            await store.delete(webhookSecretCredentialsId);
          } catch (cleanupErr) {
            req.log?.warn({
              msg: "binding_create.webhook_secret_cleanup_failed",
              adapter_slug,
              err:
                cleanupErr instanceof Error
                  ? cleanupErr.message
                  : String(cleanupErr),
            });
          }
        }
        return reply.code(500).send({ error: "insert_failed" });
      }

      // Audit row — slug + domain + caller, NEVER credentials.
      await writeAuditLog(args.db, {
        action: "source_binding.create",
        userId: ctx.userId,
        metadata: {
          adapter_slug,
          target_domain_slug,
          review_mode: effectiveReviewMode,
          binding_id: id,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(201).send({ id });
    },
  );

  // Review-mode update — flip a binding's review_mode in one
  // audited action. The UI uses this to approve ('auto') or
  // revert a binding to manual review ('review').
  args.app.post(
    "/api/admin/source-bindings/:id/review-mode",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      // Validate id is a UUID before passing to SQL.
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const parsed = reviewModeUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const { reviewMode } = parsed.data;

      // Fetch the current row to get prev_mode + existence check.
      const existing = (await args.db.execute(sql`
        SELECT review_mode::text AS review_mode
        FROM sources_bindings
        WHERE id = ${id}::uuid
        LIMIT 1
      `)) as unknown as { rows: Array<{ review_mode: string }> };
      const row = existing.rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }
      const prevMode = row.review_mode;
      if (prevMode === reviewMode) {
        return reply.code(409).send({
          error: "already_in_target_mode",
          review_mode: reviewMode,
        });
      }

      // UPDATE — atomic with prevMode guard so concurrent updates
      // don't silently overwrite a race. The condition mirrors the
      // automation-candidates pattern (update WHERE status = old).
      const updateResult = (await args.db.execute(sql`
        UPDATE sources_bindings
        SET review_mode = ${reviewMode}::review_mode,
            updated_at = NOW()
        WHERE id = ${id}::uuid
          AND review_mode = ${prevMode}::review_mode
      `)) as unknown as { rowCount: number };

      // If rowCount === 0, another operator raced us to the update.
      // Re-SELECT to get the current mode and return it in the 409.
      if (updateResult.rowCount === 0) {
        const current = (await args.db.execute(sql`
          SELECT review_mode::text AS review_mode
          FROM sources_bindings
          WHERE id = ${id}::uuid
          LIMIT 1
        `)) as unknown as { rows: Array<{ review_mode: string }> };
        return reply.code(409).send({
          error: "concurrent_update",
          current_mode: current.rows[0]?.review_mode ?? prevMode,
        });
      }

      // Map the user's intent to the correct audit action verb.
      // approve ≡ moving to 'auto' (hands-off), reject ≡ any mode
      // that keeps the operator in the loop ('review').
      const auditAction =
        reviewMode === "auto"
          ? "source_binding.review.approve"
          : "source_binding.review.reject";

      await writeAuditLog(args.db, {
        action: auditAction,
        userId: ctx.userId,
        metadata: {
          binding_id: id,
          prev_mode: prevMode,
          new_mode: reviewMode,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({ reviewMode });
    },
  );

  // PR-Q10 — toggle `enabled`. The Sources row drill-down modal
  // calls this to disable / re-enable a binding without going through
  // psql. CSRF-gated; writes 'source_binding.update' audit row with
  // prev/new flags so the audit trail is unambiguous.
  args.app.patch(
    "/api/admin/source-bindings/:id",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      const parsed = bindingPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const { enabled } = parsed.data;

      // Existence + prev_enabled snapshot for the audit row.
      const existing = (await args.db.execute(sql`
        SELECT enabled
        FROM sources_bindings
        WHERE id = ${id}::uuid
        LIMIT 1
      `)) as unknown as { rows: Array<{ enabled: boolean }> };
      const prev = existing.rows[0];
      if (prev === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }

      // The UPDATE always runs (even when `enabled` already matches
      // the requested value) — clicking Disable on an already-disabled
      // binding still bumps `updated_at` and writes an audit row so
      // the operator's intent is captured (the audit confirms the
      // operator inspected the state, even on a no-op flip).
      const updated = (await args.db.execute(sql`
        UPDATE sources_bindings
        SET enabled = ${enabled},
            updated_at = NOW()
        WHERE id = ${id}::uuid
        RETURNING id::text AS id, enabled
      `)) as unknown as { rows: Array<{ id: string; enabled: boolean }> };
      const row = updated.rows[0];
      if (row === undefined) {
        return reply.code(500).send({ error: "update_returned_no_row" });
      }

      await writeAuditLog(args.db, {
        action: "source_binding.update",
        userId: ctx.userId,
        metadata: {
          binding_id: id,
          prev_enabled: prev.enabled,
          new_enabled: enabled,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({ id: row.id, enabled: row.enabled });
    },
  );

  // PR-Q10 — delete binding. The Sources row drill-down's confirm-
  // gated Delete action calls this. The schema uses `ON DELETE
  // RESTRICT` for every binding-id FK; we explicitly clear the two
  // tables the operator can reasonably expect to lose with the
  // binding (`webhook_events` + `ingestion_intake`) inside a single
  // transaction so a partial cascade can't strand orphans.
  //
  // Other tables — `page_citations`, `redaction_events`, `erasure_log`,
  // `miner_runs` — hold append-only audit (THREAT-MODEL §2 invariant 8);
  // the endpoint surfaces 409 if any of those FKs block the delete so
  // the operator chooses the correct path (disable, then archive
  // separately) rather than silently nuking history.
  //
  // PR-Q10b refinements:
  //   - The 409 path is narrowed to actual Postgres FK-violation
  //     errors (SQLSTATE 23503) so DB connectivity / permission /
  //     syntax failures don't get masked as fk_restricted; everything
  //     else surfaces 500 instead.
  //   - The pre-check at line ~622 narrowed-but-didn't-close a TOCTOU:
  //     a concurrent DELETE between the SELECT and the tx body could
  //     produce 200 + an audit row for a row that no longer existed.
  //     The transactional DELETE now uses RETURNING id + a rowcount
  //     check; 0 rows deleted ⇒ throw a sentinel that rolls back the
  //     tx and surfaces 404 (no audit row written).
  args.app.delete(
    "/api/admin/source-bindings/:id",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }

      // Existence check before the transaction so we can return 404
      // without holding a write lock. The TOCTOU between this check
      // and the tx is closed by the rowcount check on the parent
      // DELETE below — see PR-Q10b note above.
      const existing = (await args.db.execute(sql`
        SELECT id FROM sources_bindings WHERE id = ${id}::uuid LIMIT 1
      `)) as unknown as { rows: Array<{ id: string }> };
      if (existing.rows[0] === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }

      try {
        await args.db.transaction(async (tx) => {
          await tx.execute(sql`
            DELETE FROM webhook_events WHERE binding_id = ${id}::uuid
          `);
          await tx.execute(sql`
            DELETE FROM ingestion_intake WHERE binding_id = ${id}::uuid
          `);
          // RETURNING id lets us count what we actually deleted. If
          // 0 rows came back, a concurrent DELETE raced us between
          // the pre-check and this statement; throw the sentinel so
          // the tx rolls back and we surface 404 without writing an
          // audit row for a non-existent binding.
          const deleted = (await tx.execute(sql`
            DELETE FROM sources_bindings WHERE id = ${id}::uuid RETURNING id
          `)) as unknown as { rows: Array<{ id: string }> };
          if (deleted.rows.length === 0) {
            throw new ConcurrentDeleteError();
          }
        });
      } catch (err) {
        // PR-Q10b: narrow the catch to its three known failure
        // modes — the previous "any error → 409" masked DB
        // connectivity / permission / syntax failures as
        // fk_restricted, leaving the operator to debug a misleading
        // signal. Order matters: ConcurrentDeleteError surfaces 404
        // (rolled back by design); pg SQLSTATE 23503 surfaces 409
        // (audit FK genuinely blocks the cascade); everything else
        // surfaces 500 + a logged warning.
        if (err instanceof ConcurrentDeleteError) {
          req.log?.warn({
            msg: "binding_delete.toctou_concurrent_delete",
            binding_id: id,
          });
          return reply.code(404).send({ error: "not_found", id });
        }
        if (isPgForeignKeyViolation(err)) {
          req.log?.warn({
            msg: "binding_delete.fk_restricted",
            binding_id: id,
            err: err instanceof Error ? err.name : "unknown",
          });
          return reply.code(409).send({ error: "fk_restricted" });
        }
        // Genuine internal failure — connectivity, permission,
        // syntax. Log the error class (not the message body, which
        // Postgres may include row identifiers in) and surface a
        // generic 500.
        req.log?.warn({
          msg: "binding_delete.internal_error",
          binding_id: id,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(500).send({ error: "internal_error" });
      }

      await writeAuditLog(args.db, {
        action: "source_binding.delete",
        userId: ctx.userId,
        metadata: {
          binding_id: id,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({ deleted: true });
    },
  );
}

/** Sentinel thrown inside the DELETE transaction to roll it back when
 *  RETURNING id finds zero rows — i.e. another DELETE raced between
 *  the pre-check SELECT and the tx body. Caller maps to 404 without
 *  writing an audit row. */
class ConcurrentDeleteError extends Error {
  constructor() {
    super("concurrent_delete_detected");
    this.name = "ConcurrentDeleteError";
  }
}

/** Detect a Postgres `foreign_key_violation` (SQLSTATE 23503).
 *  node-postgres surfaces the code on the thrown Error directly;
 *  Drizzle wraps the underlying error sometimes via `.cause`, so we
 *  check both spellings. */
function isPgForeignKeyViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const codeFromTop = (err as { code?: unknown }).code;
  if (typeof codeFromTop === "string" && codeFromTop === "23503") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== null && typeof cause === "object") {
    const codeFromCause = (cause as { code?: unknown }).code;
    if (typeof codeFromCause === "string" && codeFromCause === "23503") {
      return true;
    }
  }
  return false;
}

// ─── Status computation (phase-a appendix #4 PR-A) ──────────────────────────

interface ComputeBindingStatusArgs {
  readonly enabled: boolean;
  readonly lastEventAt: string | null;
  readonly sigFailCount24h: number;
  readonly latestErrorClass: string | null;
  readonly dlqDepth: number;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Compute the 3-state health status for a source binding.
 *
 *   null       → paused (enabled=false) OR newly created (no events ever).
 *   'alert'    → any failure signal in last 24h: intake error_class,
 *                webhook sig-fail, or DLQ depth > 0.
 *   'advisory' → enabled, has events, but last one was >24h ago (stale).
 *   'healthy'  → events arriving normally, no failures.
 */
function computeBindingStatus(args: ComputeBindingStatusArgs): BindingStatus {
  if (!args.enabled) return null;
  if (args.lastEventAt === null) return null;

  if (
    args.latestErrorClass !== null ||
    args.sigFailCount24h >= 1 ||
    args.dlqDepth > 0
  ) {
    return "alert";
  }

  const ageMs = Date.now() - new Date(args.lastEventAt).getTime();
  return ageMs > TWENTY_FOUR_HOURS_MS ? "advisory" : "healthy";
}

/** Read the shared ingestion queue's failed-job count. Returns 0 when
 *  no queue is injected (e.g. composition-incomplete in tests) or when
 *  the probe itself fails — the UI should not flash spurious alerts on
 *  a Redis blip. */
async function probeDlqDepth(
  queue: { getJobCounts: (...states: string[]) => Promise<Record<string, number>> } | undefined,
): Promise<number> {
  if (queue === undefined) return 0;
  try {
    const counts = await queue.getJobCounts("failed");
    return counts["failed"] ?? 0;
  } catch {
    return 0;
  }
}

/** Validate credentials against the adapter's descriptor. Walks
 *  required fields without mentioning the field VALUES — only
 *  paths come back so a 422 response can never leak partial
 *  secret bytes. */
function validateCredentialsAgainstSchema(
  credentials: Record<string, unknown>,
  descriptor: SourceAdapterCredentialDescriptor,
): { readonly ok: true } | { readonly ok: false; readonly missing: string[] } {
  const missing: string[] = [];
  if (descriptor.mode === "polling") {
    walkPollingSchema(descriptor.credentialSchema, credentials, "", missing);
  } else {
    const auth = (credentials as { auth?: unknown }).auth;
    const webhookSecret = (credentials as { webhook_secret?: unknown })
      .webhook_secret;
    if (typeof auth !== "object" || auth === null) {
      missing.push("auth");
    } else {
      walkPollingSchema(
        descriptor.credentialSchema.properties.auth,
        auth as Record<string, unknown>,
        "auth.",
        missing,
      );
    }
    if (typeof webhookSecret !== "object" || webhookSecret === null) {
      missing.push("webhook_secret");
    } else {
      walkPollingSchema(
        descriptor.credentialSchema.properties.webhook_secret,
        webhookSecret as Record<string, unknown>,
        "webhook_secret.",
        missing,
      );
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

function walkPollingSchema(
  schema: PollingCredentialSchema,
  values: Record<string, unknown>,
  pathPrefix: string,
  missing: string[],
): void {
  for (const required of schema.required) {
    const value = values[required];
    // Schema declares `type: "string"` for every leaf; reject any
    // non-string value (number/object/array/boolean) and treat
    // empty strings as missing. Path-only error so no value
    // bytes leak into the 422 response.
    if (typeof value !== "string" || value.length === 0) {
      missing.push(`${pathPrefix}${required}`);
    }
  }
}

/** PR-Q9: validate operational settings against the adapter's
 *  `bindingConfigSchema`. Path-only diagnostics — never echoes
 *  submitted values into the 422 response (parity with the
 *  credential validator).
 *
 *  Type-checks each declared property: enum membership,
 *  array-of-string shape, and minLength on strings. Unknown
 *  fields the operator submits are tolerated (forward-compat
 *  with future schema additions); the adapter's Zod parse runs
 *  on the persisted config later and applies `.strict()` if it
 *  needs to reject extras. */
function validateBindingConfigAgainstSchema(
  config: Record<string, unknown>,
  schema: BindingConfigSchema,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: string[] } {
  const missing: string[] = [];

  for (const required of schema.required) {
    const value = config[required];
    const field = schema.properties[required];
    if (field === undefined) continue;
    // Defensive: skip required-gating on `hidden` fields (PR-Q9
    // review). Today no adapter lists a hidden field as required —
    // hidden fields are auto-backfilled by handshake / scan flows
    // (asana / fireflies `webhookSecretCredentialId`). If a future
    // adapter mis-marks one as required, the wizard would have no
    // input for it AND the server would reject the create — this
    // skip keeps the symmetry with the client-side `field.hidden`
    // skip in `BindingConfigFields`.
    if (field.hidden === true) continue;
    if (!isFieldValuePresent(field, value)) {
      missing.push(required);
    }
  }

  // Type-check every PROVIDED property against the schema. A bad
  // shape on an optional property (e.g. `reviewMode: "bogus"`) is
  // surfaced under the same path-only diagnostic so the operator
  // sees which field was rejected.
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue;
    const field = schema.properties[key];
    if (field === undefined) continue; // tolerate forward-compat fields
    if (!isFieldValueShapeOk(field, value)) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    // PR-Q9 round-2: dedupe so a required field with a wrong-shape
    // value (e.g. `projectGid: 12345` as a number) doesn't appear
    // twice in the diagnostic — once from the required-loop and
    // once from the shape-loop. Operator-facing payload reads
    // cleaner and tests don't have to special-case duplicates.
    const deduped = Array.from(new Set(missing));
    return { ok: false, missing: deduped };
  }
  return { ok: true };
}

/** Required-field gate: present + non-empty. Empty string,
 *  empty array, undefined, and null all count as missing. */
function isFieldValuePresent(
  field: BindingConfigSchema["properties"][string],
  value: unknown,
): boolean {
  if (value === undefined || value === null) return false;
  if (field.type === "string") {
    return typeof value === "string" && value.length > 0;
  }
  if (field.type === "array") {
    return Array.isArray(value) && value.length > 0;
  }
  if (field.type === "boolean") {
    return typeof value === "boolean";
  }
  if (field.type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return false;
}

/** Shape gate: when value is provided, does it match the
 *  declared field type + enum + minLength constraints? Used for
 *  optional fields the operator chose to set. */
function isFieldValueShapeOk(
  field: BindingConfigSchema["properties"][string],
  value: unknown,
): boolean {
  if (field.type === "string") {
    if (typeof value !== "string") return false;
    if (field.minLength !== undefined && value.length < field.minLength) {
      return false;
    }
    if (field.enum !== undefined && !field.enum.includes(value)) {
      return false;
    }
    return true;
  }
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (field.type === "array") {
    if (!Array.isArray(value)) return false;
    // v0.1 only supports array-of-string items.
    return value.every((v) => typeof v === "string");
  }
  return false;
}

interface EncryptBindingCredentialsArgs {
  readonly store: CredentialStore;
  readonly descriptor: SourceAdapterCredentialDescriptor;
  readonly adapterSlug: string;
  readonly targetDomainSlug: string;
  readonly credentials: Record<string, unknown>;
}

interface EncryptBindingCredentialsResult {
  readonly credentialsId: CredentialId;
  readonly webhookSecretCredentialsId: CredentialId | null;
}

/** Write credential halves into the store. Polling adapters get
 *  one write; webhook adapters get two (auth + webhook_secret).
 *  The plaintext bytes only exist inside the JSON.stringify
 *  buffer the caller passes — they're consumed by the store
 *  immediately and never returned. */
async function encryptBindingCredentials(
  args: EncryptBindingCredentialsArgs,
): Promise<EncryptBindingCredentialsResult> {
  const baseName = `${args.adapterSlug}/${args.targetDomainSlug}`;
  const baseSchemaRef = `source-adapter:${args.adapterSlug}`;

  if (args.descriptor.mode === "polling") {
    const credentialsId = await args.store.write({
      name: `${baseName}/auth`,
      schemaRef: `${baseSchemaRef}:auth`,
      plaintext: Buffer.from(JSON.stringify(args.credentials), "utf8"),
    });
    return { credentialsId, webhookSecretCredentialsId: null };
  }

  const webhookCreds = args.credentials as {
    auth: Record<string, unknown>;
    webhook_secret: Record<string, unknown>;
  };
  const credentialsId = await args.store.write({
    name: `${baseName}/auth`,
    schemaRef: `${baseSchemaRef}:auth`,
    plaintext: Buffer.from(JSON.stringify(webhookCreds.auth), "utf8"),
  });
  const webhookSecretCredentialsId = await args.store.write({
    name: `${baseName}/webhook_secret`,
    schemaRef: `${baseSchemaRef}:webhook_secret`,
    plaintext: Buffer.from(JSON.stringify(webhookCreds.webhook_secret), "utf8"),
  });
  return { credentialsId, webhookSecretCredentialsId };
}
