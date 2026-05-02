/**
 * Webhook → wiki end-to-end use-case test (PR-M1, phase-a appendix #5).
 *
 * Exercises the FULL ingestion pipeline shape with a stub
 * SourceAdapter + InMemoryWikiAdapter:
 *
 *   1. The Scanner worker handler is invoked → calls
 *      SourceAdapter.scan() → writes an `ingestion_intake` row →
 *      enqueues a ScannerClassifyJob to `ingestion.scanner.classify`.
 *   2. The Compile worker handler is invoked with that job → runs
 *      classify (Worker tier, MockLlmClient) + compile (Thinker
 *      tier, MockLlmClient) → calls wikiWrite via the
 *      InMemoryWikiAdapter.
 *   3. The InMemoryWikiAdapter records the commit — proving the
 *      end-to-end flow bottomed out at the wiki.
 *
 * The test SKIPS the BullMQ Worker pull loop (ioredis-mock doesn't
 * fully implement BullMQ's blocking/Lua paths). Instead it
 * invokes each handler directly with the jobs the prior step
 * enqueued — which is exactly what BullMQ would do, sans the
 * Redis hop. The boot path (`startIngestionWorkers`) is exercised
 * separately in `tests/workers/workers.test.ts` to prove the
 * Worker construction itself works.
 *
 * The test also asserts that calling `closeAll()` on the workers
 * handle drains every worker cleanly — proving SIGTERM-equivalent
 * shutdown.
 */
import { sql } from "drizzle-orm";
import IORedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import type { GuardAdapter } from "@opencoo/shared/adapter-contract-tests/guard";
import type {
  SourceAdapter,
  SourceScanResult,
} from "@opencoo/shared/source-adapter";

import {
  buildCompilationHandler,
  buildScannerHandler,
  startIngestionWorkers,
  type WorkerContext,
} from "../../src/workers/index.js";
import type { ScannerClassifyJob } from "../../src/pipelines/scanner.js";

import { freshPipelineDb } from "../pipelines/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

function passThroughGuard(): GuardAdapter {
  return {
    slug: "guard-passthrough-e2e",
    role: "redaction",
    categories: [],
    patternVersion: "v1-e2e",
    async classify(input) {
      return { events: [], transformedText: input.text };
    },
  };
}

const STUB_AUTHOR = {
  name: "opencoo-test",
  email: "test@opencoo.local",
} as const;

/** In-memory wikiDeps fixture shared by both e2e cases. Clock is
 *  pinned so commit-time-dependent assertions stay deterministic. */
function inMemoryWikiDeps(adapter: InMemoryWikiAdapter): WikiWriteDeps {
  return {
    adapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => new Date("2026-04-25T12:00:00Z"),
  };
}

/** Build an LlmRouter wrapping the supplied provider. The pauser
 *  stub is a no-op — these e2e tests don't exercise the cost-cap
 *  pause logic. */
function makeRouter(
  fixture: Awaited<ReturnType<typeof freshPipelineDb>>,
  provider: LlmProvider,
): LlmRouter {
  return new LlmRouter({
    db: fixture.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: {
      paused: () => false,
      pause: () => undefined,
      resume: () => undefined,
    },
    provider,
  });
}

function makeStubSourceAdapter(slug: string): SourceAdapter {
  return {
    slug,
    async scan(): Promise<SourceScanResult> {
      return {
        documents: [
          {
            sourceDocId: "doc-stub-1",
            sourceRevision: "rev-1",
            sourceRef: `${slug}:doc-stub-1`,
            fetchedAt: new Date("2026-04-25T12:00:00Z"),
            contentBytes: Buffer.from(
              "Q3 priorities: distribution motion + GTM alignment.",
              "utf8",
            ),
          },
        ],
        nextCursor: "cursor-1",
      };
    },
  };
}

function buildClassifierMock(): MockLlmClient {
  const mock = new MockLlmClient();
  mock.register({
    match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
    response: {
      text: JSON.stringify({
        version: "v1",
        language: "en",
        summary: "Q3 strategy doc",
        target_domains: [
          {
            domain_slug: "test-domain",
            page_paths: ["strategy/q3-2026.md"],
          },
        ],
        pipelines: ["compile.single-source"],
      }),
      tokensIn: 100,
      tokensOut: 50,
    },
  });
  mock.register({
    match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
    response: {
      text: JSON.stringify({
        merged_body:
          "# Q3 strategy\n\nDistribution motion + GTM alignment.\n",
        worldview_impact: ["Distribution prioritised"],
      }),
      tokensIn: 100,
      tokensOut: 50,
    },
  });
  return mock;
}

