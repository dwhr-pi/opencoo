/**
 * Webhook receiver — Fastify plugin / handler that owns:
 *   - POST /webhooks/:bindingId           (receives webhook deliveries)
 *
 * Flow:
 *   1. Resolve binding by id (404 if unknown).
 *   2. Look up the SourceAdapter by binding.adapterSlug.
 *   3. Read the HMAC secret via CredentialStore (audit log fires here).
 *   4. Verify signature via injected WebhookVerifier.
 *   5. INSERT webhook_events (Q12 dedupe semantics).
 *   6. On signature_ok:
 *      - dispatch a job to the Scanner queue (provider-specific
 *        payload — for v0.1 we just enqueue a `{webhookId, bindingId}`
 *        marker; PR 15+ Scanner pulls full payload).
 *      - return 200 with `{accepted:true, webhookId, deliveryCount}`.
 *      On signature mismatch:
 *      - dispatch to DLQ queue (for operator triage).
 *      - return 401 with `{accepted:false, reason}`.
 *
 * Test seam: the receiver factory takes injected db, credentialStore,
 * adapterRegistry, webhookVerifier, scannerQueue, dlqQueue. The
 * test stubs scannerQueue + dlqQueue with recorder objects.
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

import { buildWebhookReceiver } from "../../src/intake/webhook-receiver.js";
import { InMemoryAdapterRegistry } from "../../src/intake/adapter-registry.js";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  HmacSha256Verifier,
  type WebhookVerifier,
  type WebhookVerifyResult,
} from "@opencoo/shared/webhook-verifier";

import { freshIntakeDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: {
      write(): boolean {
        return true;
      },
    },
  });
}

interface QueueRecorder {
  add: ReturnType<typeof vi.fn>;
}

function makeRecorder(): QueueRecorder {
  return { add: vi.fn(async () => undefined) };
}

/**
 * Minimal Logger-shape stub the receiver accepts via `appLogger`.
 * Only `debug` is recorded — the rejection path (PR-N1) does not
 * call other levels, so we keep the surface tight.
 */
interface LoggerRecorder {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
}

function makeLoggerRecorder(): LoggerRecorder {
  const recorder: LoggerRecorder = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    // child returns the same recorder so any future child() chain
    // keeps logging into the same vi.fn collectors.
    child: vi.fn(() => recorder),
  };
  return recorder;
}

const SECRET_PLAINTEXT = Buffer.from("test-shared-secret", "utf8");

async function makeFixture(
  opts: { appLogger?: LoggerRecorder; verifier?: WebhookVerifier } = {},
) {
  const fixture = await freshIntakeDb();

  const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await credentialStore.write({
    name: "drive-webhook-secret",
    schemaRef: "webhook/v1",
    plaintext: SECRET_PLAINTEXT,
  });

  // Wire credentials_id onto the seeded binding.
  await fixture.db.execute(
    `UPDATE sources_bindings SET credentials_id = '${credentialId}' WHERE id = '${fixture.bindingId}'`,
  );

  const adapterRegistry = new InMemoryAdapterRegistry();
  adapterRegistry.register({ slug: "drive" });

  const scannerQueue = makeRecorder();
  const dlqQueue = makeRecorder();

  const app = buildWebhookReceiver({
    db: fixture.db,
    credentialStore,
    adapterRegistry,
    verifier: opts.verifier ?? new HmacSha256Verifier(),
    scannerQueue: scannerQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["scannerQueue"],
    dlqQueue: dlqQueue as unknown as Parameters<typeof buildWebhookReceiver>[0]["dlqQueue"],
    ...(opts.appLogger !== undefined
      ? {
          appLogger: opts.appLogger as unknown as Parameters<
            typeof buildWebhookReceiver
          >[0]["appLogger"],
        }
      : {}),
  });

  return { ...fixture, app, credentialStore, scannerQueue, dlqQueue };
}

