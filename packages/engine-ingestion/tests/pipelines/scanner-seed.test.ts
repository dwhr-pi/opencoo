/**
 * Scanner-seed integration tests (PR-Z2, phase-a appendix #12 G2).
 *
 * The Scanner's seed-vs-scan dispatch:
 *   - `last_scan_cursor === null` AND `adapter.seed !== undefined`
 *     → call `adapter.seed(...)` and persist `result.cursor` as
 *       the new `last_scan_cursor`.
 *   - Otherwise → call `adapter.scan(...)` with the persisted
 *     cursor.
 *
 * Coverage:
 *   1. First tick on a seeded-capable adapter routes through
 *      seed(), the documents land in `ingestion_intake`, and
 *      the cursor is persisted.
 *   2. Subsequent tick on the same binding routes through scan()
 *      (because the cursor is now non-null) — verifies the
 *      "no re-seeding" invariant.
 *   3. Adapter without `seed` defined falls back to scan() even
 *      on the first tick (webhook-only adapters, fireflies,
 *      generic webhook, n8n).
 *   4. Failed seed leaves `last_scan_cursor` null so the next
 *      tick re-tries; partial-seed dedupe via the intake UNIQUE
 *      constraint is verified.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import type {
  SourceAdapter,
  SourceSeedResult,
  SourceScanResult,
} from "@opencoo/shared/source-adapter";

import {
  runScanner,
  type ScannerClassifyJob,
  type ScannerEnqueue,
} from "../../src/pipelines/scanner.js";

import { freshPipelineDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

interface TestEnqueue extends ScannerEnqueue {
  readonly jobs: ScannerClassifyJob[];
}

function makeEnqueue(): TestEnqueue {
  const jobs: ScannerClassifyJob[] = [];
  return {
    jobs,
    async add(_name: string, data: ScannerClassifyJob) {
      jobs.push(data);
      return { id: `job-${jobs.length}` };
    },
  };
}

// Stateful adapter fixture — both seed() and scan() are
// scriptable per-call so the test asserts which path the
// scanner takes.
interface StatefulAdapterArgs {
  readonly slug: string;
  /** When defined, the adapter exposes `seed` and returns this
   *  result. When undefined, the property is omitted. */
  readonly seedResult?: SourceSeedResult;
  /** Default scan response. Overridable per call via
   *  `setScanResult`. */
  readonly scanResult: SourceScanResult;
}

interface StatefulAdapterHandle {
  readonly adapter: SourceAdapter;
  readonly seedCalls: { count: number };
  readonly scanCalls: { count: number };
  setScanResult(next: SourceScanResult): void;
}

