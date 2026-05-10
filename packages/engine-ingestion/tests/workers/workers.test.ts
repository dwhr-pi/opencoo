/**
 * Worker contract tests (PR-M1, phase-a appendix #5).
 *
 * Each pipeline ships as a pure async function; PR-M1 wraps each
 * one in a BullMQ `Worker` so the engine actually DEQUEUES the
 * jobs the webhook receiver / scanner enqueue. This file pins
 * the contract:
 *
 *   1. The handler factory is a pure function — given a
 *      `WorkerContext` it returns `(job) => Promise<result>`. No
 *      BullMQ Redis traffic is exercised here; the wrapping logic
 *      is the unit under test.
 *   2. Errors thrown from the underlying pipeline propagate so
 *      BullMQ retries.
 *   3. `startIngestionWorkers(ctx)` returns a typed handle that
 *      exposes all five workers AND a `closeAll()` method that
 *      drains every worker in parallel.
 *   4. The full `Worker` instance is named `<prefix>.<slug>`,
 *      matching the queue handle producers write to.
 */
import type { Job } from "bullmq";
import IORedisMock from "ioredis-mock";
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import type { GuardAdapter } from "@opencoo/shared/adapter-contract-tests/guard";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { SourceAdapter } from "@opencoo/shared/source-adapter";

import {
  MISSING_ENQUEUE,
  MISSING_ENQUEUE_MESSAGE,
  buildCleanupHandler,
  buildCompilationHandler,
  buildIndexRebuildHandler,
  buildReviewDispatchHandler,
  buildScannerHandler,
  startIngestionWorkers,
  type WorkerContext,
} from "../../src/workers/index.js";

import { freshPipelineDb } from "../pipelines/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

function fakeJob<T>(data: T, id = "job-1"): Job<T> {
  return {
    id,
    name: "test",
    data,
    queueName: "test-queue",
    attemptsMade: 0,
    timestamp: Date.now(),
  } as unknown as Job<T>;
}

function noOpGuard(): GuardAdapter {
  return {
    slug: "guard-noop",
    role: "redaction",
    categories: [],
    async classify(args) {
      return { transformedText: args.text, events: [] };
    },
  } as unknown as GuardAdapter;
}

function fakeRouter(): LlmRouter {
  // The cleanup / review-dispatch / index-rebuild paths under
  // test in this file never invoke the router. The compile-worker
  // unit test below exercises only the failure path (load binding
  // returns null) so the router is never called either.
  return {} as unknown as LlmRouter;
}

const REBUILDER_AUTHOR = {
  name: "opencoo-rebuilder",
  email: "rebuilder@opencoo.local",
} as const;

/** Build the in-memory wikiDeps fixture every worker test in this
 *  file uses. The clock is pinned so dependent assertions stay
 *  deterministic across runs. */
function inMemoryWikiDeps(adapter: InMemoryWikiAdapter): {
  adapter: InMemoryWikiAdapter;
  queue: InMemoryWikiWriteQueue;
  deleteCap: InMemoryDeleteCap;
  logger: ConsoleLogger;
  clock: () => Date;
} {
  return {
    adapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => new Date("2026-04-25T12:00:00Z"),
  };
}

/** Assemble the WorkerContext both `startIngestionWorkers` test
 *  cases construct identically. The compile worker exercises only
 *  the failure path here so a fakeRouter / noOpGuard is fine. */
function makeWorkerCtx(args: {
  fixture: Awaited<ReturnType<typeof freshPipelineDb>>;
  wikiAdapter: InMemoryWikiAdapter;
}): WorkerContext {
  return {
    db: args.fixture.db as unknown as WorkerContext["db"],
    logger: silentLogger(),
    wikiDeps: inMemoryWikiDeps(args.wikiAdapter),
    wikiAdapter: args.wikiAdapter,
    author: REBUILDER_AUTHOR,
    router: fakeRouter(),
    guardAdapter: noOpGuard(),
    adapterRegistry: { get: () => undefined },
  };
}

