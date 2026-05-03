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
 *   2a. (PR-F) Per-adapter handshake detection: if the adapter
 *       exposes `webhook.handshakeFn` AND the request headers
 *       trigger a handshake result, run the handshake branch:
 *         - Persist the received secret to CredentialStore.
 *         - UPDATE sources_bindings.webhook_secret_credentials_id.
 *         - Echo the secret in the response header.
 *         - Return 200 without writing webhook_events or enqueueing.
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
import type { Logger } from "@opencoo/shared/logger";
import { scrubPat } from "@opencoo/shared/scrub";
import type { SourceWebhookHelpers } from "@opencoo/shared/source-adapter";
import type { WebhookVerifier } from "@opencoo/shared/webhook-verifier";

import type { SourceAdapterStub } from "./adapter-registry.js";
import { recordWebhook } from "./record-webhook.js";

export const WEBHOOK_BODY_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB

export interface WebhookQueueLike {
  /** BullMQ Queue.add subset — name + payload + opts. v0.1 only
   *  needs `add`; full Queue surface lands with Scanner in PR 15+. */
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
}

/**
 * Minimum structural shape the receiver consumes from an adapter
 * registry. Both the test-only `InMemoryAdapterRegistry` and the
 * production lazy-resolving registry from
 * `engine-ingestion/src/workers/production-context.ts` satisfy this
 * shape — keeping the receiver agnostic to the registry impl
 * (round-2 fix, Copilot #56: production mount needed a structural
 * registry type so the same receiver wires up against either).
 */
export interface WebhookAdapterRegistry {
  get(slug: string): SourceAdapterStub | undefined;
}

export interface WebhookReceiverOptions {
  readonly db: PgDatabase<never, Record<string, never>, Record<string, never>>;
  readonly credentialStore: CredentialStore;
  readonly adapterRegistry: WebhookAdapterRegistry;
  readonly verifier: WebhookVerifier;
  readonly scannerQueue: WebhookQueueLike;
  readonly dlqQueue: WebhookQueueLike;
  /** Enables Fastify's built-in request logger when true. Only
   *  consulted by `buildWebhookReceiver` (which constructs its own
   *  Fastify app); ignored by `registerWebhookRoute` (which
   *  registers the route on a caller-provided app whose logger is
   *  already configured). */
  readonly logger?: boolean;
  /** Application-level structured logger for audit events. */
  readonly appLogger?: Logger;
}

interface BindingRow {
  readonly id: string;
  readonly adapterSlug: string;
  readonly credentialsId: string | null;
  readonly webhookSecretCredentialsId: string | null;
}

/**
 * Type guard: narrows a `SourceAdapterStub` (slug-only) to a value
 * that also carries the optional `webhook` helpers. The registry stores
 * `SourceAdapterStub`s, but full adapters satisfy that shape too —
 * callers that need `webhook.handshakeFn` should use this guard rather
 * than casting, so the type error surfaces at compile-time if the
 * webhook surface changes.
 */
function hasWebhookHelpers(
  a: unknown,
): a is { webhook: SourceWebhookHelpers } {
  return (
    typeof a === "object" &&
    a !== null &&
    "webhook" in a &&
    typeof (a as Record<string, unknown>)["webhook"] === "object" &&
    (a as Record<string, unknown>)["webhook"] !== null
  );
}

/**
 * Register the `POST /webhooks/:bindingId` route + its raw-buffer
 * content-type parser onto an existing Fastify app.
 *
 * Used by:
 *   - `buildWebhookReceiver` (creates a dedicated Fastify app for
 *     unit tests and standalone usage), AND
 *   - `engine-ingestion/src/start.ts` (when `mode: 'workers'`
 *     mounts the receiver onto the engine's primary Fastify
 *     instance so a real `pnpm opencoo` process actually accepts
 *     webhook deliveries — round-2 fix, Copilot #56: without this
 *     mount, `recordWebhook` was dead in production and the
 *     `webhook_receiver.signature_invalid` log line never fired
 *     against a real deployment).
 *
 * MUST be called BEFORE `app.listen()` — Fastify rejects
 * `addContentTypeParser` calls after the server is ready. The
 * caller is responsible for ensuring boot ordering.
 *
 * The supplied app's `bodyLimit` is NOT touched here — the caller
 * is expected to construct the app with `WEBHOOK_BODY_LIMIT_BYTES`
 * if it serves any webhook traffic. (For an app that only serves
 * webhook traffic, `buildWebhookReceiver` enforces this; for the
 * shared engine app, `start.ts` configures the engine's Fastify
 * with the webhook body limit when `mode === 'workers'`.)
 */
