/**
 * Webhook receiver — Fastify plugin that mounts a single route:
 *
 *   POST /webhooks/:bindingId
 *
 * Flow:
 *   1. Parse `:bindingId` from the URL path; resolve from
 *      sources_bindings. Unknown id → 404, no DB writes, no
 *      queue dispatches.
 *   2. Look up the SourceAdapter via adapterRegistry.require(
 *      binding.adapter_slug). Unknown adapter → 500 + DLQ
 *      (caller-bug-on-our-side: the binding exists but no
 *      adapter is wired).
 *   3. Read the HMAC secret via credentialStore.read(binding.
 *      credentialsId). The store's audit log fires here.
 *   4. Verify signature via injected WebhookVerifier on the
 *      RAW request body. Headers we accept:
 *        x-signature   — hex or `sha256=<hex>` (Gitea/GitHub style)
 *        x-event-id    — provider's idempotency key (optional)
 *        x-provider    — short slug (gitea / github / drive / …)
 *   5. INSERT/UPDATE webhook_events via recordWebhook. On
 *      duplicate event-id, delivery_count bumps but we still
 *      reply 200 — and SKIP the scanner enqueue (the upstream
 *      provider duplicated, not a new event).
 *   6. On signature mismatch: 401 + DLQ enqueue + signature_ok=false
 *      row. NO scanner enqueue.
 *   7. On signature ok + fresh insert: 200 + scanner enqueue.
 *
 * Body size cap: 5MB (Q13). Request bodies above the cap get a
 * 413 from Fastify before the handler ever runs.
 *
 * The receiver is constructed with everything it depends on via
 * DI — no env reads, no LLM, no wiki writes. boundary rules all
 * pass by construction.
 */
import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

import {
  sourcesBindings,
} from "@opencoo/shared/db/schema";
import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import type { WebhookVerifier } from "@opencoo/shared/webhook-verifier";

import type { InMemoryAdapterRegistry } from "./adapter-registry.js";
import { recordWebhook } from "./record-webhook.js";

export const WEBHOOK_BODY_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB

export interface WebhookQueueLike {
  /** BullMQ Queue.add subset — name + payload + opts. v0.1 only
   *  needs `add`; full Queue surface lands with Scanner in PR 15+. */
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
}

export interface WebhookReceiverOptions {
  readonly db: PgDatabase<never, Record<string, never>, Record<string, never>>;
  readonly credentialStore: CredentialStore;
  readonly adapterRegistry: InMemoryAdapterRegistry;
  readonly verifier: WebhookVerifier;
  readonly scannerQueue: WebhookQueueLike;
  readonly dlqQueue: WebhookQueueLike;
  readonly logger?: boolean;
}

interface BindingRow {
  readonly id: string;
  readonly adapterSlug: string;
  readonly credentialsId: string | null;
}

export function buildWebhookReceiver(
  options: WebhookReceiverOptions,
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
  });

  // Capture the RAW request body. Fastify's default JSON parser
  // discards bytes after parsing; we need the exact bytes the
  // sender hashed for HMAC verification.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body: Buffer, done) => {
      // Stash the raw buffer; downstream handler reads + parses.
      done(null, body);
    },
  );

  app.post<{
    Params: { bindingId: string };
    Headers: {
      "x-signature"?: string;
      "x-event-id"?: string;
      "x-provider"?: string;
    };
  }>("/webhooks/:bindingId", async (req, reply) => {
    const { bindingId } = req.params;

    // Step 1: resolve the binding.
    const bindingRows = await options.db
      .select({
        id: sourcesBindings.id,
        adapterSlug: sourcesBindings.adapterSlug,
        credentialsId: sourcesBindings.credentialsId,
      })
      .from(sourcesBindings)
      .where(eq(sourcesBindings.id, bindingId))
      .limit(1);
    const binding: BindingRow | undefined = bindingRows[0];
    if (binding === undefined) {
      reply.code(404);
      return { accepted: false, reason: "binding not found" };
    }

    // Step 2: confirm the adapter is registered. We don't need the
    // adapter object itself in this PR — PR 23+ widens the surface
    // to call adapter.verifyWebhook / adapter.fetchPayload through
    // it; today we just gate on registration.
    if (options.adapterRegistry.get(binding.adapterSlug) === undefined) {
      // The binding references an adapter slug that isn't wired —
      // operator config bug. DLQ for triage; reply 500.
      await options.dlqQueue.add("intake.dlq", {
        bindingId,
        reason: `adapter '${binding.adapterSlug}' not registered`,
      });
      reply.code(500);
      return {
        accepted: false,
        reason: `adapter '${binding.adapterSlug}' not registered`,
      };
    }

    // Step 3: read the HMAC secret.
    if (binding.credentialsId === null) {
      // Binding has no credentials wired — also an operator config
      // bug. DLQ + 500.
      await options.dlqQueue.add("intake.dlq", {
        bindingId,
        reason: "binding has no credentials_id",
      });
      reply.code(500);
      return {
        accepted: false,
        reason: "binding has no credentials_id",
      };
    }
    const credential = await options.credentialStore.read(
      binding.credentialsId as CredentialId,
    );

    // Step 4: verify signature on the raw body.
    const rawBody = req.body as Buffer;
    const signature = req.headers["x-signature"];
    const provider = req.headers["x-provider"] ?? binding.adapterSlug;
    const eventId = req.headers["x-event-id"];

    const verifyResult = options.verifier.verify({
      body: rawBody,
      secret: credential.plaintext,
      signature,
    });

    // Compute payload hash (SHA-256 hex of the raw body) regardless
    // of signature outcome — operators need this to dedupe even
    // failed deliveries.
    const payloadHash = `sha256:${createHash("sha256")
      .update(rawBody)
      .digest("hex")}`;

    // Step 5: write the webhook_events row (Q12 dedupe).
    // Conditional spread: under exactOptionalPropertyTypes, the
    // RecordWebhookArgs.bindingId field cannot accept `undefined` —
    // it has to be ABSENT, not present-but-undefined. Same for
    // eventId.
    const writeResult = await recordWebhook({
      db: options.db,
      provider,
      eventId,
      payloadHash,
      signatureOk: verifyResult.ok,
      ...(verifyResult.ok ? { bindingId } : {}),
    });

    // Step 6: signature mismatch path.
    if (!verifyResult.ok) {
      await options.dlqQueue.add("intake.dlq", {
        webhookId: writeResult.webhookId,
        bindingId,
        provider,
        eventId,
        reason: verifyResult.reason,
      });
      reply.code(401);
      return {
        accepted: false,
        reason: `webhook signature: ${verifyResult.reason}`,
      };
    }

    // Step 7: ok-path. Enqueue the scanner job iff this delivery is
    // either (a) brand new OR (b) the first valid-signature delivery
    // for an event we'd previously seen with a bad signature
    // (sticky-true upgrade, copilot #16). The dedupe-only path
    // (`created:false && firstValidDelivery:false`) is a true
    // duplicate — the upstream provider re-sent us the SAME event
    // and we already dispatched a scanner job for it.
    if (writeResult.created || writeResult.firstValidDelivery) {
      await options.scannerQueue.add("intake.scanner", {
        webhookId: writeResult.webhookId,
        bindingId,
        provider,
        eventId: eventId ?? null,
      });
    }

    return {
      accepted: true,
      webhookId: writeResult.webhookId,
      deliveryCount: writeResult.deliveryCount,
    };
  });

  return app;
}
