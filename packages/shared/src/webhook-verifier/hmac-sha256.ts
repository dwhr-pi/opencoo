/**
 * HMAC-SHA256 webhook verifier — the default impl used by Gitea,
 * GitHub, and most modern webhook senders. Accepts both the raw
 * hex form (Stripe, generic) and the `sha256=<hex>` prefixed form
 * (Gitea, GitHub).
 *
 * Constant-time comparison via Node's `timingSafeEqual`. Different-
 * length buffers are rejected up-front (timingSafeEqual would throw
 * otherwise) — both branches are intentional fail-closed paths.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  WebhookVerifier,
  WebhookVerifyArgs,
  WebhookVerifyResult,
} from "./interface.js";

const SHA256_PREFIX = /^sha256=/i;
const HEX64 = /^[0-9a-fA-F]{64}$/;

export class HmacSha256Verifier implements WebhookVerifier {
  verify(args: WebhookVerifyArgs): WebhookVerifyResult {
    if (args.signature === undefined || args.signature.length === 0) {
      return { ok: false, reason: "signature header missing" };
    }

    // Normalise: strip optional `sha256=` prefix.
    const normalised = args.signature.replace(SHA256_PREFIX, "");

    if (!HEX64.test(normalised)) {
      return {
        ok: false,
        reason: `signature is malformed (expected 64 hex chars, got ${normalised.length})`,
      };
    }

    const expected = createHmac("sha256", args.secret)
      .update(args.body)
      .digest();
    let received: Buffer;
    try {
      received = Buffer.from(normalised, "hex");
    } catch {
      // Buffer.from('hex') silently truncates rather than throwing
      // on most malformed inputs, but we already validated with the
      // HEX64 regex above. Keep the catch as belt-and-suspenders.
      return { ok: false, reason: "signature is malformed (decode failed)" };
    }

    if (received.length !== expected.length) {
      return {
        ok: false,
        reason: `signature length mismatch (expected ${expected.length}, got ${received.length})`,
      };
    }

    if (!timingSafeEqual(received, expected)) {
      return { ok: false, reason: "signature mismatch (HMAC differs)" };
    }

    return { ok: true };
  }
}