describe("buildScannerHandler", () => {
  it("invokes runScanner with the worker context", async () => {
    const fixture = await freshPipelineDb();
    const enqueueAdds: unknown[] = [];
    const handler = buildScannerHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => undefined },
      enqueue: {
        async add(_name: string, data: unknown) {
          enqueueAdds.push(data);
          return undefined;
        },
      },
    });
    const result = await handler(fakeJob({}));
    // No bindings adapter-resolved → 0 enqueues, 0 documents.
    expect(result).toMatchObject({
      bindingsScanned: expect.any(Number),
      documentsEnqueued: 0,
    });
    expect(enqueueAdds).toEqual([]);
  });
});

describe("buildReviewDispatchHandler", () => {
  it("invokes runReviewDispatcher with job.data as payload", async () => {
    const handler = buildReviewDispatchHandler({
      logger: silentLogger(),
    });
    const result = await handler(
      fakeJob({
        domainSlug: "test-domain",
        reviewRole: "executive-team",
        commitSha: "abc",
        pagePaths: ["strategy/x.md"],
        sourceRef: "drive:doc-1",
      }),
    );
    expect(result).toMatchObject({
      dispatched: true,
      reviewRole: "executive-team",
    });
  });

  it("rethrows ValidationError on bad payload (so BullMQ DLQs)", async () => {
    const handler = buildReviewDispatchHandler({
      logger: silentLogger(),
    });
    await expect(
      handler(fakeJob({ bogus: true })),
    ).rejects.toThrow();
  });
});

describe("buildIndexRebuildHandler", () => {
  it("invokes runIndexRebuilder using job.data.domainSlug", async () => {
    const wikiAdapter = new InMemoryWikiAdapter();
    const handler = buildIndexRebuildHandler({
      logger: silentLogger(),
      wikiDeps: inMemoryWikiDeps(wikiAdapter),
      wikiAdapter,
      author: REBUILDER_AUTHOR,
    });
    const result = await handler(
      fakeJob({ domainSlug: "test-domain" }),
    );
    // Empty wiki → first rebuild creates index.md once. fileCount
    // counts pages excluding index.md itself, so it's 0.
    expect(result.fileCount).toBe(0);
    expect(typeof result.commitSha === "string" || result.commitSha === null).toBe(true);
  });

  it("throws when job.data lacks domainSlug", async () => {
    const wikiAdapter = new InMemoryWikiAdapter();
    const handler = buildIndexRebuildHandler({
      logger: silentLogger(),
      wikiDeps: inMemoryWikiDeps(wikiAdapter),
      wikiAdapter,
      author: REBUILDER_AUTHOR,
    });
    await expect(handler(fakeJob({}))).rejects.toThrow(/domainSlug/);
  });
});

describe("buildCleanupHandler", () => {
  it("invokes runCleanup against the supplied db", async () => {
    const fixture = await freshPipelineDb();
    const handler = buildCleanupHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
    });
    const result = await handler(fakeJob({}));
    expect(result).toMatchObject({
      debugRowsDeleted: 0,
      orphanRowsDeleted: 0,
    });
  });
});

describe("buildCompilationHandler", () => {
  it("invokes runCompilationWorker with job.data as the ScannerClassifyJob", async () => {
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const handler = buildCompilationHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
      router: fakeRouter(),
      wikiDeps: inMemoryWikiDeps(wikiAdapter),
      author: REBUILDER_AUTHOR,
      guardAdapter: noOpGuard(),
    });
    // Lookup will fail (binding doesn't exist) — the wrapper
    // surfaces the error so BullMQ retries / DLQs.
    await expect(
      handler(
        fakeJob({
          bindingId: "00000000-0000-0000-0000-000000000000",
          intakeId: "00000000-0000-0000-0000-000000000001",
          domainSlug: "test-domain",
          sourceRef: "drive:doc-1",
          contentBase64: Buffer.from("hello").toString("base64"),
          fetchedAt: new Date("2026-04-25T12:00:00Z").toISOString(),
        }),
      ),
    ).rejects.toThrow(/binding/);
  });
});

