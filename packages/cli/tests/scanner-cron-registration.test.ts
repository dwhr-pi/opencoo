/**
 * `composeProductionFromEnv` — PR-Z3 scanner cron registration
 * (phase-a appendix #12).
 *
 * Closes G3: polling adapters (Drive, n8n) never tick automatically
 * because no code registered a BullMQ repeat-job for
 * `ingestion.scanner` at boot. Verified live on the partner
 * deployment: `bull:ingestion.scanner:repeat` does not exist in Redis.
 *
 * Pins:
 *   1. composeProductionFromEnv registers EXACTLY ONE scanner cron
 *      with the `SCANNER_REPEAT_KEY` jobId and the `SCANNER_CRON_DEFAULT`
 *      pattern when `OPENCOO_SCANNER_CRON` is unset.
 *   2. The operator's `OPENCOO_SCANNER_CRON` env override reaches the
 *      registration call (not the default).
 *   3. The composition exposes a `scannerQueue` handle the
 *      orchestrator threads into self-op's `start({scannerQueue})`
 *      for the source-bindings POST + scan-now routes.
 *   4. The `scannerQueue` handle is the SAME instance the
 *      WorkerContext's `webhookScannerQueue` carries — single shared
 *      Queue handle, not two.
 *   5. A failed cron registration does NOT crash composition (the
 *      webhook fast-path + on-demand "Scan now" still work without
 *      the cron backstop).
 */
import { PGlite } from "@electric-sql/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@opencoo/shared/db/schema";
import {
  WIKI_RECOMPILE_QUEUE_SLUG,
  type ForgetJobQueue,
} from "@opencoo/shared/forget";
import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  SCANNER_CRON_DEFAULT,
  SCANNER_REPEAT_KEY,
} from "@opencoo/engine-ingestion";
import type pg from "pg";
import type { Redis } from "ioredis";

import { composeProductionFromEnv } from "../src/provision/production-composition.js";

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
  readonly close: () => Promise<void>;
}

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
    close: async (): Promise<void> => {
      await pglite.close().catch(() => undefined);
    },
  };
}

