/**
 * Thin wrapper over `cron-parser`'s `parseExpression` that returns a
 * structured `{ valid, error? }` result the dispatcher can pattern-
 * match on (PR-M2, phase-a appendix #5).
 *
 * The dispatcher reads `agent_instances.schedule_cron` rows at boot
 * and registers a BullMQ recurring job per row. A garbage value in
 * one row must not crash the whole dispatcher; the calling code:
 *
 *   const r = validateCron(row.scheduleCron);
 *   if (!r.valid) {
 *     logger.error('scheduler.invalid_cron', { instanceId: row.id,
 *                  cron: row.scheduleCron, error: r.error });
 *     continue;
 *   }
 *
 * keeps the row out of the BullMQ registry while letting the rest of
 * the rows register cleanly. The error string is sanitised to a
 * single-line message — `cron-parser` errors are short by default but
 * we strip stack traces defensively so the operator log stays
 * readable.
 */
import cronParser from "cron-parser";

export interface ValidateCronResult {
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Round-3 fix #5: every `cron-parser` call MUST pin
 * `tz: 'UTC'` so parsed schedules + computed `nextFireAt`
 * timestamps are deterministic regardless of the host machine's
 * local timezone. The dispatcher pins the same `tz: 'UTC'` on
 * BullMQ's `RepeatOptions` so the two layers agree on which
 * wall-clock minute each pattern resolves to.
 */
const PARSER_TZ_OPTS = { tz: "UTC" as const } as const;

/**
 * Parse a 5-field UTC cron pattern. Returns `{ valid: true }` on
 * success, `{ valid: false, error }` otherwise. Never throws.
 */
export function validateCron(pattern: string): ValidateCronResult {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { valid: false, error: "cron pattern must be a non-empty string" };
  }
  try {
    cronParser.parseExpression(pattern, PARSER_TZ_OPTS);
    return { valid: true };
  } catch (err) {
    // First line only — `cron-parser` 4.x throws plain `Error` objects
    // with concise messages, but we strip multi-line content
    // defensively so a future error shape can't bloat the operator log.
    const raw = err instanceof Error ? err.message : String(err);
    const firstLine = raw.split("\n", 1)[0] ?? raw;
    return { valid: false, error: firstLine };
  }
}

/**
 * Compute the next firing instant for a known-valid cron pattern.
 * Used by the read-only `/api/admin/scheduler` route.
 *
 * Returns `null` when the pattern is invalid or `cron-parser` cannot
 * compute a next date (e.g. an end-date constraint already passed).
 * The caller surfaces `null` as a missing field rather than an error
 * so a single bad row doesn't take the whole listing down.
 *
 * Round-3 fix #5: `tz: 'UTC'` is pinned via `PARSER_TZ_OPTS` so the
 * timestamp the admin route surfaces matches what BullMQ scheduled
 * (the dispatcher pins `tz: 'UTC'` on `RepeatOptions` too).
 */
export function nextFireAt(pattern: string, from?: Date): Date | null {
  try {
    const opts = from !== undefined
      ? { ...PARSER_TZ_OPTS, currentDate: from }
      : PARSER_TZ_OPTS;
    const expr = cronParser.parseExpression(pattern, opts);
    return expr.next().toDate();
  } catch {
    return null;
  }
}
