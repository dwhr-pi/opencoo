/**
 * Append-only audit-log writer for the admin API (PR 28 / plan
 * #128, THREAT-MODEL §3.13 + §2 invariant 8).
 *
 * Every state-changing route writes ONE row BEFORE returning a
 * response. That ordering means a partial write that crashes
 * mid-flight still leaves an audit trail; the operator triages
 * the crash separately, knowing the action was attempted.
 *
 * `action` is constrained to the allowlist literal below — the
 * Zod parse rejects anything not in the set. Adding an action
 * verb requires a code change here, which is the right blast
 * radius for an auditable surface.
 *
 * The `adminAuditLog` table is APPEND-ONLY per the
 * `opencoo/no-update-append-only` ESLint rule — this writer
 * only INSERTs, never UPDATEs.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import { adminAuditLog } from "@opencoo/shared/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Closed set of audit-log action verbs. The Zod schema
 * `.refine`s against this list — the writer rejects any other
 * action string. Updating the list is intentional; an audit
 * surface that accepts free-form text is one CSRF away from
 * flooding the table with fake events.
 */
export const AUDIT_LOG_ACTIONS = [
  // Source-binding queue actions.
  "source_binding.review.approve",
  "source_binding.review.reject",
  // Lint-finding triage.
  "lint_finding.acknowledge",
  // Automation candidate actions (Surfacer → Builder gate).
  "automation_candidate.approve",
  "automation_candidate.reject",
  // Marketplace updates.
  "marketplace_update.accept",
  "marketplace_update.skip",
  // Domain LLM-policy edits — the PR 29 sovereignty-diff
  // confirm flow records one row per applied change.
  "domain.llm_policy.apply",
  // Phase-a appendix #2 — domain create + binding create flows
  // (POST /api/admin/domains, POST /api/admin/source-bindings).
  // Metadata captures slug + class + provisioned repo URL +
  // caller username; PAT bytes NEVER recorded.
  "domain.create",
  "source_binding.create",
  // Phase-a appendix #9 (PR-Q10) — Sources row drill-down
  // actions. `update` covers `enabled` toggles via PATCH; `delete`
  // covers binding teardown via DELETE. Metadata captures binding_id
  // + caller_username + (for update) the prev/new enabled flag.
  "source_binding.update",
  "source_binding.delete",
  // Phase-a appendix #10 (PR-R2) — Sources binding edit:
  // operational-config update + in-place credential rotation.
  // Metadata captures binding_id + caller_username + KEY LISTS
  // for `config_update` (never values), and binding_id +
  // credentials_id + caller_username for `credentials_rotate`
  // (NEVER plaintext or parsed credential fields).
  "source_binding.config_update",
  "source_binding.credentials_rotate",
  // Phase-a appendix #10 (PR-R7) — Sources `forget` impact-preview-
  // gated forget. Metadata captures binding_id + slug +
  // {pages_recompiled, pages_deleted, citations_removed} as COUNTS
  // (never path lists — paths can leak operator-internal naming),
  // plus the cap state before/after the action and caller_username.
  // Only the actual-forget path (`?dryRun=0`) writes audit; the
  // dry-run preview is read-only and writes nothing.
  "source_binding.forget",
  // Phase-a appendix #12 (PR-Z3) — Sources `Scan now` on-demand
  // scanner dispatch. Metadata captures binding_id + caller_username
  // ONLY (no payload — the URL param is the binding UUID + the body
  // is empty). NEVER any operator-supplied freeform text
  // (THREAT-MODEL §3.13). Audit row is written BEFORE the BullMQ
  // enqueue so a partial enqueue still leaves a forensic trail.
  "source_binding.scan_now",
  // Phase-a appendix #14 (PR-W2) — Re-enqueue failed compile-classify
  // jobs for a binding. After W1 lands and the operator backfills
  // `allowed_paths`, the BullMQ jobs in the `ingestion.scanner.classify`
  // failed-set are stale (they failed against the old config). This
  // route enumerates those failed jobs (filtered by payload bindingId
  // and optionally intakeId) and re-enqueues each as a fresh job.
  // Metadata captures binding_id + target_count + caller_username +
  // (when scoped) intake_id. NEVER any operator-supplied freeform
  // text — the URL params are bounded (UUID + optional UUID-like
  // intakeId from the W4 panel) and the body is empty. Audit row is
  // written BEFORE the re-enqueue calls so a partial enqueue still
  // leaves a forensic trail (mirrors PR-Z3 scan_now invariant).
  // `target_count` (NOT `retried_count`) names the field accurately:
  // the value is captured BEFORE the enqueue loop runs so it reflects
  // operator INTENT — how many failed jobs were enumerated and planned
  // for re-enqueue. On a partial transport failure mid-loop the HTTP
  // response's `retriedCount` reports the actual completed count;
  // operators cross-referencing the audit log against BullMQ state
  // should expect `target_count >= actual retried`. Copilot review
  // #131 (id 3230502111).
  "source_binding.retry_failed",
  // Phase-a appendix #14 (PR-W1) — `allowed_paths` operator-side
  // edit. The runtime classifier guard (`assertBindingNotWildcardOnly`)
  // rejects empty/wildcard-only arrays; this PATCH branch lets the
  // operator fix an existing binding via the UI instead of dropping
  // to SQL. Metadata captures binding_id + caller_username + the
  // prev_allowed_paths and new_allowed_paths arrays so the audit
  // trail records exactly which subtree-globs were swapped (these
  // are operator-controlled config, not credentials — recording
  // them is operationally useful and never leaks secrets). The
  // audit row is written AFTER the UPDATE because the route uses
  // pg's `RETURNING` to confirm the row existed; a non-existent
  // binding fails BEFORE the audit row and BEFORE any side effect,
  // matching the source_binding.config_update / set_enabled pattern.
  "source_binding.set_allowed_paths",
  // Phase-a appendix #10 (PR-R1) — Domains tab drill-down
  // actions. `update` covers PATCH (display_name / locale /
  // is_aggregator); `disable` covers DELETE (soft-delete);
  // `delete` covers DELETE `?hard=1` (hard-delete). Metadata
  // captures id + slug + caller_username + (for update) the
  // changed field NAMES (never values), and for delete the
  // `binding_count` so the audit trail reflects whether bindings
  // blocked the action.
  "domain.update",
  "domain.disable",
  "domain.delete",
  // PR-W1 (phase-a appendix #13) — on-demand worldview recompile
  // (POST /api/admin/domains/:slug/recompile-worldview). Metadata
  // captures domain_id + slug + trigger_type (`manual`) +
  // caller_username ONLY. NEVER any operator-supplied freeform text;
  // audit row is written BEFORE the BullMQ enqueue (audit-before-
  // side-effect invariant — a partial enqueue still leaves a
  // forensic trail).
  "domain.recompile_worldview",
  // Phase-a appendix #10 (PR-R3) — on-demand agent dispatch from
  // the management UI. Metadata captures agent_slug + domain_slug +
  // instance_slug + instance_id + dry_run + caller_username.
  // `job_id` is NOT recorded because the audit row is written BEFORE
  // the BullMQ enqueue (audit-before-enqueue invariant — the jobId
  // doesn't exist yet at write time). Operators correlate via
  // (caller_username, instance_id, created_at). NEVER any operator-
  // supplied freeform text (THREAT-MODEL §3.13).
  "agent.dispatch_now",
  // Phase-a appendix #10 (PR-R6) — scheduler / cadence editor.
  // PUT /api/admin/scheduler/:agent flips the cron pattern for every
  // instance scoped to the agent slug; the audit row captures
  // agent_slug + old_crons + new_cron + instance_count +
  // caller_username so an operator can replay the cadence-change
  // history without joining against agent_instances. `old_crons`
  // is an array (length === instance_count) of the cron string each
  // instance carried prior to the change, indexed by the same row
  // ordering the dispatcher's swap walked — a per-instance prior
  // value matters when instances of the same agent had drifted
  // cadences (e.g. two heartbeat instances with different schedules
  // before the operator pulled them back into lockstep). NEVER any
  // operator-supplied freeform text — both old + new cron strings
  // are server-validated via cron-parser BEFORE any side effect.
  // The audit row is written INSIDE the same db.transaction as the
  // schedule_cron UPDATE and the dispatcher's BullMQ swap; a throw
  // at the dispatcher step rolls EVERYTHING back, audit row
  // included — the operator never sees a "changed schedule" record
  // for an action that didn't actually change anything. The trail
  // matches the actual on-disk state (mirrors PR-Q10b's
  // source-binding delete pattern).
  "scheduler.update",
  // Phase-a appendix #12 PR-Z4 — Outputs tab CRUD. The
  // `output_channels` table backs operator-managed delivery
  // channels the AgentDispatcher reads from at post-run delivery.
  // Metadata captures channel_id + adapter_slug + name +
  // caller_username (for create / delete) and additionally the
  // changed_field NAMES + (for `enabled`) the new boolean for
  // update. Credentials NEVER appear in audit metadata — the
  // `credentials_rotate` row references the credential id, never
  // the plaintext.
  "output_channel.create",
  "output_channel.update",
  "output_channel.credentials_rotate",
  "output_channel.delete",
  // Phase-a appendix #13 PR-W2 — Agent-instance admin actions.
  // The new `/api/admin/agent-instances/:id` PATCH surface
  // splits into three intents; each emits ONE audit verb so the
  // operator's history reflects exactly which lever they pulled.
  //
  // `bind_outputs`  — replaces `agent_instances.output_channel_ids[]`.
  //                   Metadata: instance_id (binding_id),
  //                   output_channel_ids (UUID list only,
  //                   NEVER credential bytes or channel config),
  //                   caller_username.
  // `set_enabled`   — toggles `agent_instances.enabled`.
  //                   Metadata: instance_id (binding_id), the
  //                   new boolean, caller_username.
  // `set_schedule`  — sets `agent_instances.schedule_cron`. The
  //                   route validates via cron-parser BEFORE the
  //                   audit row so a garbage value can't leave
  //                   a misleading audit trail. Metadata:
  //                   instance_id (binding_id), the cron
  //                   string, caller_username.
  "agent_instance.bind_outputs",
  "agent_instance.set_enabled",
  "agent_instance.set_schedule",
  // PR-W2 (phase-a appendix #15) — per-(domain, instance) prompt
  // overrides. `apply` records every UPSERT into prompt_overrides
  // via the sovereignty-token confirm flow; `delete` records every
  // operator revert that drops the override row.
  //
  // `apply` metadata captures `scope` ('domains' | 'agent-instances'),
  // `scope_id` (UUID), `name` (prompt name), `locale`,
  // `baseline_version` (the shipped version the override was forked
  // from at apply time), and `payload_hash` (SHA-256 of the
  // body+baselineVersion canonical form).
  //
  // `delete` metadata captures the same `scope` / `scope_id` /
  // `name` / `locale` always, and ADDITIONALLY captures the
  // departing row's `overrides_version`, `baseline_version`, and
  // `payload_hash` WHEN a row was found at SELECT-before-DELETE
  // time. A no-op delete (idempotent revert against an
  // already-baseline scope) records only the four scope fields —
  // the conditional metadata makes the audit trail informative
  // without inventing fields for the empty case.
  //
  // The body itself NEVER enters the audit table — the
  // `payload_hash` reference is enough to prove the operator's
  // intent without persisting the LLM-input bytes through audit.
  "prompt_override.apply",
  "prompt_override.delete",
  // Logout — records the operator-initiated session-end so an
  // audit-log read can correlate an action burst with the
  // operator's session window.
  "session.logout",
  // Read-only audit-log access — scope-checked but recorded
  // anyway so an operator-pulling-history pattern is itself
  // visible to the next reviewer.
  "audit_log.read",
] as const;

