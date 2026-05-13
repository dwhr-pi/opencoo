/**
 * PR-Y8 (phase-a appendix #14) — regression test #2 for the W2
 * retry-failed callable wiring gap.
 *
 * Layer under test: `start()` → `productionServerFactory`.
 *
 * The W2 callables travel through three layers before reaching the
 * route handler:
 *
 *    serve.ts (orchestrator)
 *      → start({ failedClassifyJobsEnumerator, classifyJobEnqueuer })
 *        → productionServerFactory({ ... })
 *          → registerAdminApi({ ... })
 *            → registerSourceBindingsRoutes({ ... })
 *
 * Pre-PR-Y8: `StartOptions` did NOT declare either field, so the
 * call site at start.ts:595 silently dropped both. This file pins
 * `start.ts`'s side of the wiring: `StartOptions` accepts both
 * fields AND `start()` forwards them verbatim into
 * `productionServerFactory`.
 *
 * The mock topology here mirrors `start-auto-migrate.test.ts`: stub
 * `pg.Pool` and `applyMigrationsWithLock` so `start()` boots without
 * touching real infrastructure, and mock
 * `productionServerFactory` so we capture the args it receives
 * without spinning up the real Fastify wiring (which the sibling
 * test file `retry-failed-wiring-server-factory.test.ts` covers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const productionServerFactorySpy = vi.hoisted(() => vi.fn());

vi.mock("../../src/composition/server-factory.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/composition/server-factory.js")
  >("../../src/composition/server-factory.js");
  return {
    ...actual,
    productionServerFactory: productionServerFactorySpy,
  };
});

// Stub `pg.Pool` so the default dbFactory builds a no-op pool. Same
// pattern as `start-auto-migrate.test.ts`.
vi.mock("pg", async () => {
  const actual = await vi.importActual<typeof import("pg")>("pg");
  return {
    ...actual,
    default: {
      ...actual.default,
      Pool: class StubPool {
        end = vi.fn(async () => undefined);
        query(): Promise<{ rows: unknown[]; rowCount: number }> {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
      },
    },
  };
});

// Auto-migrate must be a no-op — the stub pool can't run migrations.
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

import { ConsoleLogger } from "@opencoo/shared/logger";

import { start, type StartOptions } from "../../src/start.js";
import type { StartServer } from "../../src/start.js";
import type { RetryableFailedJob } from "../../src/admin-api/routes/source-bindings.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function makeStubRedis(): {
  ping: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
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

// Env that satisfies start()'s production-context branch (the path
// that builds compositionEnv and calls productionServerFactory):
//   - DATABASE_URL + REDIS_URL → loadEngineConfig
//   - ADMIN_TEAM_SLUG + SESSION_HMAC_KEY + GITEA_BASE_URL →
//     loadAdminApiCompositionEnv (the `tryLoadAdminApiEnv` branch
//     that gates `compositionEnv !== null` at start.ts:586).
//
// SESSION_HMAC_KEY must base64-decode to exactly 32 bytes — the
// loader rejects anything else with a loud Error. Use
// `Buffer.from("a".repeat(32)).toString("base64")` (i.e. 32 'a' bytes
// → 44-char base64 padded string).
const SESSION_HMAC_BASE64 = Buffer.from("a".repeat(32)).toString("base64");

const validEnv = {
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_TEAM_SLUG: "opencoo-admins",
  SESSION_HMAC_KEY: SESSION_HMAC_BASE64,
  GITEA_BASE_URL: "https://gitea.test",
};

describe("PR-Y8 — start() → productionServerFactory wiring", () => {
  beforeEach(() => {
    productionServerFactorySpy.mockClear();
    productionServerFactorySpy.mockImplementation(async () => {
      return makeOkServer();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards `failedClassifyJobsEnumerator` + `classifyJobEnqueuer` from StartOptions into productionServerFactory", async () => {
    const enumerate = vi.fn(
      async (): Promise<readonly RetryableFailedJob[]> => [],
    );
    const enqueue = vi.fn(async () => ({ id: "new-1" }));

    const options: StartOptions = {
      env: validEnv,
      logger: silentLogger(),
      // Skip real Redis — the stub pool already handles Postgres.
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
      // PR-Y8 — the two fields under test.
      failedClassifyJobsEnumerator: enumerate,
      classifyJobEnqueuer: enqueue,
    };

    const engine = await start(options);
    try {
      expect(productionServerFactorySpy).toHaveBeenCalledTimes(1);
      const factoryArgs = productionServerFactorySpy.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(factoryArgs).toBeDefined();
      // Verbatim identity through the call chain.
      expect(factoryArgs!["failedClassifyJobsEnumerator"]).toBe(enumerate);
      expect(factoryArgs!["classifyJobEnqueuer"]).toBe(enqueue);
    } finally {
      await engine.close();
    }
  });

  it("omits both callables from productionServerFactory args when StartOptions omits them (boot-tolerance preserved)", async () => {
    const options: StartOptions = {
      env: validEnv,
      logger: silentLogger(),
      redisFactory: () =>
        makeStubRedis() as unknown as ReturnType<
          NonNullable<StartOptions["redisFactory"]>
        >,
    };

    const engine = await start(options);
    try {
      expect(productionServerFactorySpy).toHaveBeenCalledTimes(1);
      const factoryArgs = productionServerFactorySpy.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(factoryArgs).toBeDefined();
      // Field must be absent (omitted via conditional spread), not
      // present-and-undefined. The forwarding pattern at the
      // forgetJobEnqueuer call site (start.ts:629) is the
      // reference shape we mirror.
      expect("failedClassifyJobsEnumerator" in factoryArgs!).toBe(false);
      expect("classifyJobEnqueuer" in factoryArgs!).toBe(false);
    } finally {
      await engine.close();
    }
  });

});
