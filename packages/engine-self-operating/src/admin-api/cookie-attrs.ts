/**
 * Admin-API cookie-attribute builder (phase-a fix-up).
 *
 * Both the SET path (`csrf.ts` issuing `opencoo_csrf`,
 * `auth.ts` issuing `opencoo_session`) and the CLEAR path
 * (`routes/logout.ts` clearing both) MUST agree on the cookie
 * attributes — browsers only delete a cookie when the
 * `(name, Path, Domain)` triple matches the issuance, and any
 * drift on `Secure` flips the cookie between accepted and
 * rejected on http://localhost dev. This helper is the single
 * source of truth for the four cookie lines opencoo emits, so
 * a future change (e.g. raising the `Secure` gate, widening
 * `SameSite`) lands in one place.
 *
 * Invariants enforced here:
 *   - `Path=/` always — the SPA is mounted at `/`, so cookies
 *     scoped to `/api/admin` would be invisible to
 *     `document.cookie` reads.
 *   - `SameSite=Strict` always — see CSRF threat model
 *     (THREAT-MODEL §3.13).
 *   - `Secure` only when `NODE_ENV === "production"` — browsers
 *     reject `Set-Cookie ... Secure` on http:// origins, which
 *     would silently break local dev. Partner-deploy compose
 *     sets NODE_ENV=production AND terminates TLS upstream.
 *   - `HttpOnly` opt-in: ON for `opencoo_session` (SPA never
 *     reads it); OFF for `opencoo_csrf` (SPA must mirror the
 *     value into the X-CSRF-Token header).
 *   - `Max-Age=0` opt-in: emitted by the CLEAR path so the
 *     browser drops the cookie.
 *
 * Attribute ordering is deterministic: `name=value; Path=/;
 * SameSite=Strict[; HttpOnly][; Secure][; Max-Age=N]`. The
 * tests assert on individual attributes, not ordering — but
 * pinning the order keeps logs / fixture comparisons stable.
 */

export interface CookieAttrs {
  readonly name: string;
  readonly value: string;
  /** Adds `HttpOnly` when true. The session cookie sets this;
   *  the CSRF cookie does NOT (the SPA must read its value to
   *  mirror as a header on mutating requests). */
  readonly httpOnly: boolean;
  /** Adds `Max-Age=<n>`. The CLEAR path uses `0`; the SET path
   *  omits it (session-cookie semantics). */
  readonly maxAge?: number;
}

/** Build the `Set-Cookie` header value for an admin-API cookie.
 *  Centralises the Path/SameSite/conditional-Secure invariants
 *  so the SET and CLEAR call sites cannot drift. */
export function buildAdminCookieLine(attrs: CookieAttrs): string {
  const parts = [
    `${attrs.name}=${attrs.value}`,
    "Path=/",
    "SameSite=Strict",
  ];
  if (attrs.httpOnly) parts.push("HttpOnly");
  // Secure-by-default: present UNLESS NODE_ENV === "development".
  // Browsers reject `Set-Cookie ... Secure` on http:// origins, so
  // local-dev needs the explicit opt-out. Staging, test, unset, and
  // any other environment defaults to Secure so a forgotten/typo'd
  // NODE_ENV on a non-prod-but-internet-facing deploy doesn't
  // silently lose the flag. Partner-deploy compose still gets it
  // (NODE_ENV=production); local dev still works
  // (NODE_ENV=development is the explicit opt-out).
  if (process.env.NODE_ENV !== "development") parts.push("Secure");
  if (attrs.maxAge !== undefined) parts.push(`Max-Age=${attrs.maxAge}`);
  return parts.join("; ");
}
