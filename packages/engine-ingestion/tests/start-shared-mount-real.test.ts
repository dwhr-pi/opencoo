/**
 * PR-Q6 (phase-a appendix #9) — real-listen integration test for
 * the shared-Fastify-mount path.
 *
 * The unit-level `start-webhook-mount.test.ts` shared-mount test
 * stubs `app.listen()` to a no-op, which masks two failure modes
 * the reviewer flagged on PR #72:
 *
 *   1. `addContentTypeParser` throws `FST_ERR_INSTANCE_ALREADY_STARTED`
 *      when called after `app.listen()` (Fastify hardens the routing
 *      tree on `ready()`). The first-pass shared-mount path called
 *      `mountWebhookRoute(sharedFastify, ctx)` from inside ingestion's
 *      `start()` — but the orchestrator has ALREADY awaited
 *      `selfOpEngine = await startFactory(...)` which calls
 *      `app.listen()` internally. So the parser registration always
 *      throws against a real listener.
 *
 *   2. Registering `application/json` with `parseAs: 'buffer'` at the
 *      ROOT context replaces Fastify's default JSON parser for every
 *      route. Admin routes (`/api/admin/*`) then see `req.body` as a
 *      `Buffer` instead of a parsed object — every Zod schema parse
 *      fails with a non-actionable error.
 *
 * The fix:
 *   - The orchestrator threads a pre-listen hook into self-op's
 *     `start()` that mounts the webhook route + parser BEFORE
 *     `app.listen()`.
 *   - `registerWebhookRoute` wraps its setup inside
 *     `app.register(async (scope) => { ... })` so the parser is
 *     scoped to the plugin and does NOT leak to admin routes at
 *     the root.
 *
 * This test exercises both invariants against a REAL Fastify listener
 * on an ephemeral port — `listen()` runs, ready() fires, and we
 * `fetch()` real HTTP requests to assert behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { z } from "zod";

import { buildServer } from "@opencoo/shared/engine-scaffold";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { HmacSha256Verifier } from "@opencoo/shared/webhook-verifier";

import {
  registerWebhookRoute,
  WEBHOOK_BODY_LIMIT_BYTES,
} from "../src/intake/webhook-receiver.js";
import { InMemoryAdapterRegistry } from "../src/intake/adapter-registry.js";
import { freshIntakeDb } from "./intake/_pglite-fixture.js";
import type { WebhookReceiverOptions } from "../src/intake/webhook-receiver.js";

const SECRET_PLAINTEXT = Buffer.from("test-shared-secret", "utf8");

function signHex(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: {
      write(): boolean {
        return true;
      },
    },
  });
}

interface BuiltMount {
  readonly app: FastifyInstance;
  readonly bindingId: string;
  readonly url: string;
  close(): Promise<void>;
}

/** Build a real Fastify with both:
 *   - an admin-style POST route that uses Fastify's default JSON parser
 *     (mimics `/api/admin/*` handlers expecting `req.body` as object)
 *   - the webhook-receiver mount via `registerWebhookRoute`
 *
 * Then `app.listen()` on an ephemeral port. The test fetch()es real
 * HTTP traffic against the listener so any `addContentTypeParser`
 * boot-ordering bug or parser-leak surfaces. */
async function buildRealListener(): Promise<BuiltMount> {
  const fixture = await freshIntakeDb();

  const credentialStore = new InMemoryCredentialStore({
    logger: silentLogger(),
  });
  const credentialId = await credentialStore.write({
    name: "drive-webhook-secret",
    schemaRef: "webhook/v1",
    plaintext: SECRET_PLAINTEXT,
  });
  await fixture.db.execute(
    `UPDATE sources_bindings SET credentials_id = '${credentialId}' WHERE id = '${fixture.bindingId}'`,
  );

  const adapterRegistry = new InMemoryAdapterRegistry();
  adapterRegistry.register({ slug: "drive" });

  const scannerQueue = { add: vi.fn(async () => undefined) };
  const dlqQueue = { add: vi.fn(async () => undefined) };
  const scannerClassifyQueue = { add: vi.fn(async () => undefined) };

  const app: FastifyInstance = buildServer({
    probes: {},
    bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
  });

  // Register an admin-style route BEFORE the webhook plugin scope.
  // This route relies on Fastify's DEFAULT JSON parser to populate
  // `req.body` as an object. If the webhook parser leaks to the root
  // context, this route's body is a Buffer and the Zod parse fails.
  const AdminPing = z.object({ hello: z.string() });
  app.post("/api/admin/ping", async (req, reply) => {
    const parsed = AdminPing.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, reason: "schema_failed", body: typeof req.body };
    }
    return { ok: true, hello: parsed.data.hello };
  });

  // Mount the webhook receiver — this is the registration call that
  // (a) MUST run before `app.listen()` for the content-type parser
  //     to register cleanly,
  // (b) MUST scope the parser via `app.register` so it doesn't
  //     replace the default JSON parser at the root.
  const opts: WebhookReceiverOptions = {
    db: fixture.db as unknown as WebhookReceiverOptions["db"],
    credentialStore,
    adapterRegistry,
    verifier: new HmacSha256Verifier(),
    scannerQueue,
    dlqQueue,
    scannerClassifyQueue,
    appLogger: silentLogger(),
  };
  registerWebhookRoute(app, opts);

  // Real listen on ephemeral port. If `addContentTypeParser`
  // somehow ran AFTER ready() this would never get here.
  const url = await app.listen({ host: "127.0.0.1", port: 0 });

  return {
    app,
    bindingId: fixture.bindingId,
    url,
    async close(): Promise<void> {
      await app.close();
    },
  };
}

