/**
 * recordWebhook — INSERT-or-upgrade into webhook_events.
 *
 * Q12 (option a) approved: a duplicate `(provider, event_id)` row
 * is UPDATEd rather than ignored. The webhook_events table is NOT in
 * `APPEND_ONLY_TABLES` (verified against
 * `tools/eslint-plugin-opencoo/src/rules/no-update-append-only.ts`,
 * 6 entries: pageCitations, redactionEvents, erasureLog,
 * minerSuppressions, agentRuns, llmUsageDebug); the schema's
 * `delivery_count` column was deliberately designed for this
 * idempotency-via-update pattern.
 *
 * Sticky-true sig upgrade (copilot #16 Comments 3+4): on UPDATE,
 *   signature_ok ← old.signature_ok || excluded.signature_ok
 *   binding_id   ← COALESCE(old.binding_id, excluded.binding_id)
 *   delivery_count ← old.delivery_count + 1
 * so a transient verifier failure (or temporarily-misconfigured
 * secret) on the FIRST delivery can be retroactively upgraded by a
 * later valid delivery — webhook providers retry 3-5x by design,
 * and we must not lock them out of the scanner queue.
 *
 * `firstValidDelivery` distinguishes the "this is the first delivery
 * we've seen with a valid signature for this event-id" event:
 *   - fresh INSERT with signatureOk:true → true
 *   - fresh INSERT with signatureOk:false → false
 *   - UPDATE flipping false→true → true
 *   - UPDATE keeping true→true (already valid) → false
 *   - UPDATE keeping false→false (still bad) → false
 * The receiver gates scanner enqueue on `created || firstValidDelivery`
 * so legitimate retries after a transient first-delivery failure get
 * dispatched.
 *
 * Rows without `event_id` ALWAYS INSERT — the partial UNIQUE index
 * has `WHERE event_id IS NOT NULL`, so collision detection is
 * impossible for unkeyed deliveries. `firstValidDelivery` for that
 * path is just the input `signatureOk` (no upgrade-from-false story
 * exists when every delivery is its own row).
 *
 * Implementation note: the dedupe path uses an explicit transactional
 * read-then-write rather than ON CONFLICT DO UPDATE because we need
 * the OLD signature_ok to compute `firstValidDelivery`, and Postgres'
 * RETURNING only sees post-UPDATE values. The transaction keeps the
 * read+write atomic. Volume is webhook deliveries (low frequency,
 * not request-path), so the extra round-trip cost is acceptable.
 *
 * `payload` defaults to null (Q13 privacy). PR 23+ adapters opt in
 * to retaining the payload by setting an explicit retention policy
 * on the binding.
 */
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { webhookEvents } from "@opencoo/shared/db/schema";

export interface RecordWebhookArgs {
  readonly db: PgDatabase<never, Record<string, never>, Record<string, never>>;
  readonly provider: string;
  /** Idempotency key from the upstream provider. `undefined` means
   *  the provider didn't send one — every delivery becomes a new row. */
  readonly eventId: string | undefined;
  readonly payloadHash: string;
  readonly signatureOk: boolean;
  readonly bindingId?: string;
}

export interface RecordWebhookResult {
  readonly created: boolean;
  readonly webhookId: string;
  readonly deliveryCount: number;
  /** True iff this delivery is the first one we've seen with
   *  signatureOk:true for this `(provider, event_id)`. The receiver
   *  uses this AND `created` to decide whether to enqueue the
   *  scanner job (see header for the full state machine). */
  readonly firstValidDelivery: boolean;
}

export async function recordWebhook(
  args: RecordWebhookArgs,
): Promise<RecordWebhookResult> {
  // Path A: no event_id → always INSERT a new row. The partial
  // UNIQUE index ignores rows where event_id IS NULL, so we cannot
  // dedupe and we must not pretend to. `firstValidDelivery` for
  // this path is just the input `signatureOk` — no upgrade story.
  if (args.eventId === undefined) {
    const inserted = await args.db
      .insert(webhookEvents)
      .values({
        provider: args.provider,
        eventId: null,
        payloadHash: args.payloadHash,
        signatureOk: args.signatureOk,
        ...(args.bindingId !== undefined ? { bindingId: args.bindingId } : {}),
      })
      .returning({
        id: webhookEvents.id,
        deliveryCount: webhookEvents.deliveryCount,
      });
    if (inserted.length === 0) {
      throw new Error("recordWebhook: INSERT produced no rows");
    }
    const row = inserted[0]!;
    return {
      created: true,
      webhookId: row.id,
      deliveryCount: row.deliveryCount,
      firstValidDelivery: args.signatureOk,
    };
  }

  // Path B: event_id present → SELECT existing, then INSERT or
  // UPDATE inside a transaction. The transaction is what keeps
  // the read-then-write atomic under concurrent retries.
  return args.db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: webhookEvents.id,
        signatureOk: webhookEvents.signatureOk,
        deliveryCount: webhookEvents.deliveryCount,
        bindingId: webhookEvents.bindingId,
      })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, args.provider),
          eq(webhookEvents.eventId, args.eventId!),
        ),
      )
      .limit(1);

    const oldRow = existing[0];

    if (oldRow === undefined) {
      // Fresh INSERT.
      const inserted = await tx
        .insert(webhookEvents)
        .values({
          provider: args.provider,
          eventId: args.eventId!,
          payloadHash: args.payloadHash,
          signatureOk: args.signatureOk,
          ...(args.bindingId !== undefined ? { bindingId: args.bindingId } : {}),
        })
        .returning({
          id: webhookEvents.id,
          deliveryCount: webhookEvents.deliveryCount,
        });
      if (inserted.length === 0) {
        throw new Error("recordWebhook: INSERT produced no rows");
      }
      const row = inserted[0]!;
      return {
        created: true,
        webhookId: row.id,
        deliveryCount: row.deliveryCount,
        firstValidDelivery: args.signatureOk,
      };
    }

    // UPDATE — sticky-true sig upgrade + sticky-non-null binding.
    const newSignatureOk = oldRow.signatureOk || args.signatureOk;
    const newBindingId = oldRow.bindingId ?? args.bindingId ?? null;

    await tx
      .update(webhookEvents)
      .set({
        signatureOk: newSignatureOk,
        ...(newBindingId !== null ? { bindingId: newBindingId } : {}),
        deliveryCount: sql`${webhookEvents.deliveryCount} + 1`,
        receivedAt: sql`now()`,
      })
      .where(eq(webhookEvents.id, oldRow.id));

    // firstValidDelivery: true iff this UPDATE flipped sig false→true.
    // (already-true-staying-true and false-staying-false both → false.)
    const firstValidDelivery = !oldRow.signatureOk && args.signatureOk;

    return {
      created: false,
      webhookId: oldRow.id,
      deliveryCount: oldRow.deliveryCount + 1,
      firstValidDelivery,
    };
  });
}
