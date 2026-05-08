/**
 * `createProductionAgentRunners` — Drizzle wrap pin (PR-Q2,
 * phase-a appendix #9).
 *
 * Bug being fixed: the registry handed each runner closure
 * `deps.db` (a raw `pg.Pool`) — but `runHeartbeat` /
 * `runLint` / `runSurfacer` call `args.db.execute(sql\`...\`)`
 * (Drizzle's API). On first dispatch the runner threw
 * `args.db.execute is not a function`. `opencoo agents fire
 * heartbeat` always failed with this error before the fix.
 *
 * The fix wraps the pool ONCE at registry-construction time —
 * `const drizzleDb = drizzle(deps.db)` — and threads the
 * wrapped handle into every closure plus `resolveDomainSlug`.
 *
 * This test exercises each closure end-to-end with a pglite-
 * backed pool adapter so the runner spies actually call
 * `args.db.execute(sql\`SELECT 1\`)`. If the closure ever
 * regresses to passing the raw pool, the spy throws and the
 * test fails with the original "is not a function" message.
 */
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import * as schema from "@opencoo/shared/db/schema";
import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryQueuePauser,
  LlmRouter,
  type LlmProvider,
} from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  HEARTBEAT_DEFINITION,
  LINT_DEFINITION,
  SURFACER_DEFINITION,
  InMemoryMcpToolClient,
  type AgentRunContext,
} from "@opencoo/engine-self-operating";

import { createProductionAgentRunners } from "../src/provision/agent-runners.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeProvider(): LlmProvider {
  return {
    generate: async () => ({
      text: '{"version":"v1","summary":"x","alerts":[]}',
      tokensIn: 1,
      tokensOut: 1,
    }),
  };
}

function buildEnumsDdl(): string {
  const lines: string[] = [];
  for (const value of Object.values(schema)) {
    if (isPgEnum(value)) {
      const e = value as PgEnum<[string, ...string[]]>;
      const literals = e.enumValues
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ");
      lines.push(`CREATE TYPE "${e.enumName}" AS ENUM (${literals});`);
    }
  }
  return lines.join("\n");
}

const TABLES_DDL = `
  CREATE TABLE domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL UNIQUE
  );
`;

/**
 * Pool adapter that satisfies the `pg.Pool` shape drizzle
 * node-postgres consumes for top-level `db.execute(sql\`...\`)`
 * calls. Drizzle calls `client.query(rawQuery, params)` where
 * rawQuery is a `{ text, name? }` config — we delegate to
 * pglite's `query(text, params)` and shim the `Pool` brand
 * (drizzle inspects the prototype name for a substring match).
 *
 * Top-level execute does NOT walk the transaction path, so we
 * don't need to implement `connect()`/`release()` — drizzle's
 * NodePgPreparedQuery.execute calls `client.query(rawQuery,
 * params)` directly.
 */
class PglitePoolAdapter {
  constructor(private readonly pg: PGlite) {}
  async query(
    config: { text: string } | string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    const text = typeof config === "string" ? config : config.text;
    const result = await this.pg.query<Record<string, unknown>>(
      text,
      params as unknown[] | undefined,
    );
    return { rows: result.rows };
  }
}

