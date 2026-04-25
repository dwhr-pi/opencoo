/**
 * `start()` — wires config → DB pool → Redis client → probes →
 * Fastify server. Tests cover:
 *
 *   - Resource cleanup on listen failure (copilot #15 Fix 4): if
 *     app.listen() throws, db.end() and redis.disconnect() must
 *     still be called best-effort. The original error is rethrown.
 *
 *   - close() idempotency (copilot #15 Fix 7): calling close()
 *     twice runs cleanup once. The doc claims idempotency; this
 *     test pins the behaviour.
 *
 * The test injects factories for the pool, redis client, and
 * Fastify server so we can simulate failures without standing up
 * real services. start()'s production path (real pg.Pool, real
 * ioredis Redis) is not exercised here — that's the smoke test
 * territory under the CLI in PR 30.
 */
import { describe, it, expect, vi } from "vitest";

import { start } from "../src/start.js";
import type { ProbeMap } from "../src/server.js";

const validEnv = {
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost:6379",
  GITEA_URL: "https://gitea.test",
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

interface StubServer {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeOkServer(): StubServer {
  return {
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function makeFailingListenServer(reason = "EADDRINUSE: address already in use"): StubServer {
  return {
    listen: vi.fn(async () => {
      throw new Error(reason);
    }),
    close: vi.fn(async () => undefined),
  };
}

describe("start() — resource cleanup on listen failure (copilot #15 Fix 4)", () => {
  it("when app.listen() throws, db.end() AND redis.disconnect() are still called", async () => {
    const pool = makeStubPool();
    const redis = makeStubRedis();
    const server = makeFailingListenServer();

    await expect(
      start({
        env: validEnv,
        dbFactory: () => pool,
        redisFactory: () => redis,
        serverFactory: (probes: ProbeMap) => { void probes; return server; },
      }),
    ).rejects.toThrow(/EADDRINUSE/);

    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    // app.close() may also be called in the cleanup; not strictly
    // required (the listen failure happens INSIDE the listen call,
    // so close-after-failed-listen is a Fastify-internal concern).
  });

  it("rethrows the original listen error after cleanup", async () => {
    const pool = makeStubPool();
    const redis = makeStubRedis();
    const server = makeFailingListenServer("EACCES: permission denied");

    await expect(
      start({
        env: validEnv,
        dbFactory: () => pool,
        redisFactory: () => redis,
        serverFactory: (probes: ProbeMap) => { void probes; return server; },
      }),
    ).rejects.toThrow(/EACCES/);
  });

  it("does NOT swallow cleanup errors that mask the original throw", async () => {
    // Each cleanup is best-effort. If pool.end itself throws (e.g.
    // a buggy pool already drained), the cleanup loop should
    // continue to redis.disconnect, then rethrow the ORIGINAL
    // listen error — not the cleanup error.
    const pool = makeStubPool();
    pool.end.mockImplementationOnce(async () => {
      throw new Error("pool.end already called");
    });
    const redis = makeStubRedis();
    const server = makeFailingListenServer("EADDRINUSE");

    await expect(
      start({
        env: validEnv,
        dbFactory: () => pool,
        redisFactory: () => redis,
        serverFactory: (probes: ProbeMap) => { void probes; return server; },
      }),
    ).rejects.toThrow(/EADDRINUSE/);

    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("start() — close() idempotency (copilot #15 Fix 7)", () => {
  it("calling close() twice runs cleanup once", async () => {
    const pool = makeStubPool();
    const redis = makeStubRedis();
    const server = makeOkServer();

    const engine = await start({
      env: validEnv,
      dbFactory: () => pool,
      redisFactory: () => redis,
      serverFactory: (probes: ProbeMap) => { void probes; return server; },
    });

    await engine.close();
    await engine.close();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it("concurrent close() calls share a single cleanup", async () => {
    const pool = makeStubPool();
    const redis = makeStubRedis();
    const server = makeOkServer();

    const engine = await start({
      env: validEnv,
      dbFactory: () => pool,
      redisFactory: () => redis,
      serverFactory: (probes: ProbeMap) => { void probes; return server; },
    });

    await Promise.all([engine.close(), engine.close(), engine.close()]);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