function signHex(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("webhook receiver — happy path", () => {
  it("POST /webhooks/:bindingId with valid signature → 200 + scanner queue add", async () => {
    const { app, bindingId, scannerQueue, dlqQueue } = await makeFixture();
    const body = '{"event":"push","ref":"refs/heads/main"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-1",
        "x-provider": "gitea",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as {
      accepted: boolean;
      webhookId: string;
      deliveryCount: number;
    };
    expect(json.accepted).toBe(true);
    expect(json.deliveryCount).toBe(1);
    expect(scannerQueue.add).toHaveBeenCalledTimes(1);
    expect(dlqQueue.add).not.toHaveBeenCalled();
    await app.close();
  });

  it("writes webhook_events row with signature_ok:true and binding_id set", async () => {
    const { app, bindingId, db } = await makeFixture();
    const body = '{"x":1}';
    await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-1",
        "x-provider": "gitea",
      },
      payload: body,
    });
    const result = await db.execute(`SELECT * FROM webhook_events`);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as {
      signature_ok: boolean;
      binding_id: string;
      delivery_count: number;
      payload: unknown;
    };
    expect(row.signature_ok).toBe(true);
    expect(row.binding_id).toBe(bindingId);
    expect(row.delivery_count).toBe(1);
    // Q13: payload stored as null by default.
    expect(row.payload).toBeNull();
    await app.close();
  });
});