export type AuditAction = (typeof AUDIT_LOG_ACTIONS)[number];

const auditWriteSchema = z.object({
  action: z.enum(AUDIT_LOG_ACTIONS),
  userId: z.string().uuid(),
  metadata: z.record(z.string(), z.unknown()),
  sourceIp: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

export interface WriteAuditLogArgs {
  readonly action: AuditAction;
  readonly userId: string;
  readonly metadata: Record<string, unknown>;
  readonly sourceIp?: string | null;
  /** Accepts the raw shape Fastify hands callers via
   *  `req.headers["user-agent"]` — string | string[] (rare,
   *  duplicated headers) | undefined. Normalised + truncated
   *  internally. The explicit `undefined` is required under
   *  `exactOptionalPropertyTypes: true` so callers can pass a
   *  header value that may legitimately be missing. */
  readonly userAgent?: string | readonly string[] | null | undefined;
}

/** Normalise + truncate the User-Agent header. Accepts the raw
 *  Fastify shape (string | string[] | undefined): picks the
 *  first entry from an array (some upstreams send duplicate
 *  headers), then caps at 256 BYTES (UTF-8) — JS string length
 *  counts UTF-16 code units, so we walk codepoints and accumulate
 *  byte length. Operators don't need the full forensic trail and
 *  an attacker-supplied UA shouldn't blow the row size. */
function truncateUserAgent(
  ua: string | readonly string[] | null | undefined,
): string | null {
  const value = Array.isArray(ua) ? ua[0] : ua;
  if (typeof value !== "string") return null;
  if (Buffer.byteLength(value, "utf8") <= 256) return value;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (used + chBytes > 256) break;
    out += ch;
    used += chBytes;
  }
  return out;
}

/**
 * Insert one audit-log row. Returns the inserted row id so
 * callers can include it in the response (handy for ops triage:
 * "the action you took has audit id X").
 *
 * NOTE: this is the ONLY sanctioned writer for `admin_audit_log`.
 * The `opencoo/no-update-append-only` ESLint rule pins the
 * append-only invariant; this writer only INSERTs.
 */
export async function writeAuditLog(
  db: Db,
  args: WriteAuditLogArgs,
): Promise<{ readonly id: string }> {
  const parsed = auditWriteSchema.parse({
    action: args.action,
    userId: args.userId,
    metadata: args.metadata,
    sourceIp: args.sourceIp ?? null,
    userAgent: truncateUserAgent(args.userAgent),
  });

  const inserted = await db
    .insert(adminAuditLog)
    .values({
      action: parsed.action,
      userId: parsed.userId,
      metadata: parsed.metadata,
      sourceIp: parsed.sourceIp ?? null,
      userAgent: parsed.userAgent ?? null,
    })
    .returning({ id: adminAuditLog.id });

  const id = inserted[0]?.id;
  if (id === undefined) {
    throw new Error("admin-api: writeAuditLog INSERT returned no row");
  }
  return { id };
}

/** Convenience: read the most recent N rows for the audit-log
 *  read endpoint. Filters via SQL — `?limit=…` is bounded to
 *  100 by the route Zod schema. */
export interface ReadAuditLogArgs {
  readonly limit: number;
  readonly offset: number;
}

export interface AuditLogRow {
  readonly id: string;
  readonly action: AuditAction;
  readonly userId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

export async function readAuditLog(
  db: Db,
  args: ReadAuditLogArgs,
): Promise<readonly AuditLogRow[]> {
  const rows = (await db.execute(sql`
    SELECT id::text AS id,
           action,
           user_id::text AS user_id,
           metadata,
           source_ip,
           user_agent,
           created_at
    FROM admin_audit_log
    ORDER BY created_at DESC
    LIMIT ${args.limit}
    OFFSET ${args.offset}
  `)) as unknown as {
    rows: Array<{
      id: string;
      action: string;
      user_id: string | null;
      metadata: Record<string, unknown>;
      source_ip: string | null;
      user_agent: string | null;
      created_at: Date | string;
    }>;
  };
  const out: AuditLogRow[] = [];
  for (const r of rows.rows) {
    if (!isAuditAction(r.action)) {
      // Action somehow not in the allowlist (manual DB write?).
      // Skip the row — defense-in-depth so a future expansion
      // doesn't crash the read endpoint.
      continue;
    }
    out.push({
      id: r.id,
      action: r.action,
      userId: r.user_id,
      metadata: r.metadata,
      sourceIp: r.source_ip,
      userAgent: r.user_agent,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(r.created_at).toISOString(),
    });
  }
  return out;
}

function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_LOG_ACTIONS as readonly string[]).includes(value);
}
