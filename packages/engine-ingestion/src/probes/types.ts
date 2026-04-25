/**
 * Common probe result shape — one variant per outcome. Fail-closed
 * by contract: probe functions NEVER throw; any failure is a
 * `{ ok: false, reason: string }` so the /ready handler can build
 * its JSON response without try/catch around every call.
 */
export type ProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };
