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
 *  Redis.
 *
 *  PR-N2 round-2 (S1): `enqueue` is now part of start()'s
 *  required-in-mode='workers' set. The helper wires a recorder
 *  stub by default so existing tests keep passing; pass `omit:
 *  ['enqueue']` to exercise the new boot-validation throw. */
async function buildTestWorkerContext(opts: {
  readonly omit?: ReadonlyArray<
    | "credentialStore"
    | "webhookVerifier"
    | "webhookScannerQueue"
    | "webhookDlqQueue"
    | "enqueue"
  >;
  /** When true, register an adapter with `enrichEvents` AND attach
   *  the wired-by-default `enqueue` recorder so the PR-N2
   *  direct-intake path is exercised end-to-end. */
  readonly withDirectIntake?: boolean;
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
  if (opts.withDirectIntake === true) {
    // Replace the binding's adapter slug to one we register an
    // enrichEvents-capable stub for.
    await fixture.db.execute(
      `UPDATE sources_bindings SET adapter_slug = 'direct-intake' WHERE id = '${fixture.bindingId}'`,
    );
    adapterRegistry.register({
      slug: "direct-intake",
      webhook: {
        verifier: new HmacSha256Verifier(),
        extractSignature: (headers) =>
          typeof headers["x-signature"] === "string"
            ? headers["x-signature"]
            : undefined,
        parseEvents: () => [
          {
            eventId: "evt-mounted-direct",
            doc: {
              sourceDocId: "doc-mounted-direct",
              sourceRevision: "rev-mounted-direct",
              sourceRef: "test:doc/mounted",
              fetchedAt: new Date("2026-03-01T00:00:00Z"),
              contentBytes: Buffer.from('{"hello":"mount"}', "utf8"),
              metadata: { contentKind: "document" },
            },
          },
        ],
        enrichEvents: async (events) => events,
      },
    });
  } else {
    adapterRegistry.register({ slug: "drive" });
  }

  const webhookScannerQueue = makeRecorder();
  const webhookDlqQueue = makeRecorder();
  const scannerClassifyQueue = makeRecorder();

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
    // `enqueue` is required by mode='workers' since PR-N2 round-2.
    // Always present unless explicitly omitted.
    ...(omit.has("enqueue") ? {} : { enqueue: scannerClassifyQueue }),
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
    scannerClassifyQueue,
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

// (PR-N2, phase-a appendix #6) — when the mounted receiver is paired
// with an adapter that exposes `enrichEvents` AND the WorkerContext
// carries `enqueue` (the producer-side
// `ingestion.scanner.classify` queue handle), the receiver takes the
// direct-intake fast path: it INSERTs `ingestion_intake` rows itself
// and enqueues `ScannerClassifyJob` payloads inline. This pins the
// full webhook → intake → classify-enqueue flow under
// `mode: 'workers'`, the production boot mode.
describe("start({ mode: 'workers' }) — direct-intake fast path (PR-N2)", () => {
  const enginesToClose: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const e of enginesToClose.splice(0)) {
      await e.close().catch(() => undefined);
    }
  });

  it("POST with valid signature → ingestion_intake row inserted + ingestion.scanner.classify job enqueued", async () => {
    const captured: { app?: FastifyInstance } = {};
    const {
      ctx,
      fixture,
      webhookScannerQueue,
      webhookDlqQueue,
      scannerClassifyQueue,
    } = await buildTestWorkerContext({ withDirectIntake: true });

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

    const body = '{"event":"direct"}';
    const res = await captured.app!.inject({
      method: "POST",
      url: `/webhooks/${fixture.bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-mount-direct-1",
        "x-provider": "direct-intake",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    // ingestion_intake row landed inline.
    const intakeRows = await fixture.db.execute(
      `SELECT id, source_doc_id, source_revision FROM ingestion_intake`,
    );
    expect(intakeRows.rows).toHaveLength(1);
    expect((intakeRows.rows[0] as { source_doc_id: string }).source_doc_id).toBe(
      "doc-mounted-direct",
    );

    // The classify queue (ctx.enqueue, threaded through as
    // scannerClassifyQueue) received the per-document job.
    expect(scannerClassifyQueue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = scannerClassifyQueue.add.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("classify");
    expect(payload).toMatchObject({
      bindingId: fixture.bindingId,
      domainSlug: "test-domain",
      sourceRef: "test:doc/mounted",
      fetchedAt: "2026-03-01T00:00:00.000Z",
    });

    // The legacy intake.scanner queue is BYPASSED on the
    // direct-intake path.
    expect(webhookScannerQueue.add).not.toHaveBeenCalled();
    expect(webhookDlqQueue.add).not.toHaveBeenCalled();
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
  // PR-N2 round-2 (S1): `enqueue` is now required for mode='workers'
  // — symmetric with the other four. Without it the receiver's
  // PR-N2 direct-intake branch would silently fall through to the
  // legacy intake.scanner enqueue, and webhook deliveries would
  // pile in webhook_events without ever advancing to
  // ingestion_intake. Boot-validation surfaces the misconfiguration
  // immediately rather than letting it manifest as silent data loss
  // on the first webhook.
  it.each([
    ["credentialStore"],
    ["webhookVerifier"],
    ["webhookScannerQueue"],
    ["webhookDlqQueue"],
    ["enqueue"],
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

// PR-Q6 (phase-a appendix #9) — shared Fastify mount.
//
// In production the orchestrator (`packages/cli/src/commands/serve.ts`)
// pre-composes the WorkerContext, mounts the webhook route on the
// self-op engine's Fastify via a pre-listen hook, then boots
// `engine-self-operating` (whose `start()` calls `app.listen()`).
// The orchestrator then boots `engine-ingestion.start({ sharedFastify })`
// so the ingestion engine knows NOT to bind a second `:8080` socket
// (EADDRINUSE) — the route registration was already done by the hook.
//
// PR-Q6 fix-up split: the engine's `start({sharedFastify})` is now a
// "skip the listener" flag. Route mounting is the orchestrator's
// responsibility (via `mountWebhookRoute` exported from this package).
// These tests pin the contract:
//
//   1. With `sharedFastify`, the engine does NOT mount the route on
//      the shared instance (the orchestrator drives that step). The
//      orchestrator's mount call (simulated via `mountWebhookRoute`)
//      lands the route + parser; POST round-trips via Fastify.inject.
//   2. The engine's `close()` does NOT close the shared listener —
//      the self-op engine OWNS it. Workers + pg + Redis are still
//      drained.
//   3. Passing `sharedFastify` together with a `serverFactory` is
//      rejected at boot (mutually exclusive paths).
//   4. Passing `sharedFastify` with `mode='probes-only'` is rejected
//      at boot (the field exists for the receiver mount path).
describe("start({ mode: 'workers', sharedFastify }) — shared listener mount (PR-Q6)", () => {
  const enginesToClose: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const e of enginesToClose.splice(0)) {
      await e.close().catch(() => undefined);
    }
  });

  it("does NOT mount /webhooks on the shared Fastify itself — the orchestrator's pre-listen hook does that step (round-trip via inject after the orchestrator's mount runs)", async () => {
    const { ctx, fixture, webhookScannerQueue } = await buildTestWorkerContext();

    // Build a real Fastify the way the self-op engine does — but
    // stub `listen` so the test doesn't bind a port. The shared-
    // mount path doesn't call listen on this instance anyway; the
    // stub just keeps the test isolated from the OS socket layer.
    const sharedApp: FastifyInstance = (await import("fastify")).default({
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
    });
    (sharedApp as unknown as { listen: () => Promise<void> }).listen =
      async (): Promise<void> => undefined;

    // Simulate the orchestrator's pre-listen hook — the route + parser
    // register BEFORE the engine's start() runs.  In production this is
    // `mountWebhookRoute(app, ctx)` threaded into self-op's
    // `start({preListenHooks: [mountHook]})`.
    const { mountWebhookRoute } = await import("../src/start.js");
    mountWebhookRoute(sharedApp, ctx);

    const engine = await start({
      env: validEnv,
      mode: "workers",
      workerContext: ctx,
      workerConnection: { host: "localhost", port: 6379 },
      dbFactory: () => makeStubPool(),
      redisFactory: () => makeStubRedis(),
      sharedFastify: sharedApp,
    });
    enginesToClose.push(engine);

    // The route was registered on the SHARED app by the
    // orchestrator-equivalent call above — NOT by start({sharedFastify}).
    // Identity-test by injecting against sharedApp directly.
    const body = '{"event":"push"}';
    const res = await sharedApp.inject({
      method: "POST",
      url: `/webhooks/${fixture.bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-shared-1",
        "x-provider": "gitea",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(webhookScannerQueue.add).toHaveBeenCalledTimes(1);

    // The engine's exposed `app` is the no-op StartServer wrapper —
    // calling `close()` on it must not affect the shared instance.
    const startedAppClose = (engine as unknown as { app: { close: () => Promise<void> } })
      .app.close;
    await expect(startedAppClose()).resolves.toBeUndefined();

    // The shared app still works after the engine's no-op close —
    // a follow-up POST still hits the route.
    const res2 = await sharedApp.inject({
      method: "POST",
      url: `/webhooks/${fixture.bindingId}`,
      headers: {
        "content-type": "application/json",
        "x-signature": `sha256=${signHex(SECRET_PLAINTEXT, body)}`,
        "x-event-id": "evt-shared-2",
        "x-provider": "gitea",
      },
      payload: body,
    });
    expect(res2.statusCode).toBe(200);

    await sharedApp.close();
  });

  it("rejects sharedFastify together with a caller-supplied serverFactory (mutually exclusive)", async () => {
    const { ctx } = await buildTestWorkerContext();
    const sharedApp: FastifyInstance = (await import("fastify")).default();
    (sharedApp as unknown as { listen: () => Promise<void> }).listen =
      async (): Promise<void> => undefined;

    await expect(
      start({
        env: validEnv,
        mode: "workers",
        workerContext: ctx,
        workerConnection: { host: "localhost", port: 6379 },
        dbFactory: () => makeStubPool(),
        redisFactory: () => makeStubRedis(),
        sharedFastify: sharedApp,
        serverFactory: buildTestServerFactory({}),
      }),
    ).rejects.toThrow(/mutually exclusive/);

    await sharedApp.close();
  });

  it("rejects sharedFastify with mode='probes-only' (receiver mount only makes sense in workers mode)", async () => {
    const sharedApp: FastifyInstance = (await import("fastify")).default();
    (sharedApp as unknown as { listen: () => Promise<void> }).listen =
      async (): Promise<void> => undefined;

    await expect(
      start({
        env: validEnv,
        mode: "probes-only",
        dbFactory: () => makeStubPool(),
        redisFactory: () => makeStubRedis(),
        sharedFastify: sharedApp,
      }),
    ).rejects.toThrow(/mode='workers'/);

    await sharedApp.close();
  });
});
