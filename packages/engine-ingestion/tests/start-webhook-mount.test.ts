/**
 * Round-2 fix (Copilot #56) — `start({ mode: 'workers' })` mounts
 * the webhook receiver onto the engine's primary Fastify app.
 *
 * Before this fix, `buildWebhookReceiver` was exported but never
 * called in production: `engine-ingestion.start.ts` only mounted
 * `/health` + `/ready` probes via the engine-scaffold serverFactory,
 * so the runbook's "drop a tagged Asana task → wait 10s → see
 * webhook_events row" claim was a lie, and the
 * `webhook_receiver.signature_invalid` debug log added in PR-N1 was
 * unreachable in a real `pnpm opencoo` deployment.
 *
 * These tests pin:
 *   1. mode='workers' actually registers `POST /webhooks/:bindingId`
 *      on the engine's Fastify app — a real signed POST round-trips
 *      with status 200 and writes a `webhook_events` row.
 *   2. mode='workers' also accepts the malformed-signature path —
 *      a bad signature returns 401 and the receiver enqueues onto
 *      the WorkerContext's `webhookDlqQueue`.
 *   3. mode='probes-only' (the default) does NOT register the
 *      receiver — `POST /webhooks/<id>` returns 404 from Fastify's
 *      default not-found handler.
 *   4. mode='workers' with a workerContext missing any of
 *      `credentialStore` / `webhookVerifier` / `webhookScannerQueue`
 *      / `webhookDlqQueue` throws at boot — composition-root bug
 *      surfaces immediately, not on first POST.
 *
 * The test injects a custom `serverFactory` that returns a real
 * Fastify instance with `listen` stubbed to a no-op (so the test
 * doesn't bind a port). `inject()` works against the unbound
 * Fastify, exercising the route + parser registration that
 * `start.ts` performs BEFORE the (stubbed) listen call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import { start } from "../src/start.js";
import {
  buildServer,
  type ProbeMap,
} from "@opencoo/shared/engine-scaffold";
import { WEBHOOK_BODY_LIMIT_BYTES } from "../src/intake/webhook-receiver.js";
import { InMemoryAdapterRegistry } from "../src/intake/adapter-registry.js";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { HmacSha256Verifier } from "@opencoo/shared/webhook-verifier";

import { freshIntakeDb } from "./intake/_pglite-fixture.js";
import type { WorkerContext } from "../src/workers/index.js";

const validEnv = {
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost:6379",
  GITEA_URL: "https://gitea.test",
};

function makeStubPool() {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    end: vi.fn(async () => undefined),
  };
}

function makeStubRedis() {
  return {
    ping: vi.fn(async () => "PONG"),
    disconnect: vi.fn(),
  };
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

const SECRET_PLAINTEXT = Buffer.from("test-shared-secret", "utf8");

function signHex(secret: Buffer, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

interface QueueRecorder {
  add: ReturnType<typeof vi.fn>;
}

function makeRecorder(): QueueRecorder {
  return { add: vi.fn(async () => undefined) };
}

/**
 * Build a real Fastify with `listen` stubbed to a no-op so the
 * test doesn't bind a port. `close()` is forwarded so the engine's
 * shutdown still cleans up Fastify's internal state. `inject()`
 * works against the unbound instance.
 */
function buildTestServerFactory(captured: { app?: FastifyInstance }) {
  return async (probes: ProbeMap): Promise<FastifyInstance> => {
    // Use the same buildServer() the production default uses so
    // the bodyLimit + probe wiring match what `pnpm opencoo` runs.
    const app = buildServer({
      probes,
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
    });
    captured.app = app;

    // No-op listen so we don't actually bind a port.
    const originalListen = app.listen.bind(app);
    void originalListen;
    (app as unknown as { listen: () => Promise<void> }).listen =
      async (): Promise<void> => undefined;
    return app;
  };
}

/** Build a minimum WorkerContext that satisfies start()'s
 *  validation. Only fields the receiver mount path consumes are
 *  populated — the actual workers are constructed by start.ts but
 *  never run a job in these tests because we never push to
 *  Redis. */
async function buildTestWorkerContext(opts: {
  readonly omit?: ReadonlyArray<
    | "credentialStore"
    | "webhookVerifier"
    | "webhookScannerQueue"
    | "webhookDlqQueue"
  >;
} = {}) {
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

  const webhookScannerQueue = makeRecorder();
  const webhookDlqQueue = makeRecorder();

  const omit = new Set(opts.omit ?? []);

  const ctx = {
    db: fixture.db,
    logger: silentLogger(),
    router: {} as never,
    wikiDeps: {} as never,
    wikiAdapter: {} as never,
    author: { name: "test", email: "test@example.com" },
    guardAdapter: {} as never,
    adapterRegistry,
    ...(omit.has("credentialStore") ? {} : { credentialStore }),
    ...(omit.has("webhookVerifier")
      ? {}
      : { webhookVerifier: new HmacSha256Verifier() }),
    ...(omit.has("webhookScannerQueue")
      ? {}
      : { webhookScannerQueue }),
    ...(omit.has("webhookDlqQueue") ? {} : { webhookDlqQueue }),
  } as unknown as WorkerContext;

  return {
    ctx,
    fixture,
    webhookScannerQueue,
    webhookDlqQueue,
    credentialStore,
    adapterRegistry,
  };
}