describe("webhook → wiki end-to-end (PR-M1)", () => {
  it("scans a binding → enqueues classify → compile handler writes to wiki", async () => {
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const wikiDeps = inMemoryWikiDeps(wikiAdapter);

    // Stage 1: invoke the Scanner handler directly. Uses the
    // pglite-seeded binding from `freshPipelineDb` (adapter_slug:
    // 'drive', allowed_paths: ['strategy/**', 'executive/**']).
    const enqueuedJobs: ScannerClassifyJob[] = [];
    const stubAdapter = makeStubSourceAdapter("drive");
    const scannerHandler = buildScannerHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
      adapterRegistry: {
        get: (slug) => (slug === "drive" ? stubAdapter : undefined),
      },
      enqueue: {
        async add(_name: string, data: ScannerClassifyJob) {
          enqueuedJobs.push(data);
          return { id: `job-${enqueuedJobs.length}` };
        },
      },
    });
    const scanResult = await scannerHandler({
      id: "scanner-job-1",
      data: {},
    } as unknown as Parameters<typeof scannerHandler>[0]);

    expect(scanResult.bindingsScanned).toBe(1);
    expect(scanResult.documentsEnqueued).toBe(1);
    expect(enqueuedJobs).toHaveLength(1);

    // Verify the ingestion_intake row landed.
    const intakeRows = (await fixture.db.execute(
      sql`SELECT id::text AS id, status FROM ingestion_intake`,
    )) as unknown as { rows: Array<{ id: string; status: string }> };
    expect(intakeRows.rows).toHaveLength(1);
    expect(intakeRows.rows[0]?.status).toBe("pending");

    // Stage 2: invoke the Compile handler with the enqueued job.
    // Wire a real LlmRouter backed by MockLlmClient so the
    // classifier + compiler return canned outputs.
    const compileHandler = buildCompilationHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
      router: makeRouter(fixture, buildClassifierMock()),
      wikiDeps,
      author: STUB_AUTHOR,
      guardAdapter: passThroughGuard(),
    });

    const job = enqueuedJobs[0]!;
    const compileResult = await compileHandler({
      id: "compile-job-1",
      data: job,
    } as unknown as Parameters<typeof compileHandler>[0]);

    // The compile handler ran the classifier + compiler against
    // the canned MockLlmClient responses; one target domain →
    // one wikiWrite commit.
    expect(compileResult.classifiedDomains).toBe(1);
    expect(compileResult.commitsLanded).toBe(1);

    // Stage 3: assert the wiki adapter received a write at the
    // path the classifier picked. The InMemoryWikiAdapter exposes
    // pages per domain; we read back and confirm the body landed.
    const writtenPage = await wikiAdapter.readPage(
      "test-domain" as Parameters<InMemoryWikiAdapter["readPage"]>[0],
      "strategy/q3-2026.md",
    );
    expect(writtenPage).not.toBeNull();
    expect(writtenPage?.content).toContain("Q3 strategy");

    // Intake row flipped to classified.
    const afterIntake = (await fixture.db.execute(
      sql`SELECT status FROM ingestion_intake`,
    )) as unknown as { rows: Array<{ status: string }> };
    expect(afterIntake.rows[0]?.status).toBe("classified");
  });

  it("composeProductionWorkerContext → startIngestionWorkers wires every required dep (PR-M2)", async () => {
    // Validates the production composition root: feed
    // composeProductionWorkerContext stub ingredients (matches what
    // the orchestrator wires from env), then check the returned
    // WorkerContext drives startIngestionWorkers without throwing
    // and exposes every required field. Pins that PR-M2's
    // composition root and PR-M1's worker boot are wire-compatible.
    const { composeProductionWorkerContext } = await import(
      "../../src/workers/production-context.js"
    );
    const { InMemoryCredentialStore } = await import(
      "@opencoo/shared/credential-store"
    );

    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const redis = new IORedisMock();
    const credentialStore = new InMemoryCredentialStore({
      logger: silentLogger(),
    });

    const ctx = await composeProductionWorkerContext({
      db: fixture.db as unknown as Parameters<
        typeof composeProductionWorkerContext
      >[0]["db"],
      logger: silentLogger(),
      redisConnection: {
        url: "redis://stub",
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
      credentialStore,
      sourceAdapterFactories: {},
      wikiAdapter: wikiAdapter as unknown as Parameters<
        typeof composeProductionWorkerContext
      >[0]["wikiAdapter"],
      router: makeRouter(fixture, new MockLlmClient()),
      guardAdapter: passThroughGuard(),
      author: STUB_AUTHOR,
      instanceId: "test-instance",
    });

    const handle = startIngestionWorkers({
      ctx,
      connection: redis as unknown as Parameters<
        typeof startIngestionWorkers
      >[0]["connection"],
      autorun: false,
    });

    expect(handle.scanner.name).toBe("ingestion.scanner");
    expect(handle.compile.name).toBe("ingestion.scanner.classify");
    await handle.closeAll(5_000);
    await ctx.closeProducers();
    redis.disconnect();
  });

  it("startIngestionWorkers + closeAll() drains all workers cleanly (SIGTERM-equiv)", async () => {
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const redis = new IORedisMock();

    const handle = startIngestionWorkers({
      ctx: {
        db: fixture.db as unknown as WorkerContext["db"],
        logger: silentLogger(),
        wikiDeps: inMemoryWikiDeps(wikiAdapter),
        wikiAdapter,
        author: STUB_AUTHOR,
        router: makeRouter(fixture, new MockLlmClient()),
        guardAdapter: passThroughGuard(),
        adapterRegistry: { get: () => undefined },
      },
      connection: redis as unknown as Parameters<
        typeof startIngestionWorkers
      >[0]["connection"],
      autorun: false,
    });

    // closeAll() must complete within the 30s default — pin a
    // tight 5s window to catch hangs early.
    await expect(handle.closeAll(5_000)).resolves.toBeUndefined();
    redis.disconnect();
  });
});
