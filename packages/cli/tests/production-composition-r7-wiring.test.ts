/**
 * `composeProductionFromEnv` — PR-R7 forget-route wiring (PR-W1,
 * phase-a appendix #11).
 *
 * Bug being fixed: the wave-10 R7 (PR #89) added the
 * `POST /api/admin/source-bindings/:id/forget` route gated on
 * `args.deleteCap` + `args.forgetJobEnqueuer` being passed to
 * `registerAdminApi(...)`. Tests injected both via the `_fixture.ts`
 * helpers so unit tests passed. Production composition missed both
 * — the route returned 503 `composition_incomplete` against the
 * design-partner deployment, surfaced by Chrome QA on 2026-05-09
 * ("Nie udało się załadować wpływu" when clicking "Forget source").
 *
 * These tests pin the wiring at the composition root:
 *
 *   1. `composeProductionFromEnv(...)` returns a result with
 *      `deleteCap` defined (not undefined) — the SAME instance the
 *      WorkerContext's `wikiDeps.deleteCap` reads, so the route's
 *      `peek/reserve` and the workers' `wikiWrite` reservations
 *      address the SAME budget (single-process v0.1 shape per
 *      architecture §16).
 *   2. `composeProductionFromEnv(...)` returns a result with
 *      `forgetJobEnqueuer` defined.
 *   3. Calling the wired `forgetJobEnqueuer` adds jobs to the
 *      composition-root BullMQ queues (`wiki.recompile` +
 *      `wiki.delete`) with the right job names + payloads.
 *   4. `closeForgetQueues()` drains both producer-side queue
 *      handles the composition opened (orchestrator awaits this on
 *      SIGTERM alongside `closeProducers`).
 *
 * The test stubs the heavy ingredients via the public factory test
 * seams (`pgPoolFactory`, `redisFactory`, `forgetQueueFactory`) so
 * the composition can be exercised without a real Postgres / Redis
 * / BullMQ.
 */
import { PGlite } from "@electric-sql/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@opencoo/shared/db/schema";
import {
  WIKI_DELETE_JOB_NAME,
  WIKI_DELETE_QUEUE_SLUG,
  WIKI_RECOMPILE_JOB_NAME,
  WIKI_RECOMPILE_QUEUE_SLUG,
  type ForgetJobQueue,
} from "@opencoo/shared/forget";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { InMemoryDeleteCap } from "@opencoo/shared/wiki-write";
import type pg from "pg";
import type { Redis } from "ioredis";

import { composeProductionFromEnv } from "../src/provision/production-composition.js";

/** Minimal Redis stub: the composition root passes the redis client
 *  to `composeProductionWorkerContext` as `redisClient` (an opaque
 *  field used only for ownership tracking — `closeProducers()` does
 *  NOT touch it). The BullMQ queues read `redisConnection` (the URL
 *  + options struct), not the client. So a no-op object suffices. */
