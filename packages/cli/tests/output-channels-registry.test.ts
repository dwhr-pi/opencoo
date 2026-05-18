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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// PR-Flake (wave-17) — module-mock the `bullmq` Queue constructor.
//
// `composeProductionFromEnv` → `composeProductionWorkerContext` builds
// three Queue handles internally (`ingestion.scanner.classify`,
// `ingestion.scanner`, `ingestion.intake.dlq`) using the
// `{ url: "redis://stub", ... }` connection from the test fixture.
// BullMQ Queue eagerly opens an internal `ioredis` connection from
// those options, which fires `getaddrinfo('stub')` against the real
// DNS resolver. On CI's restricted-egress runners the lookup fails
// with `EAI_AGAIN` AFTER the test has already torn down, surfacing as
// an unhandled rejection that exit-1's the vitest shard. Locally the
// same lookup fails with `ENOTFOUND` synchronously and is harmless,
// which is why this regressed only on CI.
//
// The existing test seams (`forgetQueueFactory`, `worldviewQueueFactory`,
// `registerScannerCronFn`, `registerWorldviewSafetyNetCronFn`) cover
// every OTHER queue/cron the composition builds — these three are the
// only ones the test couldn't substitute. Replacing `Queue` at the
// module-mock level is the smallest test-side diff that closes the
// gap; the production code that constructs the Queues is untouched.
vi.mock("bullmq", async () => {
  const actual = await vi.importActual<typeof import("bullmq")>("bullmq");
  class FakeQueue {
    public readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    async add(): Promise<{ readonly id: string }> {
      return { id: "stub" };
    }
    async close(): Promise<void> {
      return undefined;
    }
    async waitUntilReady(): Promise<void> {
      return undefined;
    }
    async getRepeatableJobs(): Promise<readonly unknown[]> {
      return [];
    }
    async removeRepeatableByKey(): Promise<void> {
      return undefined;
    }
  }
  return {
    ...actual,
    Queue: FakeQueue,
  };
});

