/**
 * `@opencoo/shared/source-adapter` — minimal port the Scanner
 * pipeline (PR 17) consumes. Concrete adapters (Drive, Asana,
 * Fireflies) live in `packages/adapters/source-*` and arrive in
 * PR 23+.
 *
 * v0.1 surface is intentionally narrow: slug + scan(). The scan
 * returns a stream-shaped result: a list of changed documents
 * since the previous cursor, plus the new cursor to persist.
 * Re-fetch / fetch-by-id happens in PR 23+ when the
 * Compilation Worker stops inlining content into job payloads.
 */
import { describe, expect, it } from "vitest";

import {
  type SourceAdapter,
  type SourceScanArgs,
  type SourceScanResult,
  type SourceChangedDocument,
} from "../src/source-adapter/index.js";

describe("SourceAdapter — port shape (plan #77)", () => {
  it("type structurally satisfies a minimal slug + scan implementation", () => {
    // The body of this test is the type-check itself: if the
    // imported types compose into a working stub, the port shape
    // is what the Scanner pipeline expects. Asserts nothing
    // beyond "the implementation compiles".
    const adapter: SourceAdapter = {
      slug: "test-source",
      async scan(args: SourceScanArgs): Promise<SourceScanResult> {
        return {
          documents: [
            {
              sourceDocId: "doc-1",
              sourceRevision: "rev-1",
              sourceRef: "test:doc-1",
              fetchedAt: new Date(args.now ?? Date.now()),
              contentBytes: Buffer.from("hi"),
            },
          ],
          nextCursor: "cursor-1",
        };
      },
    };
    expect(adapter.slug).toBe("test-source");
  });

  it("a scan with no new documents returns an empty array + a cursor", async () => {
    const adapter: SourceAdapter = {
      slug: "test-source",
      async scan(): Promise<SourceScanResult> {
        return { documents: [], nextCursor: "no-changes" };
      },
    };
    const result = await adapter.scan({ cursor: null });
    expect(result.documents).toEqual([]);
    expect(result.nextCursor).toBe("no-changes");
  });

  it("nextCursor: null is allowed — adapter has no resumable cursor", async () => {
    const adapter: SourceAdapter = {
      slug: "test-source",
      async scan(): Promise<SourceScanResult> {
        return { documents: [], nextCursor: null };
      },
    };
    const result = await adapter.scan({ cursor: null });
    expect(result.nextCursor).toBeNull();
  });

  it("SourceChangedDocument carries the four fields the Scanner persists", () => {
    const doc: SourceChangedDocument = {
      sourceDocId: "doc-1",
      sourceRevision: "rev-1",
      sourceRef: "drive:doc-1",
      fetchedAt: new Date(0),
      contentBytes: Buffer.from("body"),
    };
    expect(doc.sourceDocId).toBe("doc-1");
    expect(doc.sourceRevision).toBe("rev-1");
    expect(doc.sourceRef).toBe("drive:doc-1");
    expect(doc.fetchedAt).toBeInstanceOf(Date);
    expect(doc.contentBytes).toBeInstanceOf(Buffer);
  });
});
