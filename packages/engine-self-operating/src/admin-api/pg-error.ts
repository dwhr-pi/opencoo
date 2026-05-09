/**
 * Postgres error-code narrowers used across admin-API routes.
 *
 * Hoisted from `routes/source-bindings.ts` (PR-Q10b) so the
 * Domain DELETE handler in `routes/domains.ts` (PR-R1) can share
 * the same SQLSTATE narrowing without duplicating the code-walk.
 *
 * `node-postgres` surfaces the SQLSTATE on the thrown Error
 * directly; Drizzle wraps the underlying error sometimes via
 * `.cause`, so we check both spellings.
 */

/** Detect a Postgres `foreign_key_violation` (SQLSTATE 23503). */
export function isPgForeignKeyViolation(err: unknown): boolean {
  return hasPgCode(err, "23503");
}

/** Detect a Postgres `unique_violation` (SQLSTATE 23505). */
export function isPgUniqueViolation(err: unknown): boolean {
  return hasPgCode(err, "23505");
}

function hasPgCode(err: unknown, code: string): boolean {
  if (err === null || typeof err !== "object") return false;
  const codeFromTop = (err as { code?: unknown }).code;
  if (typeof codeFromTop === "string" && codeFromTop === code) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== null && typeof cause === "object") {
    const codeFromCause = (cause as { code?: unknown }).code;
    if (typeof codeFromCause === "string" && codeFromCause === code) {
      return true;
    }
  }
  return false;
}