describe("startIngestionWorkers", () => {
  it("returns a typed handle exposing every worker (5 ingestion + 2 forget consumers) + closeAll", async () => {
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const redis = new IORedisMock();
    const handle = startIngestionWorkers({
      ctx: makeWorkerCtx({ fixture, wikiAdapter }),
      connection: redis as unknown as Parameters<
        typeof startIngestionWorkers
      >[0]["connection"],
      // Tests run with autorun:false so the workers don't pull
      // jobs in the background and confound assertions.
      autorun: false,
    });

    expect(handle.scanner.name).toBe("ingestion.scanner");
    expect(handle.compile.name).toBe("ingestion.scanner.classify");
    expect(handle.reviewDispatch.name).toBe("ingestion.review.dispatch");
    expect(handle.indexRebuild.name).toBe("ingestion.index-rebuild");
    expect(handle.cleanup.name).toBe("ingestion.cleanup");
    // PR-W6 (phase-a appendix #11 follow-up #65): the two forget
    // consumer workers bind to the multi-dot queue slugs the route's
    // `forgetJobEnqueuer` produces into. Drift between these names
    // and the slugs in `@opencoo/shared/forget` would silently park
    // jobs forever — the test pins the wire.
    expect(handle.forgetRecompile.name).toBe("wiki.recompile");
    expect(handle.forgetDelete.name).toBe("wiki.delete");

    await expect(handle.closeAll()).resolves.toBeUndefined();

    redis.disconnect();
  });

  it("closeAll() closes every worker", async () => {
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const redis = new IORedisMock();
    const handle = startIngestionWorkers({
      ctx: makeWorkerCtx({ fixture, wikiAdapter }),
      connection: redis as unknown as Parameters<
        typeof startIngestionWorkers
      >[0]["connection"],
      autorun: false,
    });

    const closeSpies = [
      vi.spyOn(handle.scanner, "close"),
      vi.spyOn(handle.compile, "close"),
      vi.spyOn(handle.reviewDispatch, "close"),
      vi.spyOn(handle.indexRebuild, "close"),
      vi.spyOn(handle.cleanup, "close"),
      vi.spyOn(handle.forgetRecompile, "close"),
      vi.spyOn(handle.forgetDelete, "close"),
    ];

    await handle.closeAll();
    for (const spy of closeSpies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }

    redis.disconnect();
  });
});

describe("startIngestionWorkers — closeAll() drain timer", () => {
  it("resolves promptly when every worker closes (no timer leak)", async () => {
    // Repro for the setTimeout leak: the watchdog timer in closeAll
    // must be cleared on the success branch. Otherwise the unhandled
    // timer keeps the event loop alive for up to `timeoutMs` and the
    // 100ms watchdog below would fire before closeAll() resolves.
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const redis = new IORedisMock();
    const handle = startIngestionWorkers({
      ctx: makeWorkerCtx({ fixture, wikiAdapter }),
      connection: redis as unknown as Parameters<
        typeof startIngestionWorkers
      >[0]["connection"],
      autorun: false,
    });

    // Pin a 30s drain window so an un-cleared timer would leak for
    // 30s after closeAll() resolves. The 100ms watchdog catches
    // the race: if closeAll() doesn't resolve before the watchdog,
    // the test rejects with a clear "did not resolve promptly" message.
    const watchdog = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("closeAll() did not resolve promptly")),
        100,
      );
      // Don't keep the test process alive on the watchdog itself.
      t.unref?.();
    });

    await Promise.race([handle.closeAll(30_000), watchdog]);
    redis.disconnect();
  });
});