function makeStatefulAdapter(args: StatefulAdapterArgs): StatefulAdapterHandle {
  const seedCalls = { count: 0 };
  const scanCalls = { count: 0 };
  let scanResult = args.scanResult;
  const adapter: SourceAdapter = {
    slug: args.slug,
    async scan(): Promise<SourceScanResult> {
      scanCalls.count++;
      return scanResult;
    },
    ...(args.seedResult !== undefined
      ? {
          async seed(): Promise<SourceSeedResult> {
            seedCalls.count++;
            return args.seedResult!;
          },
        }
      : {}),
  };
  return {
    adapter,
    seedCalls,
    scanCalls,
    setScanResult(next): void {
      scanResult = next;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. First tick with seed-capable adapter routes through seed()
// ---------------------------------------------------------------------------

describe("scanner — first tick on seed-capable adapter", () => {
  it("calls seed() instead of scan(), persists cursor, and enqueues each doc", async () => {
    const f = await freshPipelineDb({});
    const handle = makeStatefulAdapter({
      slug: "drive",
      seedResult: {
        documents: [
          {
            sourceDocId: "seed-doc-1",
            sourceRevision: "rev-1",
            sourceRef: "drive:seed-doc-1",
            fetchedAt: new Date("2026-05-10T08:00:00Z"),
            contentBytes: Buffer.from("hi-1"),
          },
          {
            sourceDocId: "seed-doc-2",
            sourceRevision: "rev-1",
            sourceRef: "drive:seed-doc-2",
            fetchedAt: new Date("2026-05-10T08:00:00Z"),
            contentBytes: Buffer.from("hi-2"),
          },
        ],
        cursor: "after-seed-token",
      },
      scanResult: { documents: [], nextCursor: "scan-token" },
    });
    const enqueue = makeEnqueue();
    const result = await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue,
    });

    expect(handle.seedCalls.count).toBe(1);
    expect(handle.scanCalls.count).toBe(0);
    expect(result.documentsEnqueued).toBe(2);
    expect(enqueue.jobs.map((j) => j.sourceRef).sort()).toEqual([
      "drive:seed-doc-1",
      "drive:seed-doc-2",
    ]);

    // Cursor persisted from the seed result.
    const after = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    expect(after.rows[0]?.last_scan_cursor).toBe("after-seed-token");
  });
});

// ---------------------------------------------------------------------------
// 2. Subsequent tick routes through scan() (no re-seeding)
// ---------------------------------------------------------------------------

describe("scanner — subsequent tick on seeded binding routes through scan()", () => {
  it("does NOT call seed() once last_scan_cursor is non-null", async () => {
    const f = await freshPipelineDb({});
    // Pre-seed the cursor so the binding looks "already seeded".
    await f.raw.query(
      `UPDATE sources_bindings SET last_scan_cursor = $1 WHERE id = $2`,
      ["already-seeded", f.bindingId],
    );
    const handle = makeStatefulAdapter({
      slug: "drive",
      seedResult: {
        documents: [
          {
            sourceDocId: "should-not-emit",
            sourceRevision: "x",
            sourceRef: "drive:should-not-emit",
            fetchedAt: new Date(),
            contentBytes: Buffer.from("x"),
          },
        ],
        cursor: "fresh-seed-token",
      },
      scanResult: { documents: [], nextCursor: "scan-advance" },
    });
    const enqueue = makeEnqueue();
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue,
    });
    expect(handle.seedCalls.count).toBe(0);
    expect(handle.scanCalls.count).toBe(1);
    // Cursor advanced from scan, not seed.
    const after = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    expect(after.rows[0]?.last_scan_cursor).toBe("scan-advance");
  });
});

// ---------------------------------------------------------------------------
// 3. Adapter without seed falls back to scan() on first tick
// ---------------------------------------------------------------------------

describe("scanner — webhook-only adapter (no seed) falls back to scan()", () => {
  it("calls scan() even when last_scan_cursor is null", async () => {
    const f = await freshPipelineDb({});
    const handle = makeStatefulAdapter({
      slug: "drive", // matches the fixture's default adapter_slug
      // No seedResult → adapter.seed is undefined
      scanResult: { documents: [], nextCursor: null },
    });
    const enqueue = makeEnqueue();
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue,
    });
    expect(handle.seedCalls.count).toBe(0);
    expect(handle.scanCalls.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Two-tick flow — seed first, then scan
// ---------------------------------------------------------------------------

describe("scanner — seed then scan flow (two ticks)", () => {
  it("first tick seeds, second tick scans with the persisted cursor", async () => {
    const f = await freshPipelineDb({});
    const handle = makeStatefulAdapter({
      slug: "drive",
      seedResult: {
        documents: [
          {
            sourceDocId: "doc-seed",
            sourceRevision: "rev-seed",
            sourceRef: "drive:doc-seed",
            fetchedAt: new Date("2026-05-10T08:00:00Z"),
            contentBytes: Buffer.from("seed"),
          },
        ],
        cursor: "post-seed-token",
      },
      scanResult: { documents: [], nextCursor: "post-seed-token" },
    });
    const enqueue = makeEnqueue();

    // Tick 1 → seed
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue,
    });
    expect(handle.seedCalls.count).toBe(1);
    expect(handle.scanCalls.count).toBe(0);
    expect(enqueue.jobs).toHaveLength(1);

    // Tick 2 → scan, zero new docs (because scan returns []),
    // and the cursor stays the same.
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue,
    });
    expect(handle.seedCalls.count).toBe(1);
    expect(handle.scanCalls.count).toBe(1);
    expect(enqueue.jobs).toHaveLength(1); // no new enqueues
  });
});