describe("webhook receiver — signature mismatch", () => {
  it("POST with invalid signature → 401 + DLQ + signature_ok:false in DB + NO scanner enqueue", async () => {
    const { app, bindingId, db, scannerQueue, dlqQueue } = await makeFixture();
    const body = '{"event":"push"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": "sha256=" + "0".repeat(64),
        "x-event-id": "evt-bad",
        "x-provider": "gitea",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    const json = res.json() as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toMatch(/signature/i);

    expect(scannerQueue.add).not.toHaveBeenCalled();
    expect(dlqQueue.add).toHaveBeenCalledTimes(1);

    const rows = await db.execute(
      `SELECT signature_ok FROM webhook_events`,
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { signature_ok: boolean }).signature_ok).toBe(false);
    await app.close();
  });

  it("POST with missing signature header → 401 + DLQ", async () => {
    const { app, bindingId, scannerQueue, dlqQueue } = await makeFixture();
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-event-id": "evt-no-sig",
        "x-provider": "gitea",
      },
      payload: '{"x":1}',
    });
    expect(res.statusCode).toBe(401);
    expect(scannerQueue.add).not.toHaveBeenCalled();
    expect(dlqQueue.add).toHaveBeenCalledTimes(1);
    await app.close();
  });

  // (PR-N1, phase-a appendix #6) Operator runbook §5 tells operators
  // to grep for `webhook_receiver.signature_invalid` in LOG_LEVEL=debug
  // output to diagnose failed-handshake situations. The receiver MUST
  // emit a structured debug-level log line in the rejection branch,
  // and that line MUST honor THREAT-MODEL §2 invariant 11 (no raw
  // secrets in logs): the signature header NAME is fine, the header
  // VALUE is not; the request body is not.
  it("POST with invalid signature → emits webhook_receiver.signature_invalid debug log with redacted payload", async () => {
    const appLogger = makeLoggerRecorder();
    const { app, bindingId } = await makeFixture({ appLogger });

    const body = '{"event":"push","secret_in_body":"sensitive-bytes"}';
    // Use a recognisable signature header value so the negative
    // assertion below can grep for it.
    const sentSignature = `sha256=${"f".repeat(64)}`;

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": sentSignature,
        "x-event-id": "evt-bad-sig-log",
        "x-provider": "gitea",
      },
      payload: body,
    });

    // Existing behavior preserved.
    expect(res.statusCode).toBe(401);

    // The new log line was emitted exactly once on the rejection path.
    expect(appLogger.debug).toHaveBeenCalledTimes(1);

    const [logKey, logCtx] = appLogger.debug.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(logKey).toBe("webhook_receiver.signature_invalid");

    // Required fields on the structured payload.
    expect(logCtx).toMatchObject({
      bindingId,
      provider: "gitea",
      eventId: "evt-bad-sig-log",
      signatureHeaderName: "x-signature",
    });
    // `errorReason` is the verifier's static reason string for an
    // HMAC mismatch — closed enum from HmacSha256Verifier.
    expect(typeof logCtx["errorReason"]).toBe("string");
    expect(logCtx["errorReason"]).toMatch(/HMAC differs|mismatch/i);

    // Negative assertion — the actual signature header VALUE must
    // never appear anywhere in the logged payload.
    const serialised = JSON.stringify(logCtx);
    expect(serialised).not.toContain(sentSignature);
    expect(serialised).not.toContain("f".repeat(64));

    // Negative assertion — the raw request body must never appear
    // in the logged payload.
    expect(serialised).not.toContain("secret_in_body");
    expect(serialised).not.toContain("sensitive-bytes");

    await app.close();
  });

  // (PR-N1 round-2 fix, Copilot #56) The `WebhookVerifier` port's
  // `WebhookVerifyResult.reason` is typed as `string` — the contract
  // does NOT constrain it to a closed enum. `HmacSha256Verifier`
  // happens to return safe static strings today, but a future
  // custom verifier could include user-supplied bytes (a header
  // value, a body fragment, a credential pattern). The receiver
  // MUST defensively `scrubPat`+cap the reason string before logging
  // it so that defense-in-depth holds even if a verifier author
  // forgets the redaction invariant. THREAT-MODEL §2 invariant 11 +
  // §3.6.
  it("POST with invalid signature → scrubs credential patterns from a custom verifier's reason string", async () => {
    // A 40-hex string matches scrubPat's GITEA_PAT_RE rule and
    // should be replaced by `[REDACTED]`.
    const fakeGiteaPat = "a".repeat(40);
    const reasonWithSecret = `signature mismatch (debug: leaked-token=${fakeGiteaPat})`;

    const leakyVerifier: WebhookVerifier = {
      verify(): WebhookVerifyResult {
        return { ok: false, reason: reasonWithSecret };
      },
    };

    const appLogger = makeLoggerRecorder();
    const { app, bindingId } = await makeFixture({
      appLogger,
      verifier: leakyVerifier,
    });

    const body = '{"event":"push"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": "sha256=" + "0".repeat(64),
        "x-event-id": "evt-leaky-verifier",
        "x-provider": "gitea",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);

    expect(appLogger.debug).toHaveBeenCalledTimes(1);
    const [logKey, logCtx] = appLogger.debug.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(logKey).toBe("webhook_receiver.signature_invalid");

    const errorReason = logCtx["errorReason"];
    expect(typeof errorReason).toBe("string");

    // The credential pattern MUST be replaced by `[REDACTED]` —
    // verbatim secret bytes never reach the operator log.
    expect(errorReason).toContain("[REDACTED]");
    expect(errorReason).not.toContain(fakeGiteaPat);

    // The non-secret prose around the redaction is preserved so
    // operators can still tell what kind of failure happened.
    expect(errorReason).toMatch(/signature mismatch/i);

    // Round-2 cap: the receiver also bounds the reason at 200 chars
    // so a verbose / attacker-controlled reason cannot blow up the
    // log line. Asserting ≤200 here pins the cap behavior.
    expect((errorReason as string).length).toBeLessThanOrEqual(200);

    await app.close();
  });

  it("scrubs credential patterns even when the reason exceeds the 200-char cap", async () => {
    // Build a reason longer than 200 chars that contains a credential
    // pattern. The cap MUST be applied AFTER scrubPat so that a
    // credential pattern straddling the 200-char boundary is still
    // redacted (otherwise truncating first could expose a partial
    // token through the cap window).
    const fakeBearer = "Bearer " + "x".repeat(64);
    const longLeakyReason =
      "signature mismatch (verbose-debug: " +
      "noise-".repeat(30) +
      fakeBearer +
      " end)";
    expect(longLeakyReason.length).toBeGreaterThan(200);

    const leakyVerifier: WebhookVerifier = {
      verify(): WebhookVerifyResult {
        return { ok: false, reason: longLeakyReason };
      },
    };

    const appLogger = makeLoggerRecorder();
    const { app, bindingId } = await makeFixture({
      appLogger,
      verifier: leakyVerifier,
    });

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": "sha256=" + "0".repeat(64),
        "x-event-id": "evt-long-leaky",
        "x-provider": "gitea",
      },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);

    const [, logCtx] = appLogger.debug.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const errorReason = logCtx["errorReason"] as string;

    // The 64-x token must NEVER appear in the logged reason, even
    // partially (`xxxx…`), because scrubPat replaces the whole
    // generic-token match with `[REDACTED]`.
    expect(errorReason).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(errorReason.length).toBeLessThanOrEqual(200);

    await app.close();
  });
});

describe("webhook receiver — unknown binding", () => {
  it("POST with unknown bindingId → 404 + no DB writes + no queue dispatches", async () => {
    const { app, db, scannerQueue, dlqQueue } = await makeFixture();
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${fakeId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": "sha256=" + "0".repeat(64),
        "x-event-id": "evt-1",
        "x-provider": "gitea",
      },
      payload: '{"x":1}',
    });
    expect(res.statusCode).toBe(404);
    expect(scannerQueue.add).not.toHaveBeenCalled();
    expect(dlqQueue.add).not.toHaveBeenCalled();
    const rows = await db.execute(`SELECT count(*) AS c FROM webhook_events`);
    expect(Number((rows.rows[0] as { c: number | string }).c)).toBe(0);
    await app.close();
  });
});

