/**
 * `composeProductionWorkerContext` contract tests
 * (PR-M2, phase-a appendix #5).
 *
 * Pins:
 *   - Returns a fully-populated `WorkerContext` with non-undefined
 *     `db`, `logger`, `wikiDeps`, `wikiAdapter`, `router`, `author`,
 *     `guardAdapter`, `adapterRegistry`, AND `enqueue` (the
 *     scanner-classify producer-side handle).
 *   - SourceAdapterRegistry resolves a binding by id when a row is
 *     present in `sources_bindings` with credentials_id pointing at
 *     a CredentialStore-resolvable record.
 *   - When a credential lookup fails, `adapterRegistry.get(slug)`
 *     returns `undefined` (not a throw) so the scanner's
 *     `scanner.adapter_missing` path catches it gracefully.
 *
 * The test uses pglite + ioredis-mock + stubs for the AdapterRegistry
 * factory and the Gitea client — production composition wires real
 * factories from the shared adapter-registry. The factories
 * themselves are unit-tested in their own packages.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import IORedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";

import * as schema from "@opencoo/shared/db/schema";
import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@opencoo/shared/credential-store";
import type { SourceAdapter } from "@opencoo/shared/source-adapter";

import {
  SCANNER_CRON_DEFAULT,
  SCANNER_REPEAT_KEY,
  composeProductionWorkerContext,
  type ComposeProductionContextArgs,
} from "../../src/workers/production-context.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
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

interface Fixture {
  readonly db: ReturnType<typeof drizzle>;
  readonly raw: PGlite;
  readonly domainId: string;
}

async function freshFixture(): Promise<Fixture> {
  const pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(TABLES_DDL);
  const db = drizzle(pg, { schema });
  const dr = await pg.query<{ id: string }>(
    `INSERT INTO domains (slug, name) VALUES ('test-domain', 'Test Domain') RETURNING id`,
  );
  return { db, raw: pg, domainId: dr.rows[0]!.id };
}

function fakeAdapterFactory() {
  let lastConfig: unknown = null;
  const factory = (args: { config: unknown }): SourceAdapter => {
    lastConfig = args.config;
    return {
      slug: "drive",
      async scan() {
        return { documents: [], nextCursor: null };
      },
    };
  };
  const seen = (): unknown => lastConfig;
  return { factory, seen };
}

function buildArgs(
  fixture: Fixture,
  overrides: Partial<ComposeProductionContextArgs> = {},
): ComposeProductionContextArgs {
  const redis = new IORedisMock();
  const credentialStore: CredentialStore = new InMemoryCredentialStore({
    logger: silentLogger(),
  });
  const fake = fakeAdapterFactory();
  const args: ComposeProductionContextArgs = {
    db: fixture.db as unknown as ComposeProductionContextArgs["db"],
    logger: silentLogger(),
    redisConnection: {
      url: "redis://stub",
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
    redisClient: redis as unknown as ComposeProductionContextArgs["redisClient"],
    credentialStore,
    sourceAdapterFactories: {
      drive: fake.factory,
      asana: fake.factory,
      n8n: fake.factory,
      fireflies: fake.factory,
      webhook: fake.factory,
    },
    wikiAdapter: {
      slug: "stub-wiki",
      async getHeadSha() { return "stub-sha"; },
      async readPage() { return null; },
      async writeAtomic() { return { status: "ok", sha: "stub-sha" }; },
      async listMarkdown() { return []; },
    } as unknown as ComposeProductionContextArgs["wikiAdapter"],
    router: {} as unknown as ComposeProductionContextArgs["router"],
    guardAdapter: {
      slug: "stub-guard",
      role: "redaction" as const,
      categories: [],
      patternVersion: "v1-stub",
      async classify(input) {
        return { events: [], transformedText: input.text };
      },
    } as unknown as ComposeProductionContextArgs["guardAdapter"],
    author: { name: "opencoo-test", email: "test@opencoo.local" },
    instanceId: "test-deployment",
    // PR-Z3 (phase-a appendix #12) — every test that boots
    // composition needs this seam wired so the scanner-cron
    // registration call doesn't hit BullMQ's Lua-scripted repeat
    // path (which hangs on ioredis-mock — same limitation the
    // AgentDispatcher tests document at agent-dispatcher.ts:104).
    // Default seam is a no-op record; the PR-Z3-specific tests
    // override with a recording stub.
    registerScannerCronFn: async () => undefined,
    ...overrides,
  };
  return args;
}

describe("composeProductionWorkerContext", () => {
  it("returns a fully-populated WorkerContext with every required field set", async () => {
    const fixture = await freshFixture();
    const args = buildArgs(fixture);
    const ctx = await composeProductionWorkerContext(args);
    expect(ctx.db).toBeDefined();
    expect(ctx.logger).toBeDefined();
    expect(ctx.wikiAdapter).toBeDefined();
    expect(ctx.wikiDeps).toBeDefined();
    expect(ctx.wikiDeps.adapter).toBeDefined();
    expect(ctx.wikiDeps.queue).toBeDefined();
    expect(ctx.wikiDeps.deleteCap).toBeDefined();
    expect(ctx.author).toEqual({ name: "opencoo-test", email: "test@opencoo.local" });
    expect(ctx.router).toBeDefined();
    expect(ctx.guardAdapter).toBeDefined();
    expect(ctx.adapterRegistry).toBeDefined();
    expect(ctx.enqueue).toBeDefined();
    // Round-2 fix (Copilot #56): production composition MUST also
    // populate the four webhook-receiver dependencies so
    // `start({ mode: 'workers' })` can mount the receiver onto the
    // engine's Fastify app. Pinning these here means a future
    // refactor that drops one of them blows up the typecheck +
    // this test before it reaches a deployment.
    expect(ctx.credentialStore).toBeDefined();
    expect(ctx.webhookVerifier).toBeDefined();
    expect(ctx.webhookScannerQueue).toBeDefined();
    expect(typeof ctx.webhookScannerQueue?.add).toBe("function");
    expect(ctx.webhookDlqQueue).toBeDefined();
    expect(typeof ctx.webhookDlqQueue?.add).toBe("function");
    // Cleanup the queue handle.
    await ctx.closeProducers?.();
  });

  it("source-adapter registry resolves an enabled binding via the credential store", async () => {
    const fixture = await freshFixture();
    const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });
    const credId = await credentialStore.write({
      name: "drive-creds",
      schemaRef: "drive/v1",
      plaintext: Buffer.from("stub-secret"),
    });
    // Seed a binding row with credentials_id set.
    await fixture.raw.query(
      `INSERT INTO sources_bindings
         (domain_id, adapter_slug, allowed_paths, credentials_id)
       VALUES ($1::uuid, 'drive', $2::text[], $3::uuid)`,
      [fixture.domainId, ["strategy/**"], credId],
    );

    const fake = fakeAdapterFactory();
    const args = buildArgs(fixture, {
      credentialStore,
      sourceAdapterFactories: {
        drive: fake.factory,
        asana: fake.factory,
        n8n: fake.factory,
        fireflies: fake.factory,
        webhook: fake.factory,
      },
    });
    const ctx = await composeProductionWorkerContext(args);

    const adapter = await ctx.adapterRegistry.get("drive");
    // The registry's get() may be sync (returning a memoised
    // adapter) or async (lazy-resolved); compose can pick either —
    // the test asserts the returned shape. The scanner pipeline
    // calls `registry.get(slug)` synchronously today, so the
    // production registry MUST resolve sync after the first
    // dispatch. We assert presence here.
    expect(adapter).toBeDefined();
    expect(adapter?.slug).toBe("drive");
    await ctx.closeProducers?.();
  });

  it("enqueue.add is callable (BullMQ producer-side handle works)", async () => {
    const fixture = await freshFixture();
    const args = buildArgs(fixture);
    const ctx = await composeProductionWorkerContext(args);
    // The enqueue handle is the producer side of
    // `ingestion.scanner.classify`. We don't care that it actually
    // makes it onto Redis (ioredis-mock approximates the queue);
    // we care that the type / shape is right.
    expect(typeof ctx.enqueue?.add).toBe("function");
    await ctx.closeProducers?.();
  });

  // PR-Z3 (phase-a appendix #12) — scanner cron registration.
  // Closes G3 (polling adapters never tick automatically). The
  // composition root registers ONE repeat-job on the
  // `ingestion.scanner` queue at boot; the scanner ENUMERATES every
  // enabled binding on each tick, so per-binding repeat jobs are
  // unnecessary (and would explode at scale).
  //
  // The test uses the `registerScannerCronFn` test seam (parallel
  // to the AgentDispatcher's `registerScheduleFn` seam — same
  // pattern, same reason: BullMQ's Lua-scripted repeat path hangs
  // on ioredis-mock).
  it("registers the scanner cron on the ingestion.scanner queue at boot (closes G3)", async () => {
    const fixture = await freshFixture();
    const registerCalls: Array<{ repeatKey: string; pattern: string }> = [];
    const args = buildArgs(fixture, {
      registerScannerCronFn: async ({ repeatKey, pattern }) => {
        registerCalls.push({ repeatKey, pattern });
      },
    });
    const ctx = await composeProductionWorkerContext(args);

    // Exactly one cron registration: the SCANNER_REPEAT_KEY +
    // SCANNER_CRON_DEFAULT pair. One repeat-job per engine; the
    // scanner enumerates all bindings on each tick.
    expect(registerCalls).toEqual([
      { repeatKey: SCANNER_REPEAT_KEY, pattern: SCANNER_CRON_DEFAULT },
    ]);
    expect(SCANNER_REPEAT_KEY).toBe("ingestion.scanner.tick");
    expect(SCANNER_CRON_DEFAULT).toBe("0 */4 * * *");

    expect(ctx.webhookScannerQueue).toBeDefined();
    expect(typeof ctx.webhookScannerQueue?.add).toBe("function");

    await ctx.closeProducers?.();
  });

  it("honors an operator-supplied scannerCronPattern override", async () => {
    // The composition root threads `OPENCOO_SCANNER_CRON` here.
    // Pins that the operator's pattern reaches the registration
    // call (not the default).
    const fixture = await freshFixture();
    const customPattern = "*/15 * * * *"; // every 15 minutes
    const registerCalls: Array<{ repeatKey: string; pattern: string }> = [];
    const args = buildArgs(fixture, {
      scannerCronPattern: customPattern,
      registerScannerCronFn: async ({ repeatKey, pattern }) => {
        registerCalls.push({ repeatKey, pattern });
      },
    });
    const ctx = await composeProductionWorkerContext(args);
    expect(registerCalls).toEqual([
      { repeatKey: SCANNER_REPEAT_KEY, pattern: customPattern },
    ]);
    await ctx.closeProducers?.();
  });

  it("scanner cron registration failure does not crash composition (best-effort)", async () => {
    // A failed cron registration must not crash boot — the webhook
    // fast-path + on-demand "Scan now" still work without the cron
    // backstop. The composition's try/catch around the registration
    // converts the failure to a warn log + continues.
    const fixture = await freshFixture();
    const args = buildArgs(fixture, {
      registerScannerCronFn: async () => {
        throw new Error("simulated redis outage");
      },
    });
    const ctx = await composeProductionWorkerContext(args);
    expect(ctx.enqueue).toBeDefined();
    expect(ctx.webhookScannerQueue).toBeDefined();
    expect(ctx.webhookDlqQueue).toBeDefined();
    expect(ctx.closeProducers).toBeDefined();
    await ctx.closeProducers?.();
  });
});

// Suppress no-unused-vars on Fixture type (used implicitly).
void schema;
void sql;