interface PoolFixture {
  readonly pool: PglitePoolAdapter;
  readonly pg: PGlite;
  readonly seedDomain: (id: string, slug: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

async function makePoolFixture(): Promise<PoolFixture> {
  const pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(TABLES_DDL);
  const pool = new PglitePoolAdapter(pg);
  return {
    pool,
    pg,
    seedDomain: async (id: string, slug: string): Promise<void> => {
      await pg.query("INSERT INTO domains (id, slug) VALUES ($1, $2)", [
        id,
        slug,
      ]);
    },
    close: async (): Promise<void> => {
      await pg.close();
    },
  };
}

function makeDeps(
  pool: PglitePoolAdapter,
): Parameters<typeof createProductionAgentRunners>[0] {
  const router = new LlmRouter({
    db: {} as never,
    env: {},
    logger: silentLogger(),
    pauser: new InMemoryQueuePauser(),
    provider: fakeProvider(),
  });
  const mcp = new InMemoryMcpToolClient();
  const definitions = new AgentDefinitionRegistry();
  definitions.register(HEARTBEAT_DEFINITION);
  definitions.register(LINT_DEFINITION);
  definitions.register(SURFACER_DEFINITION);
  return {
    // The registry's `deps.db` is typed `pg.Pool`; the test
    // adapter satisfies the structural surface drizzle's
    // node-postgres driver actually calls (.query(rawQuery,
    // params)) — that's the seam the bug was on.
    db: pool as unknown as Parameters<
      typeof createProductionAgentRunners
    >[0]["db"],
    mcp,
    router,
    logger: silentLogger(),
    definitions,
    availableTemplateSlugs: ["asana-comment", "drive-watch"],
  };
}

const DOMAIN_ID = "00000000-0000-0000-0000-000000000099";
const DOMAIN_SLUG = "wiki-executive";

function fakeCtx(slug: string): AgentRunContext {
  return {
    definition: { slug } as unknown as AgentRunContext["definition"],
    instance: {
      id: "00000000-0000-0000-0000-000000000001",
      definitionSlug: slug,
      scopeDomainIds: [DOMAIN_ID],
      locale: "en",
    } as unknown as AgentRunContext["instance"],
    runId: "00000000-0000-0000-0000-000000000010",
    spotlightedMemory: [],
    router: {} as unknown as AgentRunContext["router"],
    logger: silentLogger(),
    callTool: async (_name, fn) => fn(),
    recordToolCall: () => undefined,
  };
}

/**
 * Drives a runner closure end-to-end: spies the underlying
 * `run*` function, then INSIDE the spy invokes
 * `args.db.execute(sql\`SELECT 1\`)` against the pglite-backed
 * adapter. If `args.db` is a raw `pg.Pool` (the bug), this
 * throws "args.db.execute is not a function". If it's a
 * Drizzle handle (the fix), the SELECT round-trips and the
 * spy returns normally.
 */
describe("createProductionAgentRunners — runners receive a Drizzle handle (PR-Q2)", () => {
  it("the heartbeat closure invokes runHeartbeat with a db that supports `.execute(sql\\`...\\`)`", async () => {
    const fx = await makePoolFixture();
    try {
      await fx.seedDomain(DOMAIN_ID, DOMAIN_SLUG);
      const heartbeatModule = await import("@opencoo/engine-self-operating");
      const spy = vi
        .spyOn(heartbeatModule, "runHeartbeat")
        .mockImplementation(async (_ctx, args) => {
          // The call that throws against the unfixed code.
          // Drizzle wraps the result of `db.execute(sql\`...\`)`
          // as `{ rows }`; pglite returns the same shape.
          const result = (await args.db.execute(
            sql`SELECT 1 AS one`,
          )) as unknown as { rows: Array<{ one: number }> };
          expect(result.rows[0]?.one).toBe(1);
          return {
            version: "v1",
            summary: "spied",
            alerts: [],
          } as Awaited<ReturnType<typeof heartbeatModule.runHeartbeat>>;
        });

      const deps = makeDeps(fx.pool);
      const registry = createProductionAgentRunners(deps);
      const runner = registry.get("heartbeat");
      expect(runner).toBeTypeOf("function");

      // The closure also resolves the domain slug via Drizzle —
      // `resolveDomainSlug` calls `db.execute(sql\`SELECT slug …\`)`.
      // If `deps.db` weren't wrapped, that would throw too.
      await expect(runner!(fakeCtx("heartbeat"))).resolves.toBeDefined();

      expect(spy).toHaveBeenCalledTimes(1);
      const passedDb = spy.mock.calls[0]?.[1]?.db;
      // Drizzle's `PgDatabase` shape exposes `execute` as a
      // function. A raw `pg.Pool` does not — that's the bug
      // surface this test pins.
      expect(typeof (passedDb as { execute?: unknown })?.execute).toBe(
        "function",
      );

      spy.mockRestore();
    } finally {
      await fx.close();
    }
  });

  it("the lint closure invokes runLint with a db that supports `.execute(sql\\`...\\`)`", async () => {
    const fx = await makePoolFixture();
    try {
      await fx.seedDomain(DOMAIN_ID, DOMAIN_SLUG);
      const lintModule = await import("@opencoo/engine-self-operating");
      const spy = vi.spyOn(lintModule, "runLint").mockImplementation(
        async (_ctx, args) => {
          const result = (await args.db.execute(
            sql`SELECT 1 AS one`,
          )) as unknown as { rows: Array<{ one: number }> };
          expect(result.rows[0]?.one).toBe(1);
          return {
            version: "v1",
            findings: [],
          } as Awaited<ReturnType<typeof lintModule.runLint>>;
        },
      );

      const deps = makeDeps(fx.pool);
      const registry = createProductionAgentRunners(deps);
      const runner = registry.get("lint");
      expect(runner).toBeTypeOf("function");

      await expect(runner!(fakeCtx("lint"))).resolves.toBeDefined();

      expect(spy).toHaveBeenCalledTimes(1);
      const passedDb = spy.mock.calls[0]?.[1]?.db;
      expect(typeof (passedDb as { execute?: unknown })?.execute).toBe(
        "function",
      );

      spy.mockRestore();
    } finally {
      await fx.close();
    }
  });

  it("the surfacer closure invokes runSurfacer with a db that supports `.execute(sql\\`...\\`)`", async () => {
    const fx = await makePoolFixture();
    try {
      await fx.seedDomain(DOMAIN_ID, DOMAIN_SLUG);
      const surfacerModule = await import("@opencoo/engine-self-operating");
      const spy = vi
        .spyOn(surfacerModule, "runSurfacer")
        .mockImplementation(async (_ctx, args) => {
          const result = (await args.db.execute(
            sql`SELECT 1 AS one`,
          )) as unknown as { rows: Array<{ one: number }> };
          expect(result.rows[0]?.one).toBe(1);
          return {
            version: "v1",
            candidates: [],
            insertedCandidateIds: [],
          } as Awaited<ReturnType<typeof surfacerModule.runSurfacer>>;
        });

      const deps = makeDeps(fx.pool);
      const registry = createProductionAgentRunners(deps);
      const runner = registry.get("surfacer");
      expect(runner).toBeTypeOf("function");

      await expect(runner!(fakeCtx("surfacer"))).resolves.toBeDefined();

      expect(spy).toHaveBeenCalledTimes(1);
      const passedDb = spy.mock.calls[0]?.[1]?.db;
      expect(typeof (passedDb as { execute?: unknown })?.execute).toBe(
        "function",
      );

      spy.mockRestore();
    } finally {
      await fx.close();
    }
  });

  it("`resolveDomainSlug` runs through the wrapped Drizzle handle (no raw-pool execute)", async () => {
    // Pins the inner `resolveDomainSlug` query — without the
    // single-wrap, it would have either re-wrapped the pool
    // every call (the old internal `drizzle(pool)` per dispatch)
    // or — if anyone naively passed deps.db — thrown
    // "execute is not a function". This test asserts the slug
    // round-trips through pglite, proving the wrapped handle is
    // what `resolveDomainSlug` uses.
    const fx = await makePoolFixture();
    try {
      await fx.seedDomain(DOMAIN_ID, DOMAIN_SLUG);
      const heartbeatModule = await import("@opencoo/engine-self-operating");
      const spy = vi
        .spyOn(heartbeatModule, "runHeartbeat")
        .mockImplementation(async (_ctx, args) => {
          // Capture the resolved domainSlug so we can assert
          // `resolveDomainSlug` succeeded against pglite.
          return {
            version: "v1",
            summary: args.domainSlug,
            alerts: [],
          } as Awaited<ReturnType<typeof heartbeatModule.runHeartbeat>>;
        });

      const deps = makeDeps(fx.pool);
      const registry = createProductionAgentRunners(deps);
      const runner = registry.get("heartbeat");
      await runner!(fakeCtx("heartbeat"));

      expect(spy).toHaveBeenCalledTimes(1);
      const passedSlug = spy.mock.calls[0]?.[1]?.domainSlug;
      expect(passedSlug).toBe(DOMAIN_SLUG);

      spy.mockRestore();
    } finally {
      await fx.close();
    }
  });
});