describe("composeProductionFromEnv — PR-Z3 scanner cron registration (closes G3)", () => {
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

  it("registers exactly one scanner cron with SCANNER_REPEAT_KEY + SCANNER_CRON_DEFAULT (no env override)", async () => {
    const f = fixture!;
    const registerCalls: Array<{ repeatKey: string; pattern: string }> = [];
    const result = await composeProductionFromEnv({
      env: f.env, // no OPENCOO_SCANNER_CRON
      logger: silentLogger(),
      pgPoolFactory: () => new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
      redisFactory: () => f.redis,
      forgetQueueFactory: (name) =>
        name === WIKI_RECOMPILE_QUEUE_SLUG ? f.recompileQueue : f.deleteQueue,
      registerScannerCronFn: async ({ repeatKey, pattern }) => {
        registerCalls.push({ repeatKey, pattern });
      },
    });

    // EXACTLY one cron registration: SCANNER_REPEAT_KEY +
    // SCANNER_CRON_DEFAULT pair. One repeat-job per engine
    // (the scanner enumerates all bindings on each tick;
    // per-binding repeat jobs would explode at scale).
    expect(registerCalls).toEqual([
      { repeatKey: SCANNER_REPEAT_KEY, pattern: SCANNER_CRON_DEFAULT },
    ]);
    // Pin the constants — these are operator-visible labels
    // (runbook + redis-cli debugging both reference them).
    expect(SCANNER_REPEAT_KEY).toBe("ingestion.scanner.tick");
    expect(SCANNER_CRON_DEFAULT).toBe("0 */4 * * *");

    await result.workerContext.closeProducers().catch(() => undefined);
    await result.closeForgetQueues();
    await result.pgPool.end().catch(() => undefined);
    await (result.redis as unknown as { quit?: () => Promise<unknown> })
      .quit?.()
      .catch(() => undefined);
  });

  it("honors the OPENCOO_SCANNER_CRON env override (infrastructure config — not feature)", async () => {
    const f = fixture!;
    const customCron = "*/30 * * * *"; // every 30 minutes
    const registerCalls: Array<{ repeatKey: string; pattern: string }> = [];
    const result = await composeProductionFromEnv({
      env: { ...f.env, OPENCOO_SCANNER_CRON: customCron },
      logger: silentLogger(),
      pgPoolFactory: () => new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
      redisFactory: () => f.redis,
      forgetQueueFactory: (name) =>
        name === WIKI_RECOMPILE_QUEUE_SLUG ? f.recompileQueue : f.deleteQueue,
      registerScannerCronFn: async ({ repeatKey, pattern }) => {
        registerCalls.push({ repeatKey, pattern });
      },
    });

    expect(registerCalls).toEqual([
      { repeatKey: SCANNER_REPEAT_KEY, pattern: customCron },
    ]);

    await result.workerContext.closeProducers().catch(() => undefined);
    await result.closeForgetQueues();
    await result.pgPool.end().catch(() => undefined);
    await (result.redis as unknown as { quit?: () => Promise<unknown> })
      .quit?.()
      .catch(() => undefined);
  });

  it("exposes a writable scannerQueue handle for the orchestrator", async () => {
    const f = fixture!;
    const result = await composeProductionFromEnv({
      env: f.env,
      logger: silentLogger(),
      pgPoolFactory: () => new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
      redisFactory: () => f.redis,
      forgetQueueFactory: (name) =>
        name === WIKI_RECOMPILE_QUEUE_SLUG ? f.recompileQueue : f.deleteQueue,
      registerScannerCronFn: async () => undefined,
    });

    // Closes G6 + G8 — the orchestrator threads this into self-op's
    // `start({scannerQueue})` so the admin-API source-bindings POST
    // handler can enqueue an initial scan AND the `:id/scan-now`
    // route can enqueue on-demand scans.
    expect(result.scannerQueue).toBeDefined();
    expect(typeof result.scannerQueue.add).toBe("function");

    // CRITICAL: identity-share with the WorkerContext's
    // webhookScannerQueue. Without this, the admin-API would
    // operate on a separate Queue handle from the workers, which
    // would still route to the same Redis (BullMQ name dedupes) but
    // would leak handles and complicate shutdown ordering.
    expect(result.scannerQueue).toBe(result.workerContext.webhookScannerQueue);

    await result.workerContext.closeProducers().catch(() => undefined);
    await result.closeForgetQueues();
    await result.pgPool.end().catch(() => undefined);
    await (result.redis as unknown as { quit?: () => Promise<unknown> })
      .quit?.()
      .catch(() => undefined);
  });

  it("composition succeeds even when the cron registration call throws (best-effort)", async () => {
    // A transport blip on the scanner-cron registration must NOT
    // crash composition — the webhook fast-path + on-demand
    // "Scan now" still work; only the periodic backstop is missing.
    // Operator sees the failure in logs + can verify the absence of
    // the repeatable entry via redis-cli.
    const f = fixture!;
    const result = await composeProductionFromEnv({
      env: f.env,
      logger: silentLogger(),
      pgPoolFactory: () => new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
      redisFactory: () => f.redis,
      forgetQueueFactory: (name) =>
        name === WIKI_RECOMPILE_QUEUE_SLUG ? f.recompileQueue : f.deleteQueue,
      registerScannerCronFn: async () => {
        throw new Error("simulated redis outage during cron registration");
      },
    });

    // Composition still produces a usable result.
    expect(result.workerContext).toBeDefined();
    expect(result.scannerQueue).toBeDefined();
    expect(typeof result.scannerQueue.add).toBe("function");

    await result.workerContext.closeProducers().catch(() => undefined);
    await result.closeForgetQueues();
    await result.pgPool.end().catch(() => undefined);
    await (result.redis as unknown as { quit?: () => Promise<unknown> })
      .quit?.()
      .catch(() => undefined);
  });
});
