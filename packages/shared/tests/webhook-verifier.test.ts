/**
 * @opencoo/shared/webhook-verifier — narrow port + reference HMAC-SHA256
 * implementation for verifying inbound webhook signatures.
 *
 * The shape lives in shared (not engine-ingestion) so the SourceAdapter
 * port (PR 23+) can absorb it as `adapter.verifyWebhook(...)` without
 * an engine-ingestion dependency. Today the engine-ingestion receiver
 * imports a concrete verifier directly via DI.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

import {
  WebhookSignatureError,
  HmacSha256Verifier,
  type WebhookVerifier,
  type WebhookVerifyArgs,
} from "../src/webhook-verifier/index.js";

describe("WebhookVerifier — module shape", () => {
  it("WebhookSignatureError extends OpencooError with errorClass='validation'", () => {
    const err = new WebhookSignatureError("bad sig");
    expect(err).toBeInstanceOf(Error);
    expect(err.errorClass).toBe("validation");
    expect(err.name).toBe("WebhookSignatureError");
  });

  it("WebhookSignatureError preserves cause via OpencooError options", () => {
    const cause = new Error("downstream");
    const err = new WebhookSignatureError("wrap", { cause });
    expect(err.cause).toBe(cause);
  });

  it("HmacSha256Verifier implements the WebhookVerifier port", () => {
    const v: WebhookVerifier = new HmacSha256Verifier();
    expect(typeof v.verify).toBe("function");
  });
});

describe("HmacSha256Verifier — verify", () => {
  const SECRET = Buffer.from("test-secret-key", "utf8");
  const BODY = Buffer.from('{"hello":"world"}', "utf8");

  function signHex(secret: Buffer, body: Buffer): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  it("returns ok:true when the signature header matches HMAC(secret, body)", () => {
    const v = new HmacSha256Verifier();
    const args: WebhookVerifyArgs = {
      body: BODY,
      secret: SECRET,
      signature: signHex(SECRET, BODY),
    };
    const result = v.verify(args);
    expect(result.ok).toBe(true);
  });

  it("returns ok:true when the signature is prefixed with 'sha256=' (Gitea/GitHub style)", () => {
    const v = new HmacSha256Verifier();
    const result = v.verify({
      body: BODY,
      secret: SECRET,
      signature: `sha256=${signHex(SECRET, BODY)}`,
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok:false when the signature does not match", () => {
    const v = new HmacSha256Verifier();
    const result = v.verify({
      body: BODY,
      secret: SECRET,
      signature: "0".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/mismatch|invalid/i);
    }
  });

  it("returns ok:false when the signature is missing", () => {
    const v = new HmacSha256Verifier();
    const result = v.verify({
      body: BODY,
      secret: SECRET,
      signature: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/missing|absent/i);
    }
  });

  it("returns ok:false when the signature is malformed (non-hex)", () => {
    const v = new HmacSha256Verifier();
    const result = v.verify({
      body: BODY,
      secret: SECRET,
      signature: "not-a-hex-string!!!",
    });
    expect(result.ok).toBe(false);
  });

  it("uses timingSafeEqual — does not short-circuit on prefix mismatch", () => {
    // Behavioural smoke test: timingSafeEqual requires equal-length
    // buffers. A malformed signature (different length) must not
    // throw; the verifier should reject cleanly.
    const v = new HmacSha256Verifier();
    const result = v.verify({
      body: BODY,
      secret: SECRET,
      signature: "ab", // 2 chars
    });
    expect(result.ok).toBe(false);
  });

  it("rejects when body is mutated even by one byte", () => {
    const v = new HmacSha256Verifier();
    const sig = signHex(SECRET, BODY);
    const mutated = Buffer.from('{"hello":"WORLD"}', "utf8");
    const result = v.verify({ body: mutated, secret: SECRET, signature: sig });
    expect(result.ok).toBe(false);
  });

  it("rejects when secret differs", () => {
    const v = new HmacSha256Verifier();
    const sig = signHex(SECRET, BODY);
    const result = v.verify({
      body: BODY,
      secret: Buffer.from("different-secret", "utf8"),
      signature: sig,
    });
    expect(result.ok).toBe(false);
  });
});
