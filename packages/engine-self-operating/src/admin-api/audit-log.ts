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