// ---------------------------------------------------------------------------
// 5. Failed seed — cursor stays null, next tick retries seed
// ---------------------------------------------------------------------------

describe("scanner — failed seed leaves cursor null", () => {
  it("does NOT advance last_scan_cursor when seed() throws", async () => {
    const f = await freshPipelineDb({});
    const adapter: SourceAdapter = {
      slug: "drive",
      async scan() {
        return { documents: [], nextCursor: "advance" };
      },
      async seed() {
        throw new Error("simulated transient seed failure");
      },
    };
    const enqueue = makeEnqueue();
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => adapter },
      enqueue,
    });
    const after = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    expect(after.rows[0]?.last_scan_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Intake dedupe — partial-seed replay is idempotent
// ---------------------------------------------------------------------------

describe("scanner — partial-seed replay dedupes via ingestion_intake UNIQUE", () => {
  it("a re-seed with the same (doc, revision) tuple does NOT duplicate intake rows", async () => {
    const f = await freshPipelineDb({});
    const seedDoc = {
      sourceDocId: "replay-doc",
      sourceRevision: "rev-1",
      sourceRef: "drive:replay-doc",
      fetchedAt: new Date("2026-05-10T08:00:00Z"),
      contentBytes: Buffer.from("first"),
    };
    const adapter: SourceAdapter = {
      slug: "drive",
      async scan() {
        return { documents: [], nextCursor: "x" };
      },
      async seed() {
        return { documents: [seedDoc], cursor: "seed-1" };
      },
    };

    // Tick 1 — seed succeeds, intake row inserted.
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => adapter },
      enqueue: makeEnqueue(),
    });
    let countResult = await f.raw.query<{ c: string }>(
      `SELECT COUNT(*)::text as c FROM ingestion_intake WHERE binding_id = $1`,
      [f.bindingId],
    );
    expect(countResult.rows[0]?.c).toBe("1");

    // Force the cursor back to null (simulating a "transient
    // failure between seed-emit and cursor-persist" scenario).
    await f.raw.query(
      `UPDATE sources_bindings SET last_scan_cursor = NULL WHERE id = $1`,
      [f.bindingId],
    );

    // Tick 2 — seed again with the same doc; intake UNIQUE
    // dedupes, no second row.
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => adapter },
      enqueue: makeEnqueue(),
    });
    countResult = await f.raw.query<{ c: string }>(
      `SELECT COUNT(*)::text as c FROM ingestion_intake WHERE binding_id = $1`,
      [f.bindingId],
    );
    expect(countResult.rows[0]?.c).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// 7. PR-Z2 Copilot triage: scan() nextCursor null must PRESERVE the existing
//    binding cursor, not overwrite it. If we ever overwrote a non-null
//    sentinel (e.g. `asana-seeded:<ISO>`) with null, the next tick would see
//    `last_scan_cursor === null && adapter.seed !== undefined` and re-route
//    to seed() — every 4h tick would re-seed every webhook-driven binding
//    forever.
// ---------------------------------------------------------------------------

