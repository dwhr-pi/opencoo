/**
 * recordWebhook — INSERT into webhook_events with delivery_count
 * dedupe semantics. Per Q12 option (a) approved by team-lead:
 * a duplicate `(provider, event_id)` row is UPDATED to
 * `delivery_count = delivery_count + 1, received_at = now()`,
 * returning `{created:false, deliveryCount:<new>}`.
 *
 * webhookEvents is NOT in the no-update-append-only allowlist
 * (verified empirically against rules/no-update-append-only.ts:18-25).
 * The schema's `delivery_count` column was deliberately designed
 * for this purpose.
 *
 * Rows without `event_id` (provider sent no idempotency key) ALWAYS
 * insert a new row — the partial UNIQUE index has
 * `WHERE event_id IS NOT NULL` so collision detection is impossible.
 */
import { describe, it, expect } from "vitest";

import { recordWebhook } from "../../src/intake/record-webhook.js";
import { freshIntakeDb } from "./_pglite-fixture.js";

const PAYLOAD_HASH = "sha256-abc";
const HASH_2 = "sha256-def";

describe("recordWebhook — happy path (insert)", () => {
  it("inserts a fresh row and returns {created:true, webhookId, deliveryCount:1}", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r.created).toBe(true);
    expect(r.webhookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.deliveryCount).toBe(1);
  });

  it("inserts with bindingId omitted (signature_ok:false path)", async () => {
    const { db } = await freshIntakeDb();
    const r = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-2",
      payloadHash: PAYLOAD_HASH,
      signatureOk: false,
    });
    expect(r.created).toBe(true);
    expect(r.deliveryCount).toBe(1);
  });

  it("inserts with eventId:undefined — providers that send no idempotency key", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "anonymous",
      eventId: undefined,
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r1.created).toBe(true);
    expect(r1.deliveryCount).toBe(1);
  });
});

describe("recordWebhook — Q12 duplicate semantics (UPDATE delivery_count)", () => {
  it("on duplicate (provider, event_id) bumps delivery_count and returns {created:false, deliveryCount:2}", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const r2 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: HASH_2, // even different payload, same event-id
      signatureOk: true,
      bindingId,
    });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.deliveryCount).toBe(2);
    // Same row (UPDATE not INSERT)
    expect(r2.webhookId).toBe(r1.webhookId);
  });

  it("third delivery increments to 3", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const args = {
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    } as const;
    await recordWebhook(args);
    await recordWebhook(args);
    const r3 = await recordWebhook(args);
    expect(r3.created).toBe(false);
    expect(r3.deliveryCount).toBe(3);
  });

  it("rows with eventId:null collide ONLY by chance (no UNIQUE) — both INSERT", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "anonymous",
      eventId: undefined,
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const r2 = await recordWebhook({
      db,
      provider: "anonymous",
      eventId: undefined,
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r2.webhookId).not.toBe(r1.webhookId);
    expect(r2.deliveryCount).toBe(1);
  });

  it("different providers with same event_id are independent (provider scopes the idempotency)", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "shared-evt-id",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const r2 = await recordWebhook({
      db,
      provider: "github",
      eventId: "shared-evt-id",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r2.webhookId).not.toBe(r1.webhookId);
  });
});

describe("recordWebhook — payload privacy (Q13)", () => {
  it("stores payload as null by default — PR 23+ adapter declares retention", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const rows = await db.execute(
      `SELECT payload FROM webhook_events WHERE id = '${r.webhookId}'`,
    );
    const row = rows.rows[0] as { payload: unknown };
    expect(row.payload).toBeNull();
  });
});