import * as schema from "@opencoo/shared/db/schema";
import {
  WIKI_DELETE_QUEUE_SLUG,
  WIKI_RECOMPILE_QUEUE_SLUG,
  type ForgetJobQueue,
} from "@opencoo/shared/forget";
import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  OutputChannelRegistry,
  getOutputAdapterListEntries,
} from "@opencoo/engine-self-operating";
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
  // PR-Flake (wave-17) — capture every unhandled rejection that
  // escapes the test file. The previous failure mode was a BullMQ-
  // owned ioredis raising `getaddrinfo EAI_AGAIN` AFTER the test had
  // torn down; vitest then exit-1'd the shard. The pin-test at the
  // bottom of the suite asserts this list stays empty.
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeAll(() => {
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterAll(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });

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
      // PR-W1 (phase-a appendix #13) — bypass the BullMQ worldview-
      // compile Queue + safety-net cron registration.
      worldviewQueueFactory: () => ({
        add: async () => ({ id: "stub" }),
        close: async () => undefined,
      }),
      registerWorldviewSafetyNetCronFn: async () => undefined,
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

  // PR-W3 (phase-a appendix #13 G3) — the webhook output adapter
  // joins the registry alongside asana. The composition lazy-imports
  // `@opencoo/output-webhook` and registers a per-channel adapter
  // wrapper that constructs a `WebhookOutputAdapter` from each
  // channel row's `config` (`targetUrl` + optional headers + optional
  // retry policy) and `credentials_id` (the HMAC signing secret).
  it(
    "registers both asana and webhook adapters; descriptors surface via " +
      "getOutputAdapterListEntries (powers /api/admin/adapters)",
    async () => {
      const f = fixture!;
      const result = await composeProductionFromEnv({
        env: f.env,
        logger: silentLogger(),
        pgPoolFactory: () =>
          new PglitePoolAdapter(f.pglite) as unknown as pg.Pool,
        redisFactory: () => f.redis,
        forgetQueueFactory: (name) =>
          name === WIKI_RECOMPILE_QUEUE_SLUG
            ? f.recompileQueue
            : f.deleteQueue,
        registerScannerCronFn: async () => undefined,
        // PR-W1 (phase-a appendix #13) — bypass BullMQ Queue / cron
        // construction in the worldview bundle (analogous to the
        // existing registerScannerCronFn seam). Without these the test
        // hangs constructing a real Queue against the stub Redis.
        worldviewQueueFactory: () =>
          ({
            add: async () => undefined,
            close: async () => undefined,
          }) as unknown as ReturnType<typeof Object>,
        registerWorldviewSafetyNetCronFn: async () => undefined,
      });

      // 1. Registry has BOTH adapters.
      expect(result.outputChannels.get("asana")).toBeDefined();
      expect(result.outputChannels.get("webhook")).toBeDefined();

      // 2. Descriptor map carries BOTH.
      expect(result.outputChannelDescriptors.asana).toBeDefined();
      expect(result.outputChannelDescriptors.webhook).toBeDefined();

      // 3. Webhook descriptor shape — channel config requires
      //    `targetUrl`; credentials require `signingSecret`.
      const webhookDesc = result.outputChannelDescriptors.webhook;
      expect(webhookDesc.channelConfigJsonSchema.required).toContain(
        "targetUrl",
      );
      expect(webhookDesc.credentialJsonSchema.required).toContain(
        "signingSecret",
      );
      expect(
        webhookDesc.credentialJsonSchema.properties["signingSecret"]?.secret,
      ).toBe(true);

      // 4. Channel-config validator rejects a body that's missing
      //    targetUrl. (Defense-in-depth — the admin-API route validates
      //    BEFORE writing the credential or row.)
      const missingUrl = webhookDesc.validateConfig({});
      expect(missingUrl.ok).toBe(false);
      // 5. Channel-config validator accepts a minimal valid body.
      const okConfig = webhookDesc.validateConfig({
        targetUrl: "https://n8n.example.com/webhook/abc-123",
      });
      expect(okConfig.ok).toBe(true);
      // 6. THREAT-MODEL §3.6 invariant 11: Authorization header is
      //    forbidden in operator-supplied headers.
      const authBlocked = webhookDesc.validateConfig({
        targetUrl: "https://n8n.example.com/webhook/abc-123",
        headers: { Authorization: "Bearer token-from-prompt-injection" },
      });
      expect(authBlocked.ok).toBe(false);

      // 7. Credential validator rejects a body missing signingSecret.
      const missingSecret = webhookDesc.validateCredentials({});
      expect(missingSecret.ok).toBe(false);
      // 8. Credential validator accepts the standard shape.
      const okCreds = webhookDesc.validateCredentials({
        signingSecret: "a".repeat(64),
      });
      expect(okCreds.ok).toBe(true);

      // 9. `/api/admin/adapters` surfaces BOTH outputAdapters — this
      //    is the helper the route calls; asserting it here pins the
      //    UI's Output-channel-picker behaviour without spinning up
      //    the full admin-API plugin from this package.
      const listed = getOutputAdapterListEntries(
        result.outputChannelDescriptors,
      );
      const surfaced = listed.map((e) => e.slug).sort();
      expect(surfaced).toEqual(["asana", "webhook"]);
      const webhookEntry = listed.find((e) => e.slug === "webhook");
      expect(webhookEntry?.channelConfigSchema.required).toContain(
        "targetUrl",
      );
      expect(webhookEntry?.credentialSchema.required).toContain(
        "signingSecret",
      );

      await result.workerContext.closeProducers().catch(() => undefined);
      await result.closeForgetQueues();
      await result.pgPool.end().catch(() => undefined);
      await (result.redis as unknown as { quit?: () => Promise<unknown> })
        .quit?.()
        .catch(() => undefined);
    },
  );

  // PR-Flake (wave-17) — pin-test for unhandled-rejection absence.
  //
  // Two-pronged assertion:
  //   1. The `vi.mock("bullmq", ...)` block at module-top is in
  //      effect — `Queue` resolves to the no-network FakeQueue.
  //      Without the mock, `composeProductionWorkerContext` builds
  //      three real BullMQ Queue handles against `redis://stub`,
  //      each spawning an ioredis that fires `getaddrinfo('stub')`.
  //      On CI's restricted-egress runners the lookup fails with
  //      EAI_AGAIN POST-test and exit-1's the vitest shard.
  //
  //   2. After draining the macrotask + microtask queues, NO
  //      unhandled rejection has reached the process-level handler.
  //      Locally this passes either way (vitest's per-test
  //      catchall swallows the synchronous ENOTFOUND); on CI the
  //      late EAI_AGAIN escapes that catchall and would land here.
  //
  // Prong 1 catches the regression deterministically in any
  // environment. Prong 2 is the defense-in-depth backstop.
  it("does not leak post-test unhandled rejections (no EAI_AGAIN on CI)", async () => {
    const { Queue } = await import("bullmq");
    expect(Queue.name).toBe("FakeQueue");

    // Two macrotask ticks + one microtask tick — enough for
    // node:dns to settle a queued lookup and for ioredis' retry
    // backoff to fire its first attempt.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(unhandledRejections).toEqual([]);
  });
});