describe("scanner — null scan().nextCursor preserves existing cursor (no re-seed lockout)", () => {
  it("a webhook-driven adapter (Asana shape) returning null does NOT clobber the sentinel", async () => {
    const f = await freshPipelineDb({});
    // Pre-seed a non-null sentinel matching the Asana cursor shape.
    const sentinel = "asana-seeded:2026-05-10T08:00:00.000Z";
    await f.raw.query(
      `UPDATE sources_bindings SET last_scan_cursor = $1 WHERE id = $2`,
      [sentinel, f.bindingId],
    );

    const handle = makeStatefulAdapter({
      slug: "drive", // fixture's adapter_slug; the seed-vs-scan
      // dispatch is what's being exercised here, not the
      // adapter identity.
      seedResult: {
        documents: [],
        cursor: sentinel, // adapter has seed defined so we test
        // the seed-already-completed case
      },
      // Critical: scan() returns null nextCursor (the
      // webhook-driven-adapter shape).
      scanResult: { documents: [], nextCursor: null },
    });
    const enqueue = makeEnqueue();
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue,
    });

    // The binding is already seeded (sentinel non-null), so the
    // scanner took the scan() path.
    expect(handle.seedCalls.count).toBe(0);
    expect(handle.scanCalls.count).toBe(1);

    // Cursor STILL the sentinel — null nextCursor from scan()
    // did not clobber.
    const after = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    expect(after.rows[0]?.last_scan_cursor).toBe(sentinel);
  });

  it("does NOT re-route to seed() on the next tick after a null scan() return", async () => {
    const f = await freshPipelineDb({});
    const sentinel = "asana-seeded:2026-05-10T08:00:00.000Z";
    await f.raw.query(
      `UPDATE sources_bindings SET last_scan_cursor = $1 WHERE id = $2`,
      [sentinel, f.bindingId],
    );

    const handle = makeStatefulAdapter({
      slug: "drive",
      seedResult: {
        documents: [
          {
            sourceDocId: "should-never-seed",
            sourceRevision: "x",
            sourceRef: "drive:should-never-seed",
            fetchedAt: new Date(),
            contentBytes: Buffer.from("x"),
          },
        ],
        cursor: "new-sentinel",
      },
      scanResult: { documents: [], nextCursor: null },
    });
    const enqueue = makeEnqueue();

    // Tick 1 — scan(), null cursor, sentinel preserved.
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue,
    });
    // Tick 2 — sentinel still non-null → scan() again, NOT seed().
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue,
    });
    expect(handle.seedCalls.count).toBe(0);
    expect(handle.scanCalls.count).toBe(2);
    expect(enqueue.jobs).toHaveLength(0);
  });

  it("scrubs credential bytes from scan() error logs via safeErrorMessage", async () => {
    const f = await freshPipelineDb({});
    // Capture the logger output so we can assert the scrubbed
    // shape — ConsoleLogger emits JSON lines we can parse.
    const lines: string[] = [];
    const capturedLogger = new ConsoleLogger({
      stream: {
        write(chunk: string): boolean {
          lines.push(chunk);
          return true;
        },
      },
    });
    // Asana PAT pattern: `1/<16+ digits>` — recognised by
    // packages/shared/src/scrub/pat-scrub.ts's ASANA_PAT_RE.
    const leakedPat = "1/1234567890123456";
    const adapter: SourceAdapter = {
      slug: "drive",
      async scan(): Promise<SourceScanResult> {
        throw new Error(`asana-client: auth failed (token=${leakedPat})`);
      },
    };
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: capturedLogger,
      adapterRegistry: { get: () => adapter },
      enqueue: makeEnqueue(),
    });
    const errorLine = lines.find((l) => l.includes("scanner.scan_failed"));
    expect(errorLine).toBeDefined();
    // The literal PAT must not appear; the scrub helper replaces
    // it with `[REDACTED]`.
    expect(errorLine!.includes(leakedPat)).toBe(false);
    expect(errorLine!.includes("[REDACTED]")).toBe(true);
  });

  it("preserves the cursor across a Drive-shape adapter that returns a non-null cursor (no regression)", async () => {
    const f = await freshPipelineDb({});
    await f.raw.query(
      `UPDATE sources_bindings SET last_scan_cursor = $1 WHERE id = $2`,
      ["prev-cursor", f.bindingId],
    );
    // Drive-shape: scan() returns a real next page token. Verify
    // we still advance the cursor when nextCursor IS non-null
    // (the bug was specifically the null branch — make sure we
    // didn't break the happy path).
    const handle = makeStatefulAdapter({
      slug: "drive",
      // No seedResult — webhook-only-style adapter
      scanResult: { documents: [], nextCursor: "drive-page-2" },
    });
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: { get: () => handle.adapter },
      enqueue: makeEnqueue(),
    });
    const after = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    expect(after.rows[0]?.last_scan_cursor).toBe("drive-page-2");
  });
});
