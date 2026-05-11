/**
 * `composeProductionFromEnv` — PR-Z4 output-channels wiring
 * (phase-a appendix #12 G5).
 *
 * Pins:
 *   1. The composition returns an `OutputChannelRegistry`
 *      instance, NOT undefined — the engine's post-run delivery
 *      hook receives a populated registry.
 *   2. The registry has the `asana` adapter registered (lazy
 *      import succeeded).
 *   3. The composition also returns the `outputChannelDescriptors`
 *      map keyed by `asana` — the admin-API Outputs-tab CRUD
 *      surfaces the per-adapter descriptor.
 *
 * The test stubs the heavy ingredients via the public factory
 * test seams (`pgPoolFactory`, `redisFactory`, `forgetQueueFactory`)
 * so the composition runs without a real Postgres / Redis /
 * BullMQ.
 */
import { PGlite } from "@electric-sql/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@opencoo/shared/db/schema";
import {
  WIKI_DELETE_QUEUE_SLUG,
  WIKI_RECOMPILE_QUEUE_SLUG,
  type ForgetJobQueue,
} from "@opencoo/shared/forget";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { OutputChannelRegistry } from "@opencoo/engine-self-operating";
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

describe("composeProductionFromEnv — PR-Z4 output-channels wiring", () => {
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

  it("returns an OutputChannelRegistry + descriptors keyed by asana", async () => {
    const f = fixture!;
    const result = await composeProductionFromEnv({
      env: f.env,
      logger: silentLogger(),
      pgPoolFactory: () => new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
      redisFactory: () => f.redis,
      forgetQueueFactory: (name) =>
        name === WIKI_RECOMPILE_QUEUE_SLUG
          ? f.recompileQueue
          : f.deleteQueue,
      // PR-Z3 (phase-a appendix #12) — bypass the BullMQ scanner-cron
      // registration the composition does in production. Without this
      // stub the test's fake Redis (no full ioredis surface) causes
      // `webhookScannerQueue.add(repeat=...)` to hang BullMQ's Lua
      // script.
      registerScannerCronFn: async () => undefined,
    });

    expect(result.outputChannels).toBeInstanceOf(OutputChannelRegistry);
    // The asana adapter loaded → the registry has it.
    expect(result.outputChannels.get("asana")).toBeDefined();
    // The descriptor map carries the asana entry for the admin-API
    // Outputs-tab routes.
    expect(result.outputChannelDescriptors.asana).toBeDefined();
    expect(
      result.outputChannelDescriptors.asana.channelConfigJsonSchema.required,
    ).toContain("project_gid");

    await result.workerContext.closeProducers().catch(() => undefined);
    await result.closeForgetQueues();
    await result.pgPool.end().catch(() => undefined);
    await (result.redis as unknown as { quit?: () => Promise<unknown> })
      .quit?.()
      .catch(() => undefined);
    void WIKI_DELETE_QUEUE_SLUG; // referenced for the queue-factory branch
  });
});
