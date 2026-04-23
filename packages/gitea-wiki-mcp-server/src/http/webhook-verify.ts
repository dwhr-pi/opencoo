/**
 * Gitea webhook HMAC verification. Gitea sends `X-Gitea-Signature` as a hex
 * HMAC-SHA256 of the raw body using the shared secret configured on the
 * webhook. We compute the same and timing-safe compare.
 *
 * Docs: https://docs.gitea.com/usage/webhooks — "Gitea uses HMAC SHA256 to
 * generate the signature".
 */
import crypto from "node:crypto";

export function verifyGiteaSignature(
  rawBody: Buffer | string,
  secret: string,
  signatureHex: string | undefined,
): boolean {
  if (!secret) return false;
  if (!signatureHex) return false;

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
  const expected = hmac.digest();

  let given: Buffer;
  try {
    given = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }

  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}