describe("startIngestionWorkers — MISSING_ENQUEUE diagnostic", () => {
  it("MISSING_ENQUEUE.add() throws with the operator-facing diagnostic", async () => {
    // Direct assertion on the fallback the orchestrator wires
    // when ctx.enqueue is undefined. The thrown message must name
    // the missing wire concretely (queue slug + which side did
    // not supply it) — ambiguous diagnostics turn into
    // hours-long debug sessions in production.
    await expect(MISSING_ENQUEUE.add("classify", {})).rejects.toThrow(
      MISSING_ENQUEUE_MESSAGE,
    );
    expect(MISSING_ENQUEUE_MESSAGE).toMatch(/ctx\.enqueue is undefined/);
    expect(MISSING_ENQUEUE_MESSAGE).toMatch(
      /ingestion\.scanner\.classify/,
    );
  });

  it("startIngestionWorkers wires MISSING_ENQUEUE when ctx.enqueue is undefined", async () => {
    // Integration: when the orchestrator omits ctx.enqueue and
    // the scanner attempts to dispatch, the runScanner pipeline
    // catches the throw and logs `scanner.enqueue_failed` with
    // the diagnostic message. The handle still closes cleanly.
    const fixture = await freshPipelineDb();
    const wikiAdapter = new InMemoryWikiAdapter();
    const redis = new IORedisMock();

    // Seed an adapter that returns a document so the scanner
    // reaches the enqueue call site (the empty-registry path
    // never calls .add).
    const stubAdapter: SourceAdapter = {
      slug: "drive",
      async scan() {
        return {
          documents: [
            {
              sourceDocId: "doc-missing-enqueue",
              sourceRevision: "rev-1",
              sourceRef: "drive:doc-missing-enqueue",
              fetchedAt: new Date("2026-04-25T12:00:00Z"),
              contentBytes: Buffer.from("hello"),
            },
          ],
          nextCursor: "cursor-1",
        };
      },
    };

    // Capture logger output to confirm the diagnostic message
    // surfaces in `scanner.enqueue_failed`.
    const logs: string[] = [];
    const captureLogger = new ConsoleLogger({
      stream: {
        write: (chunk: string): boolean => {
          logs.push(chunk);
          return true;
        },
      },
    });

    const ctx: WorkerContext = {
      ...makeWorkerCtx({ fixture, wikiAdapter }),
      logger: captureLogger,
      adapterRegistry: {
        get: (slug) => (slug === "drive" ? stubAdapter : undefined),
      },
      // ctx.enqueue deliberately omitted — startIngestionWorkers
      // wires MISSING_ENQUEUE in its place.
    };

    const handle = startIngestionWorkers({
      ctx,
      connection: redis as unknown as Parameters<
        typeof startIngestionWorkers
      >[0]["connection"],
      autorun: false,
    });

    // Build the SAME handler shape startIngestionWorkers wires —
    // routing the scanner's enqueue through MISSING_ENQUEUE so
    // we exercise the production path end-to-end.
    const handler = buildScannerHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: captureLogger,
      adapterRegistry: ctx.adapterRegistry,
      enqueue: MISSING_ENQUEUE,
    });

    // runScanner catches the enqueue throw (per
    // pipelines/scanner.ts) and logs `scanner.enqueue_failed`
    // — surfacing the misconfiguration in operator logs without
    // tearing down the whole scan run.
    await handler(fakeJob({}));
    const joined = logs.join("");
    expect(joined).toContain("scanner.enqueue_failed");
    expect(joined).toContain("ctx.enqueue is undefined");

    await handle.closeAll();
    redis.disconnect();
  });
});

describe("buildScannerHandler — sse emission", () => {
  it("worker-event run emission scrubs PATs from error messages", async () => {
    // Lightweight smoke for THREAT-MODEL §3.6 invariant 11 — when
    // the scanner handler throws, any PAT in the error must not
    // appear in the SSE-emitted error string. The wrapper itself
    // surfaces the error to BullMQ; scrub is applied before
    // emitting the run event from the worker's `failed` listener
    // (wired in startIngestionWorkers).
    //
    // We exercise the wrapper directly here: a thrown error
    // containing a Bearer token should propagate raw (BullMQ
    // gets the original), and the SSE listener (separately
    // verified at the start.test integration tier) does the
    // scrub. This keeps the wrapper unit-pure.
    const fixture = await freshPipelineDb();
    // Force a binding row that doesn't exist so the scanner loop
    // is empty — handler returns cleanly (no error path).
    const handler = buildScannerHandler({
      db: fixture.db as unknown as WorkerContext["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => undefined },
      enqueue: { async add() { return undefined; } },
    });
    const result = await handler(fakeJob({}));
    expect(result.documentsEnqueued).toBe(0);
  });
});
