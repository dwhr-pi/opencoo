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
import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import type { DomainSlug } from "@opencoo/shared/db";
import { planForget } from "@opencoo/shared/forget";
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
import type { DeleteCap } from "@opencoo/shared/wiki-write";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext, type AdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";
import { isPgForeignKeyViolation } from "../pg-error.js";

const reviewModeUpdateSchema = z
  .object({
    reviewMode: z.enum(["auto", "review", "approve"]),
  })
  .strict();

/** PR-Q10 — `PATCH /api/admin/source-bindings/:id` body.
 *
 *  PR-R2 (phase-a appendix #10) widens the body to a discriminated
 *  union — exactly ONE of three intents per request:
 *    • `{enabled}`     — Q10 disable/enable toggle (unchanged)
 *    • `{config}`      — operational settings update
 *    • `{credentials}` — in-place credential rotation
 *
 *  Mixed bodies (e.g. `{enabled, config}`) are rejected with 422 so
 *  the audit trail records exactly one verb per action. Each branch
 *  is `.strict()` so no other top-level key smuggles a second state
 *  change through. */
const bindingEnabledPatchSchema = z
  .object({ enabled: z.boolean() })
  .strict();
const bindingConfigPatchSchema = z
  .object({ config: z.record(z.string(), z.unknown()) })
  .strict();
/** PR-R2 review fix-up — `credentials` body shape is now
 *  `{auth?, webhook_secret?}`: either half is optional so the
 *  operator can rotate just the auth credential without retyping
 *  the webhook secret (and vice versa). The validator below
 *  rejects an empty `{credentials: {}}` and rejects
 *  `webhook_secret` for polling adapters. */
