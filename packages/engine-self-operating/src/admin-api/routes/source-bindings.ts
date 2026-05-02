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
import { scrubPat } from "@opencoo/shared/scrub";
import {
  defaultReviewModeFor,
  getSourceAdapterDescriptor,
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
          ? scrubPat(r.latest_error_class).slice(0, 200)
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
        const inserted = (await args.db.execute(sql`
          INSERT INTO sources_bindings
            (domain_id, adapter_slug, review_mode, credentials_id, webhook_secret_credentials_id)
          VALUES (
            ${domain.id}::uuid,
            ${adapter_slug},
            ${sql.raw(`'${effectiveReviewMode}'`)}::review_mode,
            ${credentialsId}::uuid,
            ${webhookSecretSql}
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