describe("real-listen integration: webhook plugin scope does not leak parser to admin routes (PR-Q6)", () => {
  const builders: BuiltMount[] = [];
  afterEach(async () => {
    for (const b of builders.splice(0)) {
      await b.close().catch(() => undefined);
    }
  });

  it("admin route receives the JSON body as a parsed object (Fastify default parser still wins outside the webhook plugin scope)", async () => {
    const built = await buildRealListener();
    builders.push(built);

    const res = await fetch(`${built.url}/api/admin/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hello?: string; reason?: string };
    // If the webhook plugin's parser leaked to the root, req.body
    // would be a Buffer — the Zod parse would fail and we'd get
    // ok: false / reason: "schema_failed".
    expect(body.ok).toBe(true);
    expect(body.hello).toBe("world");
  });

  it("webhook route accepts a 2 MB raw body (5 MB body limit threaded through, no 413)", async () => {
    const built = await buildRealListener();
    builders.push(built);

    // 2 MB of repeated JSON bytes — well under the 5 MB cap, but
    // far over Fastify's default 1 MB. If the body limit was NOT
    // raised on the shared listener the receiver would 413.
    const filler = "x".repeat(2 * 1024 * 1024 - 32);
    const body = JSON.stringify({ event: "push", filler });
    const res = await fetch(`${built.url}/webhooks/${built.bindingId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-real-1",
        "x-provider": "gitea",
      },
      body,
    });

    // Pre-fix this would 413 or 500 (depending on which parser
    // stack ran first). Post-fix the receiver verifies the
    // signature against the raw bytes and returns 200.
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: boolean };
    expect(json.accepted).toBe(true);
  });

  it("registering the webhook route AFTER app.listen() throws — the orchestrator MUST mount via a pre-listen hook", async () => {
    // Pin the boot-ordering invariant: addContentTypeParser is
    // rejected once the Fastify instance is ready/listening. This
    // is the failure mode the first-pass shared-mount path hit in
    // production — it called mountWebhookRoute from inside the
    // ingestion start() which runs AFTER self-op's app.listen().
    const fixture = await freshIntakeDb();
    const credentialStore = new InMemoryCredentialStore({
      logger: silentLogger(),
    });

    const app: FastifyInstance = Fastify({ bodyLimit: WEBHOOK_BODY_LIMIT_BYTES });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const opts: WebhookReceiverOptions = {
      db: fixture.db as unknown as WebhookReceiverOptions["db"],
      credentialStore,
      adapterRegistry: new InMemoryAdapterRegistry(),
      verifier: new HmacSha256Verifier(),
      scannerQueue: { add: vi.fn(async () => undefined) },
      dlqQueue: { add: vi.fn(async () => undefined) },
      scannerClassifyQueue: { add: vi.fn(async () => undefined) },
      appLogger: silentLogger(),
    };

    // Fastify rejects `addContentTypeParser` after listen — this is
    // the symptom the reviewer flagged. We capture it explicitly so
    // any future regression that re-introduces post-listen mounting
    // surfaces here, not as a runtime CrashLoop in production.
    expect(() => registerWebhookRoute(app, opts)).toThrow(
      /already (started|booted)|FST_ERR_INSTANCE_ALREADY_STARTED|after start/i,
    );

    await app.close();
  });
});