describe("webhook receiver — Q12 duplicate idempotency", () => {
  it("duplicate event-id → 200 + delivery_count:2 + NO new scanner job", async () => {
    const { app, bindingId, scannerQueue } = await makeFixture();
    const body = '{"x":1}';
    const headers = {
      "content-type": "application/json",
      "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
      "x-event-id": "evt-dup",
      "x-provider": "gitea",
    };

    const r1 = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers,
      payload: body,
    });
    expect(r1.statusCode).toBe(200);
    expect((r1.json() as { deliveryCount: number }).deliveryCount).toBe(1);

    const r2 = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers,
      payload: body,
    });
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { deliveryCount: number }).deliveryCount).toBe(2);

    // Scanner queue receives only ONE dispatch — the second delivery
    // is a duplicate the upstream provider sent, not a new event.
    expect(scannerQueue.add).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe("webhook receiver — body size limit", () => {
  it("accepts a 1KiB body", async () => {
    const { app, bindingId } = await makeFixture();
    const body = `{"big":"${"a".repeat(900)}"}`;
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-1k",
        "x-provider": "gitea",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a 6MB body (over the 5MB cap)", async () => {
    const { app, bindingId } = await makeFixture();
    // 6MB payload
    const body = `{"big":"${"a".repeat(6 * 1024 * 1024 - 16)}"}`;
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": "sha256=" + "0".repeat(64),
        "x-event-id": "evt-big",
        "x-provider": "gitea",
      },
      payload: body,
    });
    // Fastify default behaviour: 413 Payload Too Large.
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});

// (copilot #16 Comments 3+4) — sticky-true signature upgrade path
// from the receiver's perspective: a bad-signature delivery for an
// event-id followed by a valid retry must enqueue the scanner job
// the second time (firstValidDelivery=true), even though
// `created:false`. Without this, providers' built-in retry of
// transient verify failures would silently drop the event.
describe("webhook receiver — Q12+sig-upgrade interaction (copilot #16)", () => {
  it("bad-sig then valid retry → scanner queue receives the upgraded delivery", async () => {
    const { app, bindingId, scannerQueue, dlqQueue, db } = await makeFixture();
    const body = '{"event":"push"}';

    // 1st: bad signature → 401 + DLQ + signature_ok=false in DB +
    // NO scanner enqueue.
    const r1 = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": "sha256=" + "0".repeat(64),
        "x-event-id": "evt-retry",
        "x-provider": "gitea",
      },
      payload: body,
    });
    expect(r1.statusCode).toBe(401);
    expect(scannerQueue.add).not.toHaveBeenCalled();
    expect(dlqQueue.add).toHaveBeenCalledTimes(1);

    // 2nd: provider retries with the right secret — receiver MUST
    // upgrade the row AND enqueue the scanner (firstValidDelivery
    // path), even though the row was created on the first delivery
    // (`created:false`).
    const r2 = await app.inject({
      method: "POST",
      url: `/webhooks/${bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-retry",
        "x-provider": "gitea",
      },
      payload: body,
    });
    expect(r2.statusCode).toBe(200);
    const json = r2.json() as {
      accepted: boolean;
      deliveryCount: number;
    };
    expect(json.accepted).toBe(true);
    expect(json.deliveryCount).toBe(2);

    // The scanner queue MUST have received the job for the upgraded
    // delivery — that's the bug we fixed.
    expect(scannerQueue.add).toHaveBeenCalledTimes(1);

    // DB state: signature_ok flipped, binding_id set.
    const rows = await db.execute(`SELECT signature_ok, binding_id FROM webhook_events`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as { signature_ok: boolean; binding_id: string };
    expect(row.signature_ok).toBe(true);
    expect(row.binding_id).toBe(bindingId);

    await app.close();
  });

  it("valid then valid (already-flipped) → scanner enqueued ONCE, second is a true duplicate", async () => {
    const { app, bindingId, scannerQueue } = await makeFixture();
    const body = '{"x":1}';
    const headers = {
      "content-type": "application/json",
      "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
      "x-event-id": "evt-dup-valid",
      "x-provider": "gitea",
    };

    await app.inject({ method: "POST", url: `/webhooks/${bindingId}`, headers, payload: body });
    await app.inject({ method: "POST", url: `/webhooks/${bindingId}`, headers, payload: body });

    // Second valid delivery is a TRUE duplicate (no upgrade) — scanner
    // must NOT be enqueued again.
    expect(scannerQueue.add).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
