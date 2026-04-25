/**
 * Canonical-bytes serializer + sourceRevision computation
 * (PR 26 / plan #122).
 *
 * Two pure functions:
 *
 *   - `canonicalBytes(value)` — returns the JSON-serialised
 *     bytes of the input with object keys SORTED at every depth
 *     and no whitespace. The compiler / adapter use this to
 *     produce a deterministic byte stream that:
 *       * does not depend on JS object insertion order,
 *       * does not depend on whitespace formatting,
 *       * never carries a top-level `updatedAt` (callers strip
 *         it before passing in).
 *
 *   - `computeWorkflowRevision(workflow)` — strips top-level
 *     `updatedAt`, runs `canonicalBytes`, hashes the result with
 *     SHA-256, returns the first 16 hex chars. This is the
 *     `sourceRevision` for `n8n:` source events. Stable across
 *     replay: a no-op edit that only touches `updatedAt` produces
 *     the SAME revision; a real change produces a different one.
 */
import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return value;
}

/**
 * Returns the deterministic byte stream of `value`. Object keys
 * are recursively sorted; arrays preserve their order; primitives
 * are encoded as JSON. No whitespace.
 */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

/**
 * Strip the top-level `updatedAt` field if present. Adapter and
 * compiler both call this — they intentionally do the same strip
 * (decision 3, "in BOTH layers"). When the workflow does not
 * have an `updatedAt` field, returns the input unchanged.
 */
export function stripUpdatedAt<T extends Record<string, unknown>>(
  workflow: T,
): Omit<T, "updatedAt"> {
  if (!("updatedAt" in workflow)) return workflow;
  const copy: Record<string, unknown> = { ...workflow };
  delete copy["updatedAt"];
  return copy as Omit<T, "updatedAt">;
}

/**
 * `sourceRevision` for an n8n workflow. Hashes the canonical
 * bytes of the workflow MINUS top-level `updatedAt` and slices
 * to 16 hex chars. Stable across replay.
 */
export function computeWorkflowRevision(workflow: Record<string, unknown>): string {
  const stripped = stripUpdatedAt(workflow);
  const bytes = canonicalBytes(stripped);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}
