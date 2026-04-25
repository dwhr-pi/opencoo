/**
 * Scanner pipeline (PR 17 / plan #77).
 *
 * For each enabled binding: load the SourceAdapter, scan(cursor),
 * dedupe via ingestion_intake UNIQUE, enqueue scanner.classify
 * jobs, persist new cursor + last_scanned_at.
 */
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import type {
  SourceAdapter,
  SourceScanResult,
} from "@opencoo/shared/source-adapter";

import {
  INLINE_CONTENT_CAP_BYTES,
  SCANNER_CLASSIFY_QUEUE_SLUG,
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

function makeEnqueue(failOnIndex?: number): TestEnqueue {
  const jobs: ScannerClassifyJob[] = [];
  let i = 0;
  const enqueue: TestEnqueue = {
    jobs,
    async add(_name: string, data: ScannerClassifyJob) {
      if (failOnIndex !== undefined && i === failOnIndex) {
        i += 1;
        throw new Error("simulated enqueue failure");
      }
      jobs.push(data);
      i += 1;
      return { id: `job-${i}` };
    },
  };
  return enqueue;
}

function makeRegistry(adapter: SourceAdapter): {
  get(slug: string): SourceAdapter | undefined;
} {
  return {
    get(slug: string): SourceAdapter | undefined {
      return slug === adapter.slug ? adapter : undefined;
    },
  };
}

function makeAdapter(
  slug: string,
  documents: Array<{
    sourceDocId: string;
    sourceRevision: string;
    contentBytes?: Buffer;
  }>,
  nextCursor: string | null = "next-cursor",
): SourceAdapter {
  return {
    slug,
    async scan(): Promise<SourceScanResult> {
      return {
        documents: documents.map((d) => ({
          sourceDocId: d.sourceDocId,
          sourceRevision: d.sourceRevision,
          sourceRef: `${slug}:${d.sourceDocId}`,
          fetchedAt: new Date("2026-04-25T12:00:00Z"),
          contentBytes: d.contentBytes ?? Buffer.from("hello"),
        })),
        nextCursor,
      };
    },
  };
}

describe("SCANNER_CLASSIFY_QUEUE_SLUG — canonical queue name (copilot #19 followup)", () => {
  it("matches the 'ingestion.scanner.classify' name the harness wires the worker to", () => {
    // Same shape as REVIEW_DISPATCH_QUEUE_SLUG: the constant
    // names the FULL queue (multi-dot prefix bypasses
    // buildIngestionQueue, which rejects dotted slugs, and is
    // constructed via new Queue(...) in the composition root).
    // If the constant drifts from the canonical name, the
    // Compilation Worker (PR 30 wiring) listens on the wrong
    // queue and Scanner-emitted jobs sit dead.
    expect(SCANNER_CLASSIFY_QUEUE_SLUG).toBe("ingestion.scanner.classify");
  });
});

describe("runScanner — happy path", () => {
  it("enqueues one classify job per new document and advances the cursor", async () => {
    const f = await freshPipelineDb({});
    const adapter = makeAdapter("drive", [
      { sourceDocId: "doc-1", sourceRevision: "rev-1" },
      { sourceDocId: "doc-2", sourceRevision: "rev-1" },
    ]);
    const enqueue = makeEnqueue();
    const result = await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: makeRegistry(adapter),
      enqueue,
    });
    expect(result.bindingsScanned).toBe(1);
    expect(result.documentsEnqueued).toBe(2);
    expect(enqueue.jobs).toHaveLength(2);
    expect(enqueue.jobs[0]?.sourceRef).toBe("drive:doc-1");
    expect(enqueue.jobs[1]?.sourceRef).toBe("drive:doc-2");

    // cursor + last_scanned_at persisted.
    const after = await f.raw.query<{
      last_scan_cursor: string | null;
      last_scanned_at: string | null;
    }>(
      `SELECT last_scan_cursor, last_scanned_at FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    expect(after.rows[0]?.last_scan_cursor).toBe("next-cursor");
    expect(after.rows[0]?.last_scanned_at).not.toBeNull();
  });
});

describe("runScanner — dedupe via ingestion_intake UNIQUE", () => {
  it("skips a (binding, doc, revision) tuple already in intake", async () => {
    const f = await freshPipelineDb({});
    // Pre-seed intake row.
    await f.raw.query(
      `INSERT INTO ingestion_intake (binding_id, source_doc_id, source_revision, content_hash) VALUES ($1, 'doc-1', 'rev-1', 'hash')`,
      [f.bindingId],
    );
    const adapter = makeAdapter("drive", [
      { sourceDocId: "doc-1", sourceRevision: "rev-1" },
      { sourceDocId: "doc-2", sourceRevision: "rev-1" },
    ]);
    const enqueue = makeEnqueue();
    const result = await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: makeRegistry(adapter),
      enqueue,
    });
    expect(result.documentsEnqueued).toBe(1);
    expect(result.documentsSkipped).toBe(1);
    expect(enqueue.jobs).toHaveLength(1);
    expect(enqueue.jobs[0]?.sourceRef).toBe("drive:doc-2");
  });
});

describe("runScanner — payload size cap", () => {
  it("skips documents larger than INLINE_CONTENT_CAP_BYTES + logs warn", async () => {
    const f = await freshPipelineDb({});
    const oversize = Buffer.alloc(INLINE_CONTENT_CAP_BYTES + 1, "x");
    const adapter = makeAdapter("drive", [
      { sourceDocId: "doc-1", sourceRevision: "rev-1", contentBytes: oversize },
      { sourceDocId: "doc-2", sourceRevision: "rev-1" },
    ]);
    const enqueue = makeEnqueue();
    const result = await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: makeRegistry(adapter),
      enqueue,
    });
    expect(result.documentsEnqueued).toBe(1);
    expect(result.documentsSkipped).toBe(1);
    expect(enqueue.jobs[0]?.sourceRef).toBe("drive:doc-2");
  });
});

describe("runScanner — adapter missing", () => {
  it("logs warn and skips the binding (no enqueue, no cursor advance)", async () => {
    const f = await freshPipelineDb({});
    const adapter = makeAdapter("not-the-slug", []);
    const enqueue = makeEnqueue();
    const result = await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: makeRegistry(adapter),
      enqueue,
    });
    expect(result.documentsEnqueued).toBe(0);
    const after = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    expect(after.rows[0]?.last_scan_cursor).toBeNull();
  });
});

describe("runScanner — at-least-once on enqueue failure", () => {
  it("does NOT advance the cursor when an enqueue fails mid-batch", async () => {
    const f = await freshPipelineDb({});
    const adapter = makeAdapter("drive", [
      { sourceDocId: "doc-1", sourceRevision: "rev-1" },
      { sourceDocId: "doc-2", sourceRevision: "rev-1" },
    ]);
    const enqueue = makeEnqueue(1); // fail on second add
    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: makeRegistry(adapter),
      enqueue,
    });
    const after = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    // Cursor stays null — next run re-scans from the previous
    // (null) cursor; intake UNIQUE dedupes the doc-1 we already
    // enqueued.
    expect(after.rows[0]?.last_scan_cursor).toBeNull();
  });

  it("enqueue failure for binding A does NOT abort processing of binding B (copilot #19)", async () => {
    // Two bindings on the same domain. The enqueue spy fails on
    // binding A's first add. The contract: binding B is still
    // scanned and its cursor advances; binding A's cursor stays
    // null so the next cron run retries it; intake UNIQUE
    // deduplicates the docs A already enqueued.
    const f = await freshPipelineDb({});
    // Add a second binding on the same domain, different adapter slug.
    const bindingB = await f.raw.query<{ id: string }>(
      `INSERT INTO sources_bindings (domain_id, adapter_slug, allowed_paths, created_at)
       VALUES ($1, 'asana', $2, NOW() + INTERVAL '1 second') RETURNING id`,
      [f.domainId, ["strategy/**"]],
    );
    const bindingBId = bindingB.rows[0]!.id;

    // Per-adapter registry — different scans for each slug.
    const adapterA = makeAdapter("drive", [
      { sourceDocId: "doc-A1", sourceRevision: "rev-1" },
    ]);
    const adapterB = makeAdapter("asana", [
      { sourceDocId: "doc-B1", sourceRevision: "rev-1" },
    ]);
    const registry = {
      get(slug: string) {
        if (slug === "drive") return adapterA;
        if (slug === "asana") return adapterB;
        return undefined;
      },
    };

    // Fail on the FIRST enqueue (binding A's only doc).
    const enqueue = makeEnqueue(0);

    await runScanner({
      db: f.db as unknown as Parameters<typeof runScanner>[0]["db"],
      logger: silentLogger(),
      adapterRegistry: registry,
      enqueue,
    });

    // Binding B's doc landed (binding B's enqueue is the SECOND
    // call, which the spy lets through).
    expect(enqueue.jobs).toHaveLength(1);
    expect(enqueue.jobs[0]?.sourceRef).toBe("asana:doc-B1");

    // Binding A's cursor stayed null — at-least-once retry on
    // next cron run.
    const aRow = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [f.bindingId],
    );
    expect(aRow.rows[0]?.last_scan_cursor).toBeNull();

    // Binding B's cursor advanced — its scan completed cleanly.
    const bRow = await f.raw.query<{ last_scan_cursor: string | null }>(
      `SELECT last_scan_cursor FROM sources_bindings WHERE id = $1`,
      [bindingBId],
    );
    expect(bRow.rows[0]?.last_scan_cursor).toBe("next-cursor");
  });
});

void vi;