const bindingCredentialsPatchSchema = z
  .object({
    credentials: z
      .object({
        auth: z.record(z.string(), z.unknown()).optional(),
        webhook_secret: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
const bindingPatchSchema = z.union([
  bindingEnabledPatchSchema,
  bindingConfigPatchSchema,
  bindingCredentialsPatchSchema,
]);

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
  /** PR-R2 — operational config jsonb (NOT credentials). Surfaced so
   *  the Sources row drill-down's Edit panel can pre-seed the
   *  `bindingConfigSchema` form with the binding's current settings,
   *  giving the operator a full-state edit surface. Plain object;
   *  values may include operator-internal IDs but never secret bytes
   *  (credentials live in `credentials_id`, never config). */
  readonly config: Record<string, unknown>;
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

/** PR-R7 (phase-a appendix #10) — payload threaded into the
 *  composition-supplied forget enqueuer when the operator confirms
 *  a forget. The route plans the impact + reserves the cap; the
 *  enqueuer (production: BullMQ Queue.add into the wiki-write
 *  recompile + delete pipelines) does the actual work. Tests inject
 *  a spy to assert the route called it.
 *
 *  Path lists are the planner output (stable, sorted) so the worker
 *  doesn't need to re-plan; it just iterates and enqueues per-page
 *  jobs. The route itself NEVER invokes wikiAdapter directly — the
 *  no-direct-gitea-write ESLint boundary keeps the engine boundary
 *  clean. */
export interface ForgetJobEnqueueArgs {
  readonly bindingId: string;
  readonly domainSlug: string;
  readonly pagesRecompiled: readonly string[];
  readonly pagesDeleted: readonly string[];
  /** Operator that triggered the forget (audit cross-reference). */
  readonly callerUsername: string;
}

export interface RegisterSourceBindingsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** Phase-a appendix #2 — encrypts credential halves before
   *  the binding row INSERT. When undefined, POST returns 500
   *  (composition-incomplete). The GET handler is unaffected. */
  readonly credentialStore?: CredentialStore;
  /** BullMQ ingestion queue, probed for DLQ depth in the GET handler.
   *  PR-Z3 (phase-a appendix #12) widens the shape to also expose
   *  `add` so the POST handler can enqueue a post-create initial
   *  scan (closes G6) AND the `:id/scan-now` route can enqueue an
   *  on-demand scan (closes G8). Optional: when undefined the GET
   *  handler treats DLQ depth as 0, the POST handler skips the
   *  initial-scan enqueue (binding is created cleanly; next 4h cron
   *  picks it up), and the scan-now route returns 503. */
  readonly ingestionQueue?: {
    getJobCounts: (...states: string[]) => Promise<Record<string, number>>;
    add?: (
      name: string,
      data: unknown,
      opts?: unknown,
    ) => Promise<unknown>;
  };
  /** PR-R7 — read-only delete-cap probe + reserve. The route reads
   *  `peek` to surface today's budget in the dry-run response and
   *  calls `reserve` on `?dryRun=0` BEFORE the audit row + enqueue
   *  fire. When undefined the forget endpoint returns 503
   *  (composition-incomplete; same boot-tolerance pattern as the
   *  rest of the admin API). */
  readonly deleteCap?: DeleteCap;
  /** PR-R7 — composition-supplied enqueuer that turns the planner
   *  output into BullMQ recompile + delete jobs. When undefined the
   *  forget endpoint returns 503 (composition-incomplete). The route
   *  awaits the enqueue so transport failures surface as 5xx (audit
   *  row was already written — operator can correlate via the
   *  audit log on retry). */
  readonly forgetJobEnqueuer?: (args: ForgetJobEnqueueArgs) => Promise<void>;
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
             b.config,
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
        config: Record<string, unknown> | null;
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
        config: r.config ?? {},
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

      // PR-Z3 (phase-a appendix #12) — closes G6.
      // Enqueue an immediate scan so the partner sees content
      // without waiting for the 4h cron tick. The scanner picks up
      // the binding via SELECT (the existing scanner enumerates all
      // bindings on each tick + dedupes via cursor / source_doc_id).
      // No payload needed — `ingestion.scanner` jobs are markers
      // (`webhook-receiver.ts:644` and the cron tick both enqueue
      // empty payloads + the scanner worker re-scans every enabled
      // binding).
      //
      // When PR-Z2 lands its `SourceAdapter.seed()` primitive, the
      // scanner internally dispatches seed-vs-scan based on
      // `last_scan_cursor === null`. PR-Z3 doesn't need to know about
      // seed — just enqueue.
      //
      // Best-effort: a transport failure must not roll back the
      // binding row (the operator already saw 201, the binding is
      // already live, the next 4h cron tick still picks it up).
      // We log + continue.
      if (args.ingestionQueue?.add !== undefined) {
        try {
          // NOTE: scanner currently scans all enabled bindings per tick;
          // the empty payload is intentional. Threading bindingId through
          // scanner.add() to scope a single scan is a follow-up (filed
          // as Z10 / phase-b candidate). The dedupe pipeline keeps this
          // correct — extra bindings re-scanned by the same tick fall
          // out via source_doc_id + cursor dedupe — but it is mildly
          // confusing operator UX worth tightening later.
          await args.ingestionQueue.add(
            "post-create-scan",
            {},
            {
              jobId: `post-create-scan-${id}`,
              removeOnComplete: 10,
              removeOnFail: 100,
            },
          );
        } catch (err) {
          // Route through `safeErrorMessage` (scrub-then-cap) rather
          // than `err.name` — `err.name` is almost always "Error" and
          // not actionable. THREAT-MODEL §3 invariant: logged error
          // bytes are scrubbed before they hit the structured log.
          req.log?.warn({
            msg: "binding_create.initial_scan_enqueue_failed",
            binding_id: id,
            err: safeErrorMessage(err),
          });
        }
      }

      return reply.code(201).send({ id });
    },
  );

  // PR-Z3 (phase-a appendix #12) — `Scan now` on-demand scanner
  // dispatch. Closes G8 (operator wanting to verify a binding works
  // currently has to wait 4h for the cron OR shell into the box).
  //
  // Mirrors the existing PATCH/DELETE/forget pattern on this same
  // route file: CSRF-gated, admin-team-gated (via the wrapper in
  // index.ts), audit-row-emitting, no new credential surface.
  //
  // Unlike the agents `dispatch_now` route (agents-dispatch.ts), this
  // endpoint does NOT rate-limit in v0.1 — operators iterate fast
  // when binding a new source and the scanner enqueue is cheap (it
  // sets a marker, the worker dedupes downstream). A per-binding
  // cooldown is parked at v0.2 per the wave-12 scoping doc.
  args.app.post(
    "/api/admin/source-bindings/:id/scan-now",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }

      // Composition gate — the scanner queue must be wired.
      // Returns 503 if undefined, matching the rest of the admin
      // API's boot-tolerance pattern (forgetJobEnqueuer, deleteCap).
      // NOTE: hold the queue reference, NOT a detached `queue.add`
      // bound function — BullMQ's `Queue.add` reads `this.trace`
      // internally and throws "Cannot read properties of undefined
      // (reading 'trace')" when called with a lost receiver. Hotfix
      // PR-Y1 (phase-a-followup) — observed on partner cutover.
      const queue = args.ingestionQueue;
      if (queue?.add === undefined) {
        return reply.code(503).send({
          error: "scanner_queue_unavailable",
          reason:
            "Composition did not register a writable ingestion queue — check engine logs for `production_context` failures",
        });
      }

      // Verify the binding exists + is enabled.
      const existing = (await args.db.execute(sql`
        SELECT enabled
        FROM sources_bindings
        WHERE id = ${id}::uuid
        LIMIT 1
      `)) as unknown as { rows: Array<{ enabled: boolean }> };
      const row = existing.rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }
      if (!row.enabled) {
        // 409 mirrors the binding-disabled signal the operator's UI
        // already handles for other endpoints (e.g. the enabled-flip
        // PATCH). The scanner skips disabled bindings on its own
        // tick, so enqueuing here would be wasted.
        return reply.code(409).send({
          error: "binding_disabled",
          id,
        });
      }

      // Distinct jobId per click so back-to-back operator clicks
      // each fire (the route does NOT rate-limit in v0.1).
      // `Date.now()` alone has ms precision — fine for human clicks
      // but a programmatic burst (curl loop, test script) can fire
      // two requests inside the same ms and collide. Append a
      // short random suffix to harden against that without adding
      // a real dep. PR-Z3 code-quality review #1.
      const jobId = `scan-now-${id}-${Date.now()}-${randomBytes(3).toString("hex")}`;

      // Audit BEFORE enqueue (audit-before-side-effect invariant —
      // a partial enqueue still leaves a forensic trail). The audit
      // row carries the binding_id + caller_username; NEVER any
      // operator-supplied freeform text (the route has none to
      // smuggle — UUID URL param + no body).
      await writeAuditLog(args.db, {
        action: "source_binding.scan_now",
        userId: ctx.userId,
        metadata: {
          binding_id: id,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      try {
        // NOTE: scanner currently scans all enabled bindings per tick;
        // the empty payload is intentional. Threading bindingId through
        // scanner.add() to scope a single scan is a follow-up (filed as
        // Z10 / phase-b candidate). The dedupe pipeline keeps this
        // correct (cursor + source_doc_id), but a per-binding tick
        // would be the cleaner operator UX.
        await queue.add(
          "scan-now",
          {},
          {
            jobId,
            removeOnComplete: 10,
            removeOnFail: 100,
          },
        );
      } catch (err) {
        // Route through `safeErrorMessage` (scrub-then-cap) rather
        // than `err.name` — `err.name` is almost always "Error" and
        // not actionable. Matches the response body's `reason` field
        // (which already uses `safeErrorMessage`) so the log and the
        // 500 response carry the same scrubbed string.
        req.log?.warn({
          msg: "binding_scan_now.enqueue_failed",
          binding_id: id,
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

  // PR-Q10 — toggle `enabled`. PR-R2 widens this surface with two
  // additional intents: `{config}` and `{credentials}`. The body is
  // a discriminated union — exactly one intent per request so the
  // audit trail records one verb per action. The `enabled` path is
  // unchanged in behavior; the two new paths each emit their own
  // audit-action verb.
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

      // `enabled` branch — Q10 behavior, unchanged.
      if ("enabled" in parsed.data) {
        return handleEnabledPatch({
          db: args.db,
          req,
          reply,
          id,
          enabled: parsed.data.enabled,
          ctx,
        });
      }

      // `config` branch — operational settings update.
      if ("config" in parsed.data) {
        return handleConfigPatch({
          db: args.db,
          req,
          reply,
          id,
          submittedConfig: parsed.data.config,
          ctx,
        });
      }

      // `credentials` branch — in-place credential rotation.
      return handleCredentialsPatch({
        db: args.db,
        req,
        reply,
        id,
        submittedCredentials: parsed.data.credentials,
        credentialStore: args.credentialStore,
        ctx,
      } satisfies CredentialsPatchArgs);
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

  // PR-R7 (phase-a appendix #10) — `source forget` impact preview +
  // gated execution. The Sources row drill-down's "Forget source"
  // button calls this twice:
  //
  //   • `?dryRun=1`         — read-only impact (recompile / delete /
  //                            citations / cap state). No side effects.
  //   • `?dryRun=0` or omitted — execute the forget: reserve the cap
  //                            budget, enqueue recompile + delete jobs,
  //                            audit `source_binding.forget` with COUNTS
  //                            (never path lists — paths can leak
  //                            operator-internal naming).
  //
  // Cap-exceeded path: when the planned deletes + today's used would
  // exceed the per-domain daily cap, return 409 `daily_cap_exceeded`
  // BEFORE the audit row + enqueue fire. The operator waits for the
  // cap to reset (next UTC midnight, by design — invariant 6).
  args.app.post(
    "/api/admin/source-bindings/:id/forget",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!z.string().uuid().safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }

      // Parse the dryRun flag. Default to actual execute (`dryRun=0`)
      // when the query string is absent — calling the endpoint is
      // already a deliberate operator action gated by the UI's
      // checkbox. The narrow accept-set (`'1'`/`'0'`/'true'/'false')
      // keeps the parse strict so a typo doesn't silently flip the
      // operator's intent.
      const rawDryRun = (req.query as { dryRun?: string }).dryRun;
      const dryRun =
        rawDryRun === "1" ||
        rawDryRun === "true" ||
        rawDryRun === "yes";

      // Plan the impact. Pure read-only — same query path used by
      // both dry-run and execute so two consecutive dry-runs return
      // identical output.
      const plan = await planForget({ db: args.db, bindingId: id });
      if ("notFound" in plan) {
        return reply.code(404).send({ error: "not_found", id });
      }

      // Read today's cap state (peek, no commit). Surfaced in BOTH
      // the dry-run response (so the operator sees today's budget)
      // AND the cap-exceeded 409 (so the UI can show how close the
      // operator is to the limit).
      const deleteCap = args.deleteCap;
      if (deleteCap === undefined) {
        return reply.code(503).send({
          error: "delete_cap_unavailable",
          reason: "Composition did not register a deleteCap",
        });
      }
      const now = new Date();
      const domainSlug = plan.domainSlug as DomainSlug;
      const capState = deleteCap.peek(domainSlug, now);
      const plannedDeletes = plan.pagesDeleted.length;

      if (dryRun) {
        return reply.code(200).send({
          pagesRecompiled: plan.pagesRecompiled,
          pagesDeleted: plan.pagesDeleted,
          citationsRemoved: plan.citationsRemoved,
          dailyDeleteCapState: capState,
        });
      }

      // Execute path. Reserve-before-enqueue: a cap-exceeded reserve
      // throws (caught below → 409) before the enqueue fires, so a
      // refused forget never leaves a partial state behind.
      const enqueuer = args.forgetJobEnqueuer;
      if (enqueuer === undefined) {
        return reply.code(503).send({
          error: "forget_enqueuer_unavailable",
          reason: "Composition did not register a forgetJobEnqueuer",
        });
      }

      // Cap-exceeded preflight: surface 409 when the planned deletes
      // would exceed today's budget. We check here so the response
      // body carries the cap state at the moment of refusal (helps
      // the operator decide whether to wait or come back tomorrow).
      // The reserve below would also throw, but its error message
      // doesn't carry the {used,cap} pair the UI needs to render.
      if (capState.used + plannedDeletes > capState.cap) {
        return reply.code(409).send({
          error: "daily_cap_exceeded",
          dailyDeleteCapState: capState,
        });
      }

      // Reserve the cap budget. Reserves only the deletes — the
      // recompiles consume the LLM budget separately, not the wiki-
      // write delete cap.
      try {
        if (plannedDeletes > 0) {
          deleteCap.reserve(domainSlug, plannedDeletes, now);
        }
      } catch (err) {
        // Defensive: a concurrent reserve between our peek and our
        // reserve could push us over the cap. Surface the same 409
        // shape so the UI handles it identically.
        req.log?.warn({
          msg: "binding_forget.cap_reserve_failed",
          binding_id: id,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(409).send({
          error: "daily_cap_exceeded",
          dailyDeleteCapState: deleteCap.peek(domainSlug, now),
        });
      }

      // Audit BEFORE enqueue (audit-before-side-effect invariant —
      // a partial enqueue still leaves an audit trail). Metadata
      // carries COUNTS only; path lists never reach the audit
      // surface (THREAT-MODEL §3.13 — operator-internal naming
      // can leak via wiki paths).
      const capAfter = deleteCap.peek(domainSlug, now);
      await writeAuditLog(args.db, {
        action: "source_binding.forget",
        userId: ctx.userId,
        metadata: {
          binding_id: id,
          slug: plan.domainSlug,
          pages_recompiled: plan.pagesRecompiled.length,
          pages_deleted: plan.pagesDeleted.length,
          citations_removed: plan.citationsRemoved,
          cap_used_before: capState.used,
          cap_used_after: capAfter.used,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      // Enqueue. Awaited so transport failures surface as 5xx; the
      // audit row already exists so the operator can retry idempotently
      // (re-running forget on the same binding-id with no remaining
      // citations is a no-op — the planner returns empty lists).
      try {
        await enqueuer({
          bindingId: id,
          domainSlug: plan.domainSlug,
          pagesRecompiled: plan.pagesRecompiled,
          pagesDeleted: plan.pagesDeleted,
          callerUsername: ctx.username,
        });
      } catch (err) {
        req.log?.warn({
          msg: "binding_forget.enqueue_failed",
          binding_id: id,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(500).send({ error: "enqueue_failed" });
      }

      return reply.code(200).send({
        pagesRecompiled: plan.pagesRecompiled,
        pagesDeleted: plan.pagesDeleted,
        citationsRemoved: plan.citationsRemoved,
        dailyDeleteCapState: capAfter,
      });
    },
  );
}

// ─── PR-R2: PATCH discriminator handlers ───────────────────────────────────

interface EnabledPatchArgs {
  readonly db: Db;
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly id: string;
  readonly enabled: boolean;
  readonly ctx: AdminContext;
}

/** Q10's `enabled`-only behavior, factored into a helper so the
 *  PATCH route can dispatch by intent. The semantics are unchanged:
 *  the UPDATE always runs (so a no-op flip still records the
 *  operator's intent in the audit row). */
async function handleEnabledPatch(
  args: EnabledPatchArgs,
): Promise<FastifyReply> {
  const existing = (await args.db.execute(sql`
    SELECT enabled
    FROM sources_bindings
    WHERE id = ${args.id}::uuid
    LIMIT 1
  `)) as unknown as { rows: Array<{ enabled: boolean }> };
  const prev = existing.rows[0];
  if (prev === undefined) {
    return args.reply.code(404).send({ error: "not_found", id: args.id });
  }

  const updated = (await args.db.execute(sql`
    UPDATE sources_bindings
    SET enabled = ${args.enabled},
        updated_at = NOW()
    WHERE id = ${args.id}::uuid
    RETURNING id::text AS id, enabled
  `)) as unknown as { rows: Array<{ id: string; enabled: boolean }> };
  const row = updated.rows[0];
  if (row === undefined) {
    return args.reply.code(500).send({ error: "update_returned_no_row" });
  }

  await writeAuditLog(args.db, {
    action: "source_binding.update",
    userId: args.ctx.userId,
    metadata: {
      binding_id: args.id,
      prev_enabled: prev.enabled,
      new_enabled: args.enabled,
      caller_username: args.ctx.username,
    },
    sourceIp: args.req.ip,
    userAgent: args.req.headers["user-agent"],
  });

  return args.reply.code(200).send({ id: row.id, enabled: row.enabled });
}

interface ConfigPatchArgs {
  readonly db: Db;
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly id: string;
  readonly submittedConfig: Record<string, unknown>;
  readonly ctx: AdminContext;
}

/** PR-R2 `config`-only path. Validates the submitted config against
 *  the binding's adapter-declared `bindingConfigSchema`, then persists
 *  it in jsonb. The audit row records the binding_id, the caller, and
 *  KEY LISTS only — never values. Operational-config values may
 *  include operator-internal IDs that, while not secret, are out of
 *  scope for the audit-row contract (THREAT-MODEL §3.13: audit rows
 *  capture intent + identity; payload bytes belong elsewhere). */
async function handleConfigPatch(
  args: ConfigPatchArgs,
): Promise<FastifyReply> {
  // Look up the binding's adapter slug + previous config (for the
  // audit row's prev_config_keys list).
  const existing = (await args.db.execute(sql`
    SELECT adapter_slug, config
    FROM sources_bindings
    WHERE id = ${args.id}::uuid
    LIMIT 1
  `)) as unknown as {
    // jsonb may be null when the column is missing a default — `prev.config ?? {}`
    // below handles the runtime branch. Tightening the type to `... | null`
    // documents reality.
    rows: Array<{
      adapter_slug: string;
      config: Record<string, unknown> | null;
    }>;
  };
  const prev = existing.rows[0];
  if (prev === undefined) {
    return args.reply.code(404).send({ error: "not_found", id: args.id });
  }

  const bindingConfigSchema = getSourceAdapterBindingConfigSchema(
    prev.adapter_slug,
  );
  if (bindingConfigSchema === undefined) {
    return args.reply.code(422).send({
      error: "binding_config_schema_unavailable",
      adapter_slug: prev.adapter_slug,
    });
  }

  const configValidation = validateBindingConfigAgainstSchema(
    args.submittedConfig,
    bindingConfigSchema,
  );
  if (!configValidation.ok) {
    return args.reply.code(422).send({
      error: "binding_config_schema_mismatch",
      missing: configValidation.missing,
    });
  }

  // jsonb codec receives well-formed text — same trick as POST.
  const configJson = JSON.stringify(args.submittedConfig);
  const updated = (await args.db.execute(sql`
    UPDATE sources_bindings
    SET config = ${configJson}::jsonb,
        updated_at = NOW()
    WHERE id = ${args.id}::uuid
    RETURNING id::text AS id
  `)) as unknown as { rows: Array<{ id: string }> };
  const row = updated.rows[0];
  if (row === undefined) {
    return args.reply.code(500).send({ error: "update_returned_no_row" });
  }

  // Sorted key lists — audit metadata never carries values.
  const prevConfigKeys = Object.keys(prev.config ?? {}).sort();
  const newConfigKeys = Object.keys(args.submittedConfig).sort();

  await writeAuditLog(args.db, {
    action: "source_binding.config_update",
    userId: args.ctx.userId,
    metadata: {
      binding_id: args.id,
      prev_config_keys: prevConfigKeys,
      new_config_keys: newConfigKeys,
      caller_username: args.ctx.username,
    },
    sourceIp: args.req.ip,
    userAgent: args.req.headers["user-agent"],
  });

  return args.reply.code(200).send({ id: row.id });
}

interface CredentialsPatchArgs {
  readonly db: Db;
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly id: string;
  readonly submittedCredentials: {
    readonly auth?: unknown;
    readonly webhook_secret?: unknown;
  };
  readonly credentialStore: CredentialStore | undefined;
  readonly ctx: AdminContext;
}

/** PR-R2 `credentials`-only path. In-place rotation via
 *  `CredentialStore.rotate(id, plaintext)` — the binding's
 *  `credentials_id` (and `webhook_secret_credentials_id`) is preserved;
 *  only the underlying credential row's plaintext + IV + rotated_at
 *  change.
 *
 *  PR-R2 review fix-up — webhook adapters now rotate the
 *  `webhook_secret_credentials_id` row when the body includes a
 *  `webhook_secret` half. Either half is optional so the operator can
 *  rotate just one. Polling adapters reject `webhook_secret` with 422
 *  `webhook_secret_not_supported`; an empty `{credentials: {}}` is
 *  rejected with 422 `credentials_empty`.
 *
 *  Audit metadata records `rotated_credentials: { auth, webhook_secret }`
 *  mapping each rotated half to its `credentials.id` (or null when not
 *  rotated). Plaintext NEVER appears in the metadata
 *  (THREAT-MODEL §3.13). */
async function handleCredentialsPatch(
  args: CredentialsPatchArgs,
): Promise<FastifyReply> {
  const existing = (await args.db.execute(sql`
    SELECT adapter_slug,
           credentials_id::text AS credentials_id,
           webhook_secret_credentials_id::text AS webhook_secret_credentials_id
    FROM sources_bindings
    WHERE id = ${args.id}::uuid
    LIMIT 1
  `)) as unknown as {
    rows: Array<{
      adapter_slug: string;
      credentials_id: string | null;
      webhook_secret_credentials_id: string | null;
    }>;
  };
  const prev = existing.rows[0];
  if (prev === undefined) {
    return args.reply.code(404).send({ error: "not_found", id: args.id });
  }

  const descriptor = getSourceAdapterDescriptor(prev.adapter_slug);
  if (descriptor === undefined) {
    return args.reply.code(422).send({
      error: "unknown_adapter_slug",
      adapter_slug: prev.adapter_slug,
    });
  }

  const credValidation = validateCredentialsForRotation(
    args.submittedCredentials,
    descriptor,
  );
  if (!credValidation.ok) {
    // Path-only diagnostic — never echoes the rejected values.
    if (credValidation.code === "credential_schema_mismatch") {
      return args.reply.code(422).send({
        error: "credential_schema_mismatch",
        missing: credValidation.missing,
      });
    }
    return args.reply.code(422).send({ error: credValidation.code });
  }

  if (prev.credentials_id === null) {
    // Bindings created before the credentials_id contract landed
    // (or hand-INSERTed test rows without a credentials row) cannot
    // be rotated — there is no plaintext slot to replace. Surface
    // a structured 422 so the operator knows to recreate the binding.
    return args.reply.code(422).send({
      error: "binding_has_no_credentials",
    });
  }

  if (args.credentialStore === undefined) {
    return args.reply.code(500).send({
      error: "credential_store_unavailable",
      reason: "Composition did not register a credentialStore",
    });
  }

  // Webhook-secret rotation requires the binding to have a
  // `webhook_secret_credentials_id` row. Today every webhook adapter
  // populates this on create, but a hand-INSERTed test row without it
  // would otherwise drop the rotation silently — surface a structured
  // 422 so the operator knows to recreate the binding.
  if (
    credValidation.hasWebhookSecret &&
    prev.webhook_secret_credentials_id === null
  ) {
    return args.reply.code(422).send({
      error: "binding_has_no_webhook_secret",
    });
  }

  const credentialsId = prev.credentials_id as CredentialId;
  const webhookSecretId =
    prev.webhook_secret_credentials_id === null
      ? null
      : (prev.webhook_secret_credentials_id as CredentialId);

  // Track which credential ids were actually rotated. Audit metadata
  // records `rotated_credentials: { auth, webhook_secret }` so the
  // operator can later confirm which half was rotated. `null` =
  // not rotated this request (load-bearing for the audit contract).
  let rotatedAuthId: CredentialId | null = null;
  let rotatedWebhookSecretId: CredentialId | null = null;

  try {
    if (credValidation.hasAuth) {
      // Polling: `auth` half IS the flat credentials object the
      // schema describes; the credential row stores the same shape
      // POST writes (the full object).
      // Webhook: `auth` half is the auth sub-object specifically.
      const authPlaintext = narrowAuthCredentials(args.submittedCredentials);
      await args.credentialStore.rotate(
        credentialsId,
        Buffer.from(JSON.stringify(authPlaintext), "utf8"),
      );
      rotatedAuthId = credentialsId;
    }
    if (credValidation.hasWebhookSecret && webhookSecretId !== null) {
      const webhookSecretPlaintext = narrowWebhookSecretCredentials(
        args.submittedCredentials,
      );
      await args.credentialStore.rotate(
        webhookSecretId,
        Buffer.from(JSON.stringify(webhookSecretPlaintext), "utf8"),
      );
      rotatedWebhookSecretId = webhookSecretId;
    }
  } catch (err) {
    args.req.log?.warn({
      msg: "binding_rotate.credential_store_failed",
      binding_id: args.id,
      err: err instanceof Error ? err.name : "unknown",
    });
    return args.reply.code(500).send({ error: "credential_rotate_failed" });
  }

  await args.db.execute(sql`
    UPDATE sources_bindings
    SET updated_at = NOW()
    WHERE id = ${args.id}::uuid
  `);

  await writeAuditLog(args.db, {
    action: "source_binding.credentials_rotate",
    userId: args.ctx.userId,
    metadata: {
      binding_id: args.id,
      rotated_credentials: {
        auth: rotatedAuthId,
        webhook_secret: rotatedWebhookSecretId,
      },
      caller_username: args.ctx.username,
    },
    sourceIp: args.req.ip,
    userAgent: args.req.headers["user-agent"],
  });

  // `credentialsRotatedAt`: query the actual `credentials.rotated_at`
  // for whichever halves rotated. If both rotated, surface the max so
  // the timestamp reflects the latest write. Falls back to "now" on a
  // read failure (defensive — the rotation already succeeded). */
  const credentialsRotatedAt =
    (await readMaxRotatedAt(args.db, [
      rotatedAuthId,
      rotatedWebhookSecretId,
    ])) ?? new Date().toISOString();

  return args.reply.code(200).send({
    id: args.id,
    credentialsRotatedAt,
  });
}

/** Read `rotated_at` for one or more credential ids and return the
 *  max as ISO. `null` ids are skipped. Returns `null` on no rows or a
 *  read failure — caller falls back to the request timestamp. */
async function readMaxRotatedAt(
  db: Db,
  ids: ReadonlyArray<CredentialId | null>,
): Promise<string | null> {
  const present = ids.filter((id): id is CredentialId => id !== null);
  if (present.length === 0) return null;
  try {
    const result = (await db.execute(sql`
      SELECT MAX(rotated_at) AS rotated_at
      FROM credentials
      WHERE id = ANY(ARRAY[${sql.join(
        present.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}])
    `)) as unknown as {
      rows: Array<{ rotated_at: Date | string | null }>;
    };
    const row = result.rows[0];
    if (row === undefined) return null;
    return toIso(row.rotated_at);
  } catch {
    return null;
  }
}

/** Narrow `submittedCredentials.auth` to a concrete object shape.
 *  The validator already passed by the time we reach here; this
 *  predicate documents intent (replacing an opaque `as` cast) and
 *  defends against a shape regression introduced upstream. */
function narrowAuthCredentials(
  submitted: { readonly auth?: unknown; readonly webhook_secret?: unknown },
): Record<string, unknown> {
  const value = submitted.auth;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invariant: auth half passed validation but is not an object");
  }
  return value as Record<string, unknown>;
}

/** Narrow `submittedCredentials.webhook_secret` to a concrete object
 *  shape. Same intent-documenting predicate as `narrowAuthCredentials`. */
function narrowWebhookSecretCredentials(
  submitted: { readonly auth?: unknown; readonly webhook_secret?: unknown },
): Record<string, unknown> {
  const value = submitted.webhook_secret;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "invariant: webhook_secret half passed validation but is not an object",
    );
  }
  return value as Record<string, unknown>;
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

// `isPgForeignKeyViolation` lives in `../pg-error.ts` — hoisted from this
// file in PR-R1 so the Domain DELETE handler can share the same narrowing.

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

/** Result of a rotation-mode credentials validation. The discriminator
 *  surfaces specific 422 failure modes so the caller emits a precise
 *  error code (`webhook_secret_not_supported`, `credentials_empty`,
 *  `credential_schema_mismatch`).
 *
 *  Path-only diagnostics — the validator never echoes submitted
 *  values into the result so a 422 response can never leak secret
 *  bytes (THREAT-MODEL §3.13). */
type RotationCredValidation =
  | { readonly ok: true; readonly hasAuth: boolean; readonly hasWebhookSecret: boolean }
  | { readonly ok: false; readonly code: "webhook_secret_not_supported" }
  | { readonly ok: false; readonly code: "credentials_empty" }
  | { readonly ok: false; readonly code: "credential_schema_mismatch"; readonly missing: string[] };

/** PR-R2 review fix-up — validate a partial-rotation `credentials`
 *  body. EITHER half (auth, webhook_secret) is optional, but at
 *  least one must be present. Polling adapters reject any
 *  `webhook_secret` half. The submitted half(ves) are validated
 *  against the corresponding sub-schema. */
function validateCredentialsForRotation(
  credentials: { readonly auth?: unknown; readonly webhook_secret?: unknown },
  descriptor: SourceAdapterCredentialDescriptor,
): RotationCredValidation {
  const hasAuth = credentials.auth !== undefined;
  const hasWebhookSecret = credentials.webhook_secret !== undefined;

  // No-op rotation is meaningless — reject so the audit row never
  // records an action that didn't change anything.
  if (!hasAuth && !hasWebhookSecret) {
    return { ok: false, code: "credentials_empty" };
  }

  // Polling adapters have no webhook_secret half — reject before
  // we walk the schema so the operator gets the specific code.
  if (descriptor.mode === "polling" && hasWebhookSecret) {
    return { ok: false, code: "webhook_secret_not_supported" };
  }

  const missing: string[] = [];

  if (descriptor.mode === "polling") {
    // Polling: `auth` half is the flat credentials object the
    // schema describes; we walk the polling schema directly.
    const authValue = credentials.auth;
    if (typeof authValue !== "object" || authValue === null) {
      missing.push("auth");
    } else {
      walkPollingSchema(
        descriptor.credentialSchema,
        authValue as Record<string, unknown>,
        "auth.",
        missing,
      );
    }
  } else {
    if (hasAuth) {
      const authValue = credentials.auth;
      if (typeof authValue !== "object" || authValue === null) {
        missing.push("auth");
      } else {
        walkPollingSchema(
          descriptor.credentialSchema.properties.auth,
          authValue as Record<string, unknown>,
          "auth.",
          missing,
        );
      }
    }
    if (hasWebhookSecret) {
      const webhookSecretValue = credentials.webhook_secret;
      if (typeof webhookSecretValue !== "object" || webhookSecretValue === null) {
        missing.push("webhook_secret");
      } else {
        walkPollingSchema(
          descriptor.credentialSchema.properties.webhook_secret,
          webhookSecretValue as Record<string, unknown>,
          "webhook_secret.",
          missing,
        );
      }
    }
  }

  if (missing.length > 0) {
    return { ok: false, code: "credential_schema_mismatch", missing };
  }
  return { ok: true, hasAuth, hasWebhookSecret };
}

/** Validate credentials against the adapter's descriptor. Walks
 *  required fields without mentioning the field VALUES — only
 *  paths come back so a 422 response can never leak partial
 *  secret bytes. Used by the binding-create path, which still
 *  requires BOTH halves on every webhook adapter. */
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