export function registerWebhookRoute(
  app: FastifyInstance,
  options: WebhookReceiverOptions,
): void {
  // Capture the RAW request body. Fastify's default JSON parser
  // discards bytes after parsing; we need the exact bytes the
  // sender hashed for HMAC verification.
  //
  // Note: this REPLACES Fastify's default JSON parser at the root
  // context. Health/ready probes are GET routes with no request
  // body, so they're unaffected. Any future ingestion-engine route
  // that POSTs JSON would need to opt into the buffer parser via
  // an explicit `Content-Type` (e.g. `application/x-opencoo-json`).
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
      "x-hook-secret"?: string;
    };
  }>("/webhooks/:bindingId", async (req, reply) => {
    const { bindingId } = req.params;

    // Step 1: resolve the binding.
    const bindingRows = await options.db
      .select({
        id: sourcesBindings.id,
        adapterSlug: sourcesBindings.adapterSlug,
        credentialsId: sourcesBindings.credentialsId,
        webhookSecretCredentialsId: sourcesBindings.webhookSecretCredentialsId,
      })
      .from(sourcesBindings)
      .where(eq(sourcesBindings.id, bindingId))
      .limit(1);
    const binding: BindingRow | undefined = bindingRows[0];
    if (binding === undefined) {
      reply.code(404);
      return { accepted: false, reason: "binding not found" };
    }

    // Step 2: confirm the adapter is registered.
    // `get()` returns `SourceAdapterStub | undefined` (slug-only shape).
    // We use the `hasWebhookHelpers` guard below when we need the
    // optional webhook surface; no unsafe cast to `SourceAdapter`.
    const adapterStub = options.adapterRegistry.get(binding.adapterSlug);
    if (adapterStub === undefined) {
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

    // Step 2a (PR-F): per-adapter handshake detection.
    // Check BEFORE signature verification — handshake requests
    // have no signature (Asana's X-Hook-Secret is the whole message).
    const allHeaders = req.headers as Readonly<Record<string, string | string[] | undefined>>;
    const handshakeResult = hasWebhookHelpers(adapterStub)
      ? (adapterStub.webhook.handshakeFn?.(allHeaders) ?? null)
      : null;
    if (handshakeResult !== null) {
      // Persist the webhook secret to CredentialStore.
      const newCredId = await options.credentialStore.write({
        name: `${binding.adapterSlug}:webhook-secret:${bindingId}`,
        schemaRef: handshakeResult.schemaRef ?? `${binding.adapterSlug}:webhook_secret`,
        plaintext: Buffer.from(handshakeResult.secret, "utf8"),
      });

      // UPDATE sources_bindings.webhook_secret_credentials_id.
      await options.db
        .update(sourcesBindings)
        .set({ webhookSecretCredentialsId: newCredId })
        .where(eq(sourcesBindings.id, bindingId));

      // Audit log: handshake received and secret stored.
      // THREAT-MODEL §2 invariant 11: do NOT log the secret bytes.
      options.appLogger?.info("webhook.handshake.received", {
        bindingId,
        adapterSlug: binding.adapterSlug,
        credentialId: newCredId,
      });

      // Echo the secret header and return 200 with an empty body.
      // Asana expects an empty 200 — not a JSON `null` body — so we
      // use reply.send("") to suppress Fastify's default serialization.
      // No DLQ, no webhook_events row, no scanner enqueue.
      reply.header("x-hook-secret", handshakeResult.secret).code(200).send("");
      return;
    }

    // Step 3: read the HMAC secret.
    // Use webhookSecretCredentialsId if set (Asana uses a separate
    // webhook signing secret from the API credentials); fall back to
    // credentialsId for adapters that use the same credential.
    const hmacCredId =
      binding.webhookSecretCredentialsId ?? binding.credentialsId;

    if (hmacCredId === null) {
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
      hmacCredId as CredentialId,
    );

    // Step 4: verify signature on the raw body.
    // Receiver uses the fixed `x-signature` header per orchestrator
    // override 5; adapter-exported verifier symmetry (extractSignature)
    // enables per-scheme customisation post-v0.1 when adapters need
    // different header names (e.g. Asana's `x-hook-signature`).
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
      // (PR-N1, phase-a appendix #6) Pilot runbook §5 directs operators
      // to grep for this key in LOG_LEVEL=debug output to diagnose
      // failed-handshake situations. The line is INTENTIONALLY at debug
      // level — successful webhooks are voluminous in production, and
      // operators only need this trace when chasing a failure.
      //
      // THREAT-MODEL §2 invariant 11 + §3.6 (no raw secrets in logs):
      //   - We log the signature header NAME ("x-signature"), never
      //     the header VALUE.
      //   - We do not log the request body.
      //   - We `scrubPat` + cap `verifyResult.reason` defensively
      //     before logging. The current `HmacSha256Verifier` returns
      //     a closed-enum static string ("signature header missing",
      //     "signature is malformed (...)", "signature mismatch
      //     (HMAC differs)", "signature length mismatch (...)") which
      //     scrubs to itself. But the `WebhookVerifier` type contract
      //     just permits `string` — a future custom verifier could
      //     include user-supplied bytes (header values, body
      //     fragments, credential patterns). Defense in depth: scrub
      //     credential patterns and cap at 200 chars BEFORE the line
      //     reaches the operator log, mirroring the `safeError`
      //     helper in `workers/production-context.ts` and
      //     `cli/provision/production-composition.ts`.
      //   - Apply scrubPat BEFORE the slice so a credential pattern
      //     straddling the 200-char boundary is still redacted as a
      //     whole match.
      const ERROR_REASON_MAX_LENGTH = 200;
      const safeReason = scrubPat(verifyResult.reason).slice(
        0,
        ERROR_REASON_MAX_LENGTH,
      );
      options.appLogger?.debug("webhook_receiver.signature_invalid", {
        bindingId,
        provider: provider ?? binding.adapterSlug,
        eventId: eventId ?? null,
        signatureHeaderName: "x-signature",
        errorReason: safeReason,
      });

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

    // Step 7: ok-path.
    // (PR-G) If the adapter exposes parseEvents, unpack the raw body
    // into individual SourceWebhookEvents, then optionally enrich them
    // via enrichEvents?. Each resulting event gets its own scanner job.
    // Backward-compat: when webhook helpers are absent, fall back to
    // the pre-PR-G single-job enqueue path.
    if (writeResult.created || writeResult.firstValidDelivery) {
      if (hasWebhookHelpers(adapterStub)) {
        const parsedEvents = adapterStub.webhook.parseEvents({ body: rawBody });

        // (PR-G) enrichEvents hook — called after parseEvents, before
        // any scanner enqueues. Returns the (possibly augmented) event
        // array. When undefined, behavior is identical to pre-PR-G.
        const events =
          adapterStub.webhook.enrichEvents !== undefined
            ? await adapterStub.webhook.enrichEvents(parsedEvents)
            : parsedEvents;

        for (const event of events) {
          await options.scannerQueue.add("intake.scanner", {
            webhookId: writeResult.webhookId,
            bindingId,
            provider,
            eventId: event.eventId,
            sourceDocId: event.doc.sourceDocId,
            sourceRevision: event.doc.sourceRevision,
            sourceRef: event.doc.sourceRef,
          });
        }
      } else {
        // Pre-PR-G path: no parseEvents — enqueue a single binding-level
        // scanner job. The scanner pipeline fetches all pending events.
        await options.scannerQueue.add("intake.scanner", {
          webhookId: writeResult.webhookId,
          bindingId,
          provider,
          eventId: eventId ?? null,
        });
      }
    }

    return {
      accepted: true,
      webhookId: writeResult.webhookId,
      deliveryCount: writeResult.deliveryCount,
    };
  });
}

/**
 * Backwards-compatible factory: construct a dedicated Fastify app
 * with the webhook body limit and register the receiver route on it.
 *
 * Used by every receiver unit test (webhook-receiver.test.ts,
 * asana-handshake.test.ts, webhook-receiver-enrich.test.ts) that
 * wants a self-contained Fastify instance to `inject()` against
 * without needing to construct the engine's full server.
 *
 * Production usage goes through `registerWebhookRoute` directly so
 * the route mounts on the engine's primary Fastify app — see
 * `engine-ingestion/src/start.ts` mode='workers' branch.
 */
export function buildWebhookReceiver(
  options: WebhookReceiverOptions,
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
  });

  registerWebhookRoute(app, options);

  return app;
}
