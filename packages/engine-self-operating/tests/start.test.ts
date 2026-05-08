/**
 * `start()` — extended seam tests (PR-M1, phase-a appendix #5).
 *
 * Verifies that engine-self-operating's `start({...})` accepts
 * pre-constructed `dbFactory` / `redisFactory` overrides (so the
 * orchestrator can share one pg.Pool + one ioredis Redis with
 * engine-ingestion) AND honours an injected `sseBus` (so both
 * engines emit run-events through the same bus the SSE route
 * subscribes on).
 *
 * The pre-PR-M1 boot path stays unchanged — every existing test
 * that doesn't pass these new options must still work.
 */
import { describe, expect, it, vi } from "vitest";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { start, type StartOptions } from "../src/start.js";
import type { ProbeMap, StartServer } from "../src/start.js";
import { createSseBus } from "../src/admin-api/sse-bus.js";

const validEnv = {
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost:6379",
};

interface StubPool {
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeStubPool(): StubPool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    end: vi.fn(async () => undefined),
  };
}

interface StubRedis {
  ping: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeStubRedis(): StubRedis {
  return {
    ping: vi.fn(async () => "PONG"),
    disconnect: vi.fn(),
  };
}

function makeOkServer(): StartServer & {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as StartServer & {
    listen: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

describe("start() — sharable resource seams (PR-M1)", () => {
  it("uses the supplied dbFactory + redisFactory verbatim", async () => {
    const pool = makeStubPool();
    const redis = makeStubRedis();
    const dbFactory: StartOptions["dbFactory"] = vi.fn(
      () => pool as unknown as ReturnType<NonNullable<StartOptions["dbFactory"]>>,
    );
    const redisFactory: StartOptions["redisFactory"] = vi.fn(
      () => redis as unknown as ReturnType<NonNullable<StartOptions["redisFactory"]>>,
    );

    const engine = await start({
      env: validEnv,
      logger: new ConsoleLogger({ stream: { write: () => true } }),
      dbFactory,
      redisFactory,
      serverFactory: (probes: ProbeMap) => {
        void probes;
        return makeOkServer();
      },
    });

    expect(dbFactory).toHaveBeenCalledTimes(1);
    expect(redisFactory).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("accepts an external sseBus and re-uses it (no fresh bus created)", async () => {
    const externalBus = createSseBus();

    const engine = await start({
      env: validEnv,
      logger: new ConsoleLogger({ stream: { write: () => true } }),
      sseBus: externalBus,
      dbFactory: () =>
        makeStubPool() as unknown as ReturnType<
          NonNullable<StartOptions["dbFactory"]>
        >,
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
      serverFactory: (probes: ProbeMap) => {
        void probes;
        return makeOkServer();
      },
    });
    expect(engine.sseBus).toBe(externalBus);
    await engine.close();
  });

  it("returns a fresh sseBus when none is supplied", async () => {
    const engine = await start({
      env: validEnv,
      logger: new ConsoleLogger({ stream: { write: () => true } }),
      dbFactory: () =>
        makeStubPool() as unknown as ReturnType<
          NonNullable<StartOptions["dbFactory"]>
        >,
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
      serverFactory: (probes: ProbeMap) => {
        void probes;
        return makeOkServer();
      },
    });
    expect(engine.sseBus).toBeDefined();
    await engine.close();
  });
});

// PR-Q6 fix-up (phase-a appendix #9) — pre-listen hook seam for the
// orchestrator's webhook-mount.
//
// The orchestrator (`packages/cli/src/commands/serve.ts`) pre-composes
// the engine-ingestion `WorkerContext` BEFORE either engine boots, then
// threads a `(app) => mountWebhookRoute(app, ctx)` closure here so the
// webhook route + raw-body parser register BEFORE `app.listen()`.
// Fastify rejects post-listen `addContentTypeParser` calls; routing
// the mount through this hook is what fixes the
// `FST_ERR_INSTANCE_ALREADY_STARTED` failure mode the reviewer flagged
// on PR #72.
describe("start() — pre-listen hooks (PR-Q6 fix-up)", () => {
  it("runs each preListenHook against the resolved Fastify BEFORE app.listen()", async () => {
    const callOrder: string[] = [];
    const okServer = makeOkServer();
    okServer.listen = vi.fn(async () => {
      callOrder.push("listen");
      return undefined;
    }) as unknown as typeof okServer.listen;

    const hookA = vi.fn(async () => {
      callOrder.push("hookA");
    });
    const hookB = vi.fn(async () => {
      callOrder.push("hookB");
    });

    const engine = await start({
      env: validEnv,
      logger: new ConsoleLogger({ stream: { write: () => true } }),
      dbFactory: () =>
        makeStubPool() as unknown as ReturnType<
          NonNullable<StartOptions["dbFactory"]>
        >,
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
      serverFactory: (probes: ProbeMap) => {
        void probes;
        return okServer;
      },
      preListenHooks: [hookA, hookB],
    });

    // Hooks ran in order, BOTH before the listen() call. If hookA
    // ran AFTER listen, addContentTypeParser inside the real
    // mountWebhookRoute would throw FST_ERR_INSTANCE_ALREADY_STARTED.
    expect(callOrder).toEqual(["hookA", "hookB", "listen"]);
    expect(hookA).toHaveBeenCalledTimes(1);
    expect(hookB).toHaveBeenCalledTimes(1);
    // Each hook received the SAME FastifyInstance the scaffold will
    // listen on — identity-checked so a structural-clone (which
    // would mount the route on a different app and 404 in production)
    // regresses loudly.
    expect(hookA.mock.calls[0]?.[0]).toBe(okServer);
    expect(hookB.mock.calls[0]?.[0]).toBe(okServer);
    await engine.close();
  });

  it("a preListenHook that throws propagates through start() (caller's resource-safety teardown drains pg/Redis)", async () => {
    const okServer = makeOkServer();
    const hookErr = new Error("mount failed");
    const hook = vi.fn(async () => {
      throw hookErr;
    });

    await expect(
      start({
        env: validEnv,
        logger: new ConsoleLogger({ stream: { write: () => true } }),
        dbFactory: () =>
          makeStubPool() as unknown as ReturnType<
            NonNullable<StartOptions["dbFactory"]>
          >,
        redisFactory: () =>
          makeStubRedis() as unknown as ReturnType<
            NonNullable<StartOptions["redisFactory"]>
          >,
        serverFactory: (probes: ProbeMap) => {
          void probes;
          return okServer;
        },
        preListenHooks: [hook],
      }),
    ).rejects.toBe(hookErr);

    expect(hook).toHaveBeenCalledTimes(1);
    // The scaffold's listen MUST NOT have run — the hook threw first.
    expect(okServer.listen).not.toHaveBeenCalled();
  });
});
