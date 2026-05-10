/**
 * start-auto-migrate.test.ts — PR-X1 (phase-a follow-up).
 *
 * Pins the boot ordering and the three opt-out paths the
 * engine-self-operating start() now exposes for the auto-migrate
 * step:
 *
 *   1. Default boot: `applyMigrationsWithLock` runs BEFORE
 *      Fastify's `app.listen()` (and BEFORE the admin-API +
 *      static-UI server-factory has any chance to read DB).
 *   2. `OPENCOO_AUTO_MIGRATE=0` opts out — engine boots, no
 *      migrate is attempted. Same for "false" / "no" /
 *      case-variants.
 *   3. `options.skipMigrate=true` opts out — same as above; the
 *      flag's docstring is the test seam tests use to keep the
 *      pre-PR-X1 cases (which inject custom dbFactories) green
 *      when they DO have a real-shaped pool.
 *   4. Migrate failure prevents listen — start() rejects, no
 *      app.listen() bound.
 *   5. Stub-pool-only test: when the caller injects a
 *      `dbFactory` (so `pgPool === null` inside start), no
 *      migrate is attempted regardless of env / flag — the helper
 *      requires a real `pg.Pool` to acquire a client.
 *
 * The test substitutes the real `applyMigrationsWithLock` via
 * `vi.mock` so we can spy + control it (PGlite-backed
 * end-to-end migrate behavior is exercised in
 * packages/shared/tests/db/auto-migrate.test.ts; this suite
 * focuses on the engine's wiring decisions). The mock also
 * lets us assert call ordering (migrate runs BEFORE Fastify
 * listen) by recording into a shared timeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opencoo/shared/db", async () => {
  const actual = await vi.importActual<typeof import("@opencoo/shared/db")>(
    "@opencoo/shared/db",
  );
  return {
    ...actual,
    applyMigrationsWithLock: vi.fn(async () => undefined),
    resolveSharedMigrationsDir: vi.fn(() => "/test/migrations"),
  };
});

// Track every constructed StubPool so a test can assert end() was
// called on the engine-allocated pool when start() throws on the
// migrate path (PR-X1 review C1: the supervisor-restart-loop FD
// leak guard wraps applyMigrationsWithLock in try/catch and drains
// the pool before re-throwing).
const stubPoolEndCalls: ReturnType<typeof vi.fn>[] = [];

vi.mock("pg", async () => {
  const actual = await vi.importActual<typeof import("pg")>("pg");
  return {
    ...actual,
    default: {
      ...actual.default,
      Pool: class StubPool {
        end: ReturnType<typeof vi.fn>;
        constructor() {
          this.end = vi.fn(async () => undefined);
          stubPoolEndCalls.push(this.end);
        }
        query(): Promise<{ rows: unknown[]; rowCount: number }> {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
      },
    },
  };
});

import { ConsoleLogger } from "@opencoo/shared/logger";
import * as sharedDb from "@opencoo/shared/db";

import { start, type StartOptions } from "../src/start.js";
import type { ProbeMap, StartServer } from "../src/start.js";

const validEnv = {
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost:6379",
};

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

interface OkServer extends StartServer {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeOkServer(timeline?: string[]): OkServer {
  return {
    listen: vi.fn(async () => {
      timeline?.push("listen");
      return undefined;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as OkServer;
}

const silentLogger = new ConsoleLogger({
  stream: { write: () => true },
});

const mockedApply = sharedDb.applyMigrationsWithLock as unknown as ReturnType<
  typeof vi.fn
>;

describe("start() — auto-migrate boot wiring (PR-X1)", () => {
  beforeEach(() => {
    mockedApply.mockClear();
    mockedApply.mockImplementation(async () => undefined);
    stubPoolEndCalls.length = 0;
  });

  afterEach(() => {
    delete process.env["OPENCOO_AUTO_MIGRATE"];
  });

  it("default boot: migrate runs BEFORE Fastify listen", async () => {
    const timeline: string[] = [];
    mockedApply.mockImplementation(async () => {
      timeline.push("migrate");
    });
    const okServer = makeOkServer(timeline);

    const engine = await start({
      env: validEnv,
      logger: silentLogger,
      // No dbFactory override → start() constructs a real
      // pg.Pool (the StubPool from the vi.mock above), so the
      // migrate path engages.
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
      serverFactory: (probes: ProbeMap) => {
        void probes;
        return okServer;
      },
    });

    // Migrate fired exactly once and BEFORE the Fastify listen.
    expect(mockedApply).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual(["migrate", "listen"]);
    // Migrate's pool argument is the engine's pg.Pool (the
    // StubPool); migrationsFolder is whatever
    // resolveSharedMigrationsDir returned (mocked above).
    const callArgs = mockedApply.mock.calls[0]?.[0] as {
      migrationsFolder: string;
    };
    expect(callArgs.migrationsFolder).toBe("/test/migrations");
    await engine.close();
  });

  it("OPENCOO_AUTO_MIGRATE=0 skips: no migrate call observed; engine still boots", async () => {
    const okServer = makeOkServer();

    const engine = await start({
      env: { ...validEnv, OPENCOO_AUTO_MIGRATE: "0" },
      logger: silentLogger,
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
      serverFactory: (probes: ProbeMap) => {
        void probes;
        return okServer;
      },
    });

    expect(mockedApply).not.toHaveBeenCalled();
    expect(okServer.listen).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  for (const variant of ["false", "no", "FALSE", "No", " 0 "]) {
    it(`OPENCOO_AUTO_MIGRATE="${variant}" also skips (case + whitespace tolerant)`, async () => {
      const okServer = makeOkServer();
      const engine = await start({
        env: { ...validEnv, OPENCOO_AUTO_MIGRATE: variant },
        logger: silentLogger,
        redisFactory: () =>
          makeStubRedis() as unknown as ReturnType<
            NonNullable<StartOptions["redisFactory"]>
          >,
        serverFactory: (probes: ProbeMap) => {
          void probes;
          return okServer;
        },
      });
      expect(mockedApply).not.toHaveBeenCalled();
      await engine.close();
    });
  }

  it("OPENCOO_AUTO_MIGRATE=1 (default-on) still migrates", async () => {
    const okServer = makeOkServer();
    const engine = await start({
      env: { ...validEnv, OPENCOO_AUTO_MIGRATE: "1" },
      logger: silentLogger,
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
      serverFactory: (probes: ProbeMap) => {
        void probes;
        return okServer;
      },
    });
    expect(mockedApply).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("options.skipMigrate=true skips: same as env opt-out", async () => {
    const okServer = makeOkServer();

    const engine = await start({
      env: validEnv,
      logger: silentLogger,
      skipMigrate: true,
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
      serverFactory: (probes: ProbeMap) => {
        void probes;
        return okServer;
      },
    });

    expect(mockedApply).not.toHaveBeenCalled();
    expect(okServer.listen).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("migrate failure prevents listen: start() rejects, no listener bound", async () => {
    const migrationFailure = new Error("migration failed mid-flight");
    mockedApply.mockImplementation(async () => {
      throw migrationFailure;
    });
    const okServer = makeOkServer();

    await expect(
      start({
        env: validEnv,
        logger: silentLogger,
        redisFactory: () =>
          makeStubRedis() as unknown as ReturnType<
            NonNullable<StartOptions["redisFactory"]>
          >,
        serverFactory: (probes: ProbeMap) => {
          void probes;
          return okServer;
        },
      }),
    ).rejects.toBe(migrationFailure);

    expect(mockedApply).toHaveBeenCalledTimes(1);
    // Critical invariant: a migration failure leaves the
    // engine UN-listened. We explicitly drain the pool in
    // start.ts's catch block to prevent FD leak on supervisor
    // restart loops — the engine-scaffold's resource-safety
    // teardown only fires on errors INSIDE its try block, and
    // a pre-listen migrate failure never reaches that scope
    // (PR-X1 review C1).
    expect(okServer.listen).not.toHaveBeenCalled();
    // The engine-allocated pool (the StubPool above) must have
    // been end()'d exactly once on the failure path. With no
    // dbFactory override, start() constructs exactly one
    // StubPool, and the catch block drains it.
    expect(stubPoolEndCalls).toHaveLength(1);
    expect(stubPoolEndCalls[0]).toHaveBeenCalledTimes(1);
  });

  it("stub-pool-only test (dbFactory injected): no migrate attempted (pgPool === null)", async () => {
    const okServer = makeOkServer();

    const engine = await start({
      env: validEnv,
      logger: silentLogger,
      // Caller-supplied dbFactory → pgPool === null inside
      // start() → migrate skipped per the third
      // shouldSkipAutoMigrate gate.
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
    });

    expect(mockedApply).not.toHaveBeenCalled();
    await engine.close();
  });
});