describe("start({ mode: 'workers' }) — mounts the webhook receiver on the engine app", () => {
  // Track engines so we can close them in afterEach even on test
  // failure — leaked BullMQ Workers + ioredis-mock connections
  // hold the event loop open.
  const enginesToClose: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const e of enginesToClose.splice(0)) {
      await e.close().catch(() => undefined);
    }
  });

  it("POST with valid signature → 200 + webhook_events row + scanner enqueue", async () => {
    const captured: { app?: FastifyInstance } = {};
    const { ctx, fixture, webhookScannerQueue, webhookDlqQueue } =
      await buildTestWorkerContext();

    const engine = await start({
      env: validEnv,
      mode: "workers",
      workerContext: ctx,
      workerConnection: { host: "localhost", port: 6379 },
      dbFactory: () => makeStubPool(),
      redisFactory: () => makeStubRedis(),
      serverFactory: buildTestServerFactory(captured),
    });
    enginesToClose.push(engine);

    expect(captured.app).toBeDefined();
    const app = captured.app!;

    const body = '{"event":"push"}';
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${fixture.bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-mounted-1",
        "x-provider": "gitea",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json() as { accepted: boolean };
    expect(json.accepted).toBe(true);

    const rows = await fixture.db.execute(
      `SELECT id, signature_ok FROM webhook_events`,
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { signature_ok: boolean }).signature_ok).toBe(true);

    expect(webhookScannerQueue.add).toHaveBeenCalledTimes(1);
    expect(webhookDlqQueue.add).not.toHaveBeenCalled();
  });

  it("POST with invalid signature → 401 + DLQ enqueue (the rejection path now reachable in production)", async () => {
    const captured: { app?: FastifyInstance } = {};
    const { ctx, fixture, webhookScannerQueue, webhookDlqQueue } =
      await buildTestWorkerContext();

    const engine = await start({
      env: validEnv,
      mode: "workers",
      workerContext: ctx,
      workerConnection: { host: "localhost", port: 6379 },
      dbFactory: () => makeStubPool(),
      redisFactory: () => makeStubRedis(),
      serverFactory: buildTestServerFactory(captured),
    });
    enginesToClose.push(engine);

    const res = await captured.app!.inject({
      method: "POST",
      url: `/webhooks/${fixture.bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": "sha256=" + "0".repeat(64),
        "x-event-id": "evt-bad",
        "x-provider": "gitea",
      },
      payload: '{"event":"push"}',
    });

    expect(res.statusCode).toBe(401);
    expect(webhookScannerQueue.add).not.toHaveBeenCalled();
    expect(webhookDlqQueue.add).toHaveBeenCalledTimes(1);
  });
});

describe("start({ mode: 'probes-only' }) — does NOT mount the webhook receiver", () => {
  const enginesToClose: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const e of enginesToClose.splice(0)) {
      await e.close().catch(() => undefined);
    }
  });

  it("POST /webhooks/<id> returns 404 — receiver was never registered", async () => {
    // Build a real Fastify via the same factory the production
    // default uses, but DON'T pass a workerContext — so start.ts's
    // workers-mode branch (which mounts the receiver) is skipped.
    const captured: { app?: FastifyInstance } = {};

    const engine = await start({
      env: validEnv,
      // mode defaults to 'probes-only'
      dbFactory: () => makeStubPool(),
      redisFactory: () => makeStubRedis(),
      serverFactory: async (probes: ProbeMap): Promise<FastifyInstance> => {
        const app = Fastify({ logger: false });
        app.get("/health", async () => ({ status: "ok" }));
        app.get("/ready", async () => ({ status: "ready", probes }));
        captured.app = app;
        (app as unknown as { listen: () => Promise<void> }).listen =
          async (): Promise<void> => undefined;
        return app;
      },
    });
    enginesToClose.push(engine);

    const res = await captured.app!.inject({
      method: "POST",
      url: "/webhooks/00000000-0000-0000-0000-000000000099",
      payload: "{}",
      headers: { "content-type": "application/json" },
    });

    // Fastify's default not-found handler returns 404; no
    // webhook receiver was registered in probes-only mode.
    expect(res.statusCode).toBe(404);
  });
});

describe("start({ mode: 'workers' }) — composition-root bug surfaces at boot", () => {
  it.each([
    ["credentialStore"],
    ["webhookVerifier"],
    ["webhookScannerQueue"],
    ["webhookDlqQueue"],
  ] as const)(
    "missing WorkerContext.%s → throws before app.listen",
    async (missingField) => {
      const { ctx } = await buildTestWorkerContext({ omit: [missingField] });

      await expect(
        start({
          env: validEnv,
          mode: "workers",
          workerContext: ctx,
          workerConnection: { host: "localhost", port: 6379 },
          dbFactory: () => makeStubPool(),
          redisFactory: () => makeStubRedis(),
          serverFactory: buildTestServerFactory({}),
        }),
      ).rejects.toThrow(new RegExp(missingField));
    },
  );
});