function fakeRedis(): Redis {
  return {
    quit: vi.fn(async () => "OK"),
    disconnect: vi.fn(),
  } as unknown as Redis;
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

/** Minimal DDL — composeProductionWorkerContext's `warmAdapterCache`
 *  reads `sources_bindings` at boot. The credential-store runs no
 *  queries unless a credential is read, so the empty-fixture path
 *  doesn't need `credentials` rows. */
const TABLES_DDL = `
  CREATE TABLE domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    class domain_class DEFAULT 'knowledge' NOT NULL,
    locale text DEFAULT 'en' NOT NULL,
    governance_cadence governance_cadence DEFAULT 'continuous' NOT NULL,
    review_role text,
    llm_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    llm_budget_monthly_cap_usd numeric(10, 2),
    retention_days integer,
    worldview_enabled boolean DEFAULT true NOT NULL,
    is_aggregator boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE sources_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    adapter_slug text NOT NULL,
    source_id text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    allowed_paths text[] DEFAULT '{}'::text[] NOT NULL,
    review_mode review_mode DEFAULT 'auto' NOT NULL,
    schedule_cron text,
    credentials_id uuid,
    retention_days_override integer,
    enabled boolean DEFAULT true NOT NULL,
    last_scanned_at timestamp with time zone,
    last_scan_cursor text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
`;

/** Pool adapter that satisfies the pg.Pool shape drizzle/node-postgres
 *  consumes for top-level `db.execute(sql\`...\`)` calls. Mirrors
 *  `agent-runners-drizzle.test.ts:PglitePoolAdapter`. */
class PglitePoolAdapter {
  constructor(private readonly pg: PGlite) {}
  async query(
    config: { text: string } | string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> {
    const text = typeof config === "string" ? config : config.text;
    const result = await this.pg.query<Record<string, unknown>>(
      text,
      params as unknown[] | undefined,
    );
    return { rows: result.rows };
  }
  async end(): Promise<void> {
    await this.pg.close();
  }
}

interface CompositionFixture {
  readonly pglite: PGlite;
  readonly redis: Redis;
  readonly env: Record<string, string | undefined>;
  readonly recompileQueue: ForgetJobQueue & {
    readonly add: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
  readonly deleteQueue: ForgetJobQueue & {
    readonly add: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
  readonly queueFactoryCalls: Array<{ name: string }>;
  readonly close: () => Promise<void>;
}

/** Generate a 32-byte base64 string acceptable to `loadEncryptionKey`. */
function fakeEncryptionKeyBase64(): string {
  return Buffer.alloc(32, 7).toString("base64");
}

async function makeCompositionFixture(): Promise<CompositionFixture> {
  const pglite = new PGlite();
  await pglite.exec(buildEnumsDdl());
  await pglite.exec(TABLES_DDL);
  const redis = fakeRedis();

  const recompileQueue = {
    add: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const deleteQueue = {
    add: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const queueFactoryCalls: Array<{ name: string }> = [];

  return {
    pglite,
    redis,
    env: {
      DATABASE_URL: "postgres://stub",
      REDIS_URL: "redis://stub",
      GITEA_URL: "https://gitea.test",
      GITEA_PAT: "pat-stub",
      ENCRYPTION_KEY: fakeEncryptionKeyBase64(),
    },
    recompileQueue,
    deleteQueue,
    queueFactoryCalls,
    close: async (): Promise<void> => {
      await pglite.close().catch(() => undefined);
    },
  };
}

describe("composeProductionFromEnv — PR-R7 forget wiring (PR-W1)", () => {
  let fixture: CompositionFixture | null = null;

  beforeEach(async () => {
    fixture = await makeCompositionFixture();
  });

  afterEach(async () => {
    if (fixture !== null) {
      await fixture.close();
      fixture = null;
    }
  });

  it("composes a deleteCap that the WorkerContext shares (single-process v0.1 shape)", async () => {
    const f = fixture!;
    const result = await composeProductionFromEnv({
      env: f.env,
      logger: silentLogger(),
      pgPoolFactory: () => new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
      redisFactory: () => f.redis,
      forgetQueueFactory: (name) => {
        f.queueFactoryCalls.push({ name });
        return name === WIKI_RECOMPILE_QUEUE_SLUG
          ? f.recompileQueue
          : f.deleteQueue;
      },
    });

    // 1. The deleteCap field is populated and is an InMemoryDeleteCap
    //    (the v0.1 single-process implementation).
    expect(result.deleteCap).toBeInstanceOf(InMemoryDeleteCap);

    // 2. CRITICAL: identity-share with the WorkerContext's wikiDeps.
    //    Without this thread, the route's peek/reserve and the
    //    workers' wikiWrite reservations would address two different
    //    caps and a forget could silently exceed the per-domain
    //    daily limit.
    expect(result.workerContext.wikiDeps.deleteCap).toBe(result.deleteCap);

    await result.workerContext.closeProducers().catch(() => undefined);
    await result.closeForgetQueues();
    await result.pgPool.end().catch(() => undefined);
    await (result.redis as unknown as { quit?: () => Promise<unknown> })
      .quit?.()
      .catch(() => undefined);
  });

  it("composes a forgetJobEnqueuer that adds to the wiki.recompile + wiki.delete queues", async () => {
    const f = fixture!;
    const result = await composeProductionFromEnv({
      env: f.env,
      logger: silentLogger(),
      pgPoolFactory: () => new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
      redisFactory: () => f.redis,
      forgetQueueFactory: (name) => {
        f.queueFactoryCalls.push({ name });
        return name === WIKI_RECOMPILE_QUEUE_SLUG
          ? f.recompileQueue
          : f.deleteQueue;
      },
    });

    // The queue factory was called for both queue slugs at composition.
    expect(f.queueFactoryCalls.map((c) => c.name).sort()).toEqual([
      WIKI_DELETE_QUEUE_SLUG,
      WIKI_RECOMPILE_QUEUE_SLUG,
    ]);

    // The enqueuer is a callable, not undefined (the route's 503
    // composition-incomplete branch is skipped in production).
    expect(typeof result.forgetJobEnqueuer).toBe("function");

    // Calling the enqueuer with a synthetic plan (route → planner →
    // enqueue) lands `add()` calls on the SAME queue handles the
    // composition opened.
    await result.forgetJobEnqueuer({
      bindingId: "11111111-1111-1111-1111-111111111111",
      domainSlug: "wiki-forget",
      pagesRecompiled: ["wiki-forget/index.md"],
      pagesDeleted: ["wiki-forget/team-a.md", "wiki-forget/team-b.md"],
      callerUsername: "alice",
    });

    expect(f.recompileQueue.add).toHaveBeenCalledTimes(1);
    expect(f.recompileQueue.add).toHaveBeenCalledWith(WIKI_RECOMPILE_JOB_NAME, {
      bindingId: "11111111-1111-1111-1111-111111111111",
      domainSlug: "wiki-forget",
      pagePath: "index.md",
      callerUsername: "alice",
    });

    expect(f.deleteQueue.add).toHaveBeenCalledTimes(2);
    expect(f.deleteQueue.add).toHaveBeenNthCalledWith(1, WIKI_DELETE_JOB_NAME, {
      bindingId: "11111111-1111-1111-1111-111111111111",
      domainSlug: "wiki-forget",
      pagePath: "team-a.md",
      callerUsername: "alice",
    });
    expect(f.deleteQueue.add).toHaveBeenNthCalledWith(2, WIKI_DELETE_JOB_NAME, {
      bindingId: "11111111-1111-1111-1111-111111111111",
      domainSlug: "wiki-forget",
      pagePath: "team-b.md",
      callerUsername: "alice",
    });

    await result.workerContext.closeProducers().catch(() => undefined);
    await result.closeForgetQueues();
    await result.pgPool.end().catch(() => undefined);
    await (result.redis as unknown as { quit?: () => Promise<unknown> })
      .quit?.()
      .catch(() => undefined);
  });

  it("closeForgetQueues drains both producer-side queue handles (idempotent)", async () => {
    const f = fixture!;
    const result = await composeProductionFromEnv({
      env: f.env,
      logger: silentLogger(),
      pgPoolFactory: () => new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
      redisFactory: () => f.redis,
      forgetQueueFactory: (name) =>
        name === WIKI_RECOMPILE_QUEUE_SLUG ? f.recompileQueue : f.deleteQueue,
    });

    await result.closeForgetQueues();
    expect(f.recompileQueue.close).toHaveBeenCalledTimes(1);
    expect(f.deleteQueue.close).toHaveBeenCalledTimes(1);

    // Idempotent — a second close is a no-op.
    await result.closeForgetQueues();
    expect(f.recompileQueue.close).toHaveBeenCalledTimes(1);
    expect(f.deleteQueue.close).toHaveBeenCalledTimes(1);

    await result.workerContext.closeProducers().catch(() => undefined);
    await result.pgPool.end().catch(() => undefined);
    await (result.redis as unknown as { quit?: () => Promise<unknown> })
      .quit?.()
      .catch(() => undefined);
  });
});