// (copilot #16 Comments 3+4) — sticky-true signature upgrade.
// Webhook providers retry 3-5x by design. If the FIRST delivery for
// `(provider, event_id)` had signature_ok=false (transient verifier
// bug, misconfigured secret) and a LATER retry has a valid signature,
// the row MUST flip signature_ok to true and bind the binding_id, AND
// recordWebhook MUST signal `firstValidDelivery: true` so the receiver
// knows to enqueue the scanner job (which would otherwise be silently
// dropped because `created: false`).
describe("recordWebhook — sticky-true signature_ok upgrade", () => {
  it("fresh INSERT with signature_ok:true → firstValidDelivery:true", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r.created).toBe(true);
    expect(r.firstValidDelivery).toBe(true);
  });

  it("fresh INSERT with signature_ok:false → firstValidDelivery:false", async () => {
    const { db } = await freshIntakeDb();
    const r = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: false,
    });
    expect(r.created).toBe(true);
    expect(r.firstValidDelivery).toBe(false);
  });

  it("UPDATE flipping signature_ok false→true sets firstValidDelivery:true and binds binding_id", async () => {
    const { db, bindingId } = await freshIntakeDb();

    // 1st: bad-signature delivery — row inserted with signature_ok=false,
    // binding_id=null. firstValidDelivery=false (no valid yet).
    const r1 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: false,
    });
    expect(r1.created).toBe(true);
    expect(r1.firstValidDelivery).toBe(false);

    // 2nd: provider retried with the right secret — sticky-true upgrade.
    const r2 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: HASH_2,
      signatureOk: true,
      bindingId,
    });
    expect(r2.created).toBe(false);
    expect(r2.firstValidDelivery).toBe(true);
    expect(r2.deliveryCount).toBe(2);
    expect(r2.webhookId).toBe(r1.webhookId);

    // DB state — signature_ok flipped, binding_id set.
    const rows = await db.execute(
      `SELECT signature_ok, binding_id FROM webhook_events WHERE id = '${r2.webhookId}'`,
    );
    const row = rows.rows[0] as { signature_ok: boolean; binding_id: string | null };
    expect(row.signature_ok).toBe(true);
    expect(row.binding_id).toBe(bindingId);
  });

  it("subsequent valid deliveries (already-flipped) → firstValidDelivery:false", async () => {
    const { db, bindingId } = await freshIntakeDb();
    // 1st: false; 2nd: true (flips); 3rd: true (no flip — already valid).
    await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: false,
    });
    const r2 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r2.firstValidDelivery).toBe(true);

    const r3 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r3.created).toBe(false);
    expect(r3.firstValidDelivery).toBe(false);
    expect(r3.deliveryCount).toBe(3);
  });

  it("UPDATE staying signature_ok:false (still bad) → firstValidDelivery:false, signature_ok stays false", async () => {
    const { db } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: false,
    });
    const r2 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: HASH_2,
      signatureOk: false,
    });
    expect(r1.firstValidDelivery).toBe(false);
    expect(r2.firstValidDelivery).toBe(false);
    expect(r2.deliveryCount).toBe(2);

    const rows = await db.execute(
      `SELECT signature_ok FROM webhook_events WHERE id = '${r2.webhookId}'`,
    );
    expect((rows.rows[0] as { signature_ok: boolean }).signature_ok).toBe(false);
  });

  it("sticky-true: once signature_ok flips to true, a LATER false delivery does not flip it back", async () => {
    const { db, bindingId } = await freshIntakeDb();
    await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    // Hostile or buggy retry with no signature.
    const r2 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: HASH_2,
      signatureOk: false,
    });
    expect(r2.firstValidDelivery).toBe(false);
    const rows = await db.execute(
      `SELECT signature_ok FROM webhook_events WHERE id = '${r2.webhookId}'`,
    );
    // Row stays signature_ok=true; the FALSE delivery cannot un-validate.
    expect((rows.rows[0] as { signature_ok: boolean }).signature_ok).toBe(true);
  });

  it("sticky-non-null binding_id: once set, a LATER call without bindingId does not unset it", async () => {
    const { db, bindingId } = await freshIntakeDb();
    await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    const r2 = await recordWebhook({
      db,
      provider: "gitea",
      eventId: "evt-1",
      payloadHash: HASH_2,
      signatureOk: false,
      // no bindingId — sticky-non-null COALESCE keeps the existing value.
    });
    const rows = await db.execute(
      `SELECT binding_id FROM webhook_events WHERE id = '${r2.webhookId}'`,
    );
    expect((rows.rows[0] as { binding_id: string }).binding_id).toBe(bindingId);
  });

  it("eventId:undefined path always returns firstValidDelivery=signatureOk (no dedupe = no flip path)", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const r1 = await recordWebhook({
      db,
      provider: "anonymous",
      eventId: undefined,
      payloadHash: PAYLOAD_HASH,
      signatureOk: true,
      bindingId,
    });
    expect(r1.firstValidDelivery).toBe(true);
    const r2 = await recordWebhook({
      db,
      provider: "anonymous",
      eventId: undefined,
      payloadHash: PAYLOAD_HASH,
      signatureOk: false,
    });
    expect(r2.firstValidDelivery).toBe(false);
  });
});
