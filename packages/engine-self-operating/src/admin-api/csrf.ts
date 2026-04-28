/**
 * CSRF — double-submit cookie pattern (PR 28 / plan #128,
 * THREAT-MODEL §3.13).
 *
 * Stateless: no server-side per-session storage. The flow:
 *   1. SPA calls `GET /api/admin/_csrf` after auth.
 *   2. Endpoint generates a 256-bit random token, sets it as a
 *      cookie `opencoo_csrf=<tok>; Path=/;
 *      SameSite=Strict; Secure (production only)`. NOT HttpOnly
 *      — the SPA must read the cookie value to mirror it as a
 *      header on mutating requests. Path=/ so the SPA at the
 *      root URL can enumerate the cookie via document.cookie;
 *      SameSite=Strict + double-submit are still the CSRF
 *      defense, the path scope is not load-bearing here.
 *   3. Endpoint also returns the token in the JSON body so the
 *      SPA can stash it in memory.
 *   4. State-changing routes register the `requireCsrf`
 *      preHandler — it asserts:
 *        - `X-CSRF-Token` header present
 *        - `opencoo_csrf` cookie present
 *        - constant-time equality between the two
 *      Mismatch → 403.
 *
 * Why this works: a malicious cross-origin attacker CANNOT read
 * the cookie value because of SameSite=Strict (and Secure in
 * production-over-TLS); they can't fabricate the matching
 * header even if they trick the browser into sending the
 * cookie. The double-submit forces the attacker to exfiltrate
 * the cookie (which is blocked by the cookie attributes) before
 * they can replay.
 *
 * Production deploys MUST run behind TLS — partner-deploy
 * compose enforces this by terminating TLS at a reverse proxy
 * fronting the engine; `NODE_ENV=production` flips Secure on
 * so cookies are never sent over plaintext in production.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { buildAdminCookieLine } from "./cookie-attrs.js";

const CSRF_COOKIE_NAME = "opencoo_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

/** 256-bit token, base64url-encoded → 43 chars (no padding). */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Parse the `Cookie:` header and return the value of
 *  `opencoo_csrf` if present. Tolerant to whitespace,
 *  quoted values, and unrelated cookies. */
export function extractCsrfCookie(
  cookieHeader: string | undefined,
): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${CSRF_COOKIE_NAME}=`)) {
      const raw = trimmed.slice(CSRF_COOKIE_NAME.length + 1);
      // Strip quotes (RFC 6265 allows quoted-string values).
      if (raw.startsWith('"') && raw.endsWith('"')) {
        return raw.slice(1, -1);
      }
      return raw;
    }
  }
  return undefined;
}

/** Issue a fresh token + set the cookie + return the body. */
export function issueCsrfToken(
  reply: FastifyReply,
): { readonly csrfToken: string } {
  const token = newToken();
  // NOT HttpOnly — the SPA must read this client-side to mirror
  // it as the X-CSRF-Token header on mutating requests.
  reply.header(
    "set-cookie",
    buildAdminCookieLine({
      name: CSRF_COOKIE_NAME,
      value: token,
      httpOnly: false,
    }),
  );
  return { csrfToken: token };
}

/**
 * preHandler. Throws (sends 403 + early-returns) when:
 *   - X-CSRF-Token header missing or empty
 *   - opencoo_csrf cookie missing or empty
 *   - lengths differ
 *   - constant-time compare returns false
 */
export async function requireCsrf(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const headerVal = req.headers[CSRF_HEADER_NAME];
  const headerToken = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const cookieHeader = Array.isArray(req.headers["cookie"])
    ? req.headers["cookie"][0]
    : req.headers["cookie"];
  const cookieToken = extractCsrfCookie(cookieHeader);

  if (
    typeof headerToken !== "string" ||
    headerToken.length === 0 ||
    typeof cookieToken !== "string" ||
    cookieToken.length === 0
  ) {
    reply.code(403).send({
      error: "csrf_invalid",
      reason: "missing_csrf_token",
    });
    return;
  }

  // Constant-time equality. Different lengths are never equal;
  // timingSafeEqual would throw on length mismatch so we
  // short-circuit to keep the path side-channel-clean.
  const headerBuf = Buffer.from(headerToken, "utf8");
  const cookieBuf = Buffer.from(cookieToken, "utf8");
  if (headerBuf.length !== cookieBuf.length) {
    reply.code(403).send({
      error: "csrf_invalid",
      reason: "csrf_mismatch",
    });
    return;
  }
  if (!timingSafeEqual(headerBuf, cookieBuf)) {
    reply.code(403).send({
      error: "csrf_invalid",
      reason: "csrf_mismatch",
    });
    return;
  }
}

export const CSRF_COOKIE = CSRF_COOKIE_NAME;
export const CSRF_HEADER = CSRF_HEADER_NAME;
