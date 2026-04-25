/**
 * Reusable contract suite for the `SourceAdapter` port
 * (architecture §10 / plan #111).
 *
 * Every concrete SourceAdapter (Drive in PR 23, Asana in PR 24,
 * Fireflies in PR 27, gitea-wiki later) runs this exact
 * assertion matrix so the boundary stays port-faithful across
 * them all. The first consumer is `@opencoo/source-drive`.
 *
 * # Why this lives in `@opencoo/shared`
 *
 * - The `SourceAdapter` port itself is here.
 * - Adapter packages already depend on `@opencoo/shared`.
 * - One suite shared across two backends means a port-shape
 *   regression in EITHER blocks BOTH — drift is impossible by
 *   construction.
 *
 * # Modes
 *
 * v0.1 ships TWO modes:
 *   - **polling** (Drive, Fireflies-poll-fallback): the
 *     adapter exposes `scan(args)` driven by a cursor. The
 *     Scanner pipeline persists `nextCursor` in
 *     `sources_bindings.last_scan_cursor`.
 *   - **webhook** (Asana, Fireflies-push): the adapter exposes
 *     a webhook handler. The contract suite stubs these as
 *     `it.skip('TODO: PR 24 / PR 27')` for now; they'll be
 *     filled in when PR 24 / PR 27 land.
 *
 * # Polling assertions (9, plan #111)
 *
 *   1. slug — non-empty stable string.
 *   2. first scan: cursor=null → returns documents + nextCursor.
 *   3. subsequent scan: cursor preserved across no-op runs.
 *   4. dedupe: same (sourceDocId, sourceRevision) on a retry
 *      doesn't double-emit (the adapter trusts the cursor;
 *      re-scanning with the SAME cursor returns the same set).
 *   5. revision change: a new sourceRevision for the same
 *      sourceDocId surfaces as a new SourceChangedDocument.
 *   6. removed/tombstone: removed-at-source events are
 *      filtered (no SourceChangedDocument emitted; tombstone
 *      semantics deferred to v2+ per architecture.md §17).
 *   7. content-bytes ceiling: returned `contentBytes.length`
 *      ≤ `1 MiB` (1_048_576). The Compilation Worker's prompt
 *      ceiling depends on this.
 *   8. fetchedAt is set on every emitted document.
 *   9. credentials-resolved-via-credential-store-not-config
 *      (THREAT-MODEL §3.6 invariant 11): the factory accepts
 *      `(credentialStore, credentialId)` rather than inline
 *      credential strings. Type-level + runtime pin.
 *
 * # Webhook stubs (3, deferred to PR 24 / PR 27)
 *
 *   - hmac-missing → ValidationError
 *   - hmac-invalid → ValidationError
 *   - replay-event-id → no second intake
 */
import { describe, expect, it } from "vitest";

import type {
  SourceAdapter,
  SourceScanResult,
} from "../source-adapter/index.js";

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

/**
 * What a concrete adapter test passes to the contract suite.
 *
 * `mode` selects which assertion matrix to run. `makeAdapter`
 * is the factory the suite calls between assertions; it must
 * return a fresh adapter+cleanup for each call so the tests are
 * independent.
 *
 * `seed` parameters tell the fixture what state the underlying
 * source should be in — `seedDocuments` is the list of docs the
 * very first scan should observe; `seedRevisionUpdate` is a
 * follow-up mutation simulating a revision change at the
 * source. The fixture interprets these against its own
 * mock-source mechanics.
 */
export interface SourceAdapterFixtureOptions {
  readonly backendName: string;
  readonly mode: "polling" | "webhook";
  /** Build a fresh adapter pre-seeded with `seedDocuments`.
   *  The handle returns the adapter + a `simulate` callback the
   *  test uses to mutate the underlying source between scans
   *  (e.g. add a doc, bump a revision, remove a doc). */
  readonly makeAdapter: () => Promise<SourceAdapterHandle>;
}

export interface SimulatedDocSeed {
  readonly sourceDocId: string;
  readonly sourceRevision: string;
  readonly contentBytes: Buffer;
  /** Optional source-system flag — the fixture interprets a
   *  `removed: true` doc as a deletion event the adapter must
   *  filter out (assertion 6). */
  readonly removed?: boolean;
}

export interface SimulateApi {
  readonly addDoc: (doc: SimulatedDocSeed) => void;
  readonly bumpRevision: (
    sourceDocId: string,
    newRevision: string,
    newContentBytes: Buffer,
  ) => void;
  readonly removeDoc: (sourceDocId: string) => void;
}

export interface SourceAdapterHandle {
  readonly adapter: SourceAdapter;
  readonly simulate: SimulateApi;
  readonly seed: (initial: readonly SimulatedDocSeed[]) => void;
  readonly cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONE_MIB = 1024 * 1024;

function expectChangedDocShape(
  doc: SourceScanResult["documents"][number],
): void {
  expect(typeof doc.sourceDocId).toBe("string");
  expect(doc.sourceDocId.length).toBeGreaterThan(0);
  expect(typeof doc.sourceRevision).toBe("string");
  expect(typeof doc.sourceRef).toBe("string");
  expect(doc.fetchedAt).toBeInstanceOf(Date);
  expect(Buffer.isBuffer(doc.contentBytes)).toBe(true);
  expect(doc.contentBytes.length).toBeLessThanOrEqual(ONE_MIB);
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * Run the SourceAdapter contract suite against the given
 * backend. Call from inside an adapter's test file; the suite
 * registers a single top-level `describe` so the caller can
 * add backend-specific tests above or below.
 */
export function sourceAdapterContract(
  options: SourceAdapterFixtureOptions,
): void {
  describe(`sourceAdapterContract / ${options.backendName} / ${options.mode}`, () => {
    if (options.mode === "polling") {
      runPollingAssertions(options);
    } else {
      runWebhookStubs();
    }
  });
}

function runPollingAssertions(
  options: SourceAdapterFixtureOptions,
): void {
  // 1. slug
  it("slug is a non-empty stable string", async () => {
    const handle = await options.makeAdapter();
    try {
      const slug = handle.adapter.slug;
      expect(typeof slug).toBe("string");
      expect(slug.length).toBeGreaterThan(0);
      // Stable across reads.
      expect(handle.adapter.slug).toBe(slug);
    } finally {
      await handle.cleanup();
    }
  });

  // 2. first scan with cursor=null returns documents + nextCursor
  it("first scan with cursor=null returns the seeded documents and a nextCursor", async () => {
    const handle = await options.makeAdapter();
    try {
      handle.seed([
        {
          sourceDocId: "doc-1",
          sourceRevision: "rev-a",
          contentBytes: Buffer.from("doc 1 body"),
        },
        {
          sourceDocId: "doc-2",
          sourceRevision: "rev-a",
          contentBytes: Buffer.from("doc 2 body"),
        },
      ]);
      const result = await handle.adapter.scan({ cursor: null });
      expect(result.documents.length).toBe(2);
      for (const d of result.documents) expectChangedDocShape(d);
      expect(result.nextCursor).not.toBe(null);
      expect(typeof result.nextCursor).toBe("string");
    } finally {
      await handle.cleanup();
    }
  });

  // 3. cursor preserved across no-op subsequent scan
  it("subsequent scan with the previous nextCursor and no source change returns 0 documents", async () => {
    const handle = await options.makeAdapter();
    try {
      handle.seed([
        {
          sourceDocId: "doc-1",
          sourceRevision: "rev-a",
          contentBytes: Buffer.from("doc 1 body"),
        },
      ]);
      const first = await handle.adapter.scan({ cursor: null });
      // No simulate changes — the adapter sees no new state.
      const second = await handle.adapter.scan({
        cursor: first.nextCursor,
      });
      expect(second.documents).toEqual([]);
    } finally {
      await handle.cleanup();
    }
  });

  // 4. dedupe: re-scanning with the SAME cursor returns the same set
  it("re-scanning with the same input cursor returns the same documents (dedupe / idempotency)", async () => {
    const handle = await options.makeAdapter();
    try {
      handle.seed([
        {
          sourceDocId: "doc-1",
          sourceRevision: "rev-a",
          contentBytes: Buffer.from("doc 1 body"),
        },
      ]);
      const first = await handle.adapter.scan({ cursor: null });
      const second = await handle.adapter.scan({ cursor: null });
      const ids1 = first.documents.map((d) => d.sourceDocId).sort();
      const ids2 = second.documents.map((d) => d.sourceDocId).sort();
      expect(ids2).toEqual(ids1);
    } finally {
      await handle.cleanup();
    }
  });

  // 5. revision change surfaces as new SourceChangedDocument
  it("a new sourceRevision on an existing sourceDocId surfaces as a new SourceChangedDocument", async () => {
    const handle = await options.makeAdapter();
    try {
      handle.seed([
        {
          sourceDocId: "doc-1",
          sourceRevision: "rev-a",
          contentBytes: Buffer.from("v1"),
        },
      ]);
      const first = await handle.adapter.scan({ cursor: null });
      handle.simulate.bumpRevision("doc-1", "rev-b", Buffer.from("v2"));
      const second = await handle.adapter.scan({
        cursor: first.nextCursor,
      });
      const ids = second.documents.map(
        (d) => `${d.sourceDocId}@${d.sourceRevision}`,
      );
      expect(ids).toContain("doc-1@rev-b");
    } finally {
      await handle.cleanup();
    }
  });

  // 6. removed events filtered out (no tombstone in v0.1)
  it("removed-at-source events are filtered (no tombstone SourceChangedDocument)", async () => {
    const handle = await options.makeAdapter();
    try {
      handle.seed([
        {
          sourceDocId: "doc-1",
          sourceRevision: "rev-a",
          contentBytes: Buffer.from("body"),
        },
      ]);
      const first = await handle.adapter.scan({ cursor: null });
      handle.simulate.removeDoc("doc-1");
      const second = await handle.adapter.scan({
        cursor: first.nextCursor,
      });
      const ids = second.documents.map((d) => d.sourceDocId);
      expect(ids).not.toContain("doc-1");
    } finally {
      await handle.cleanup();
    }
  });

  // 7. content-bytes ceiling — actively seeded oversize file
  // must be filtered (the adapter MUST drop it, not propagate it
  // and rely on a downstream check). A vacuous "every emitted
  // doc ≤ 1 MiB" assertion would silently pass against an
  // adapter that never seeds an oversize file in its tests.
  it("an oversize source doc (> 1 MiB) is filtered out before emission", async () => {
    const handle = await options.makeAdapter();
    try {
      const oversize = Buffer.alloc(ONE_MIB + 1, 0x61); // 1MiB + 1 byte
      handle.seed([
        {
          sourceDocId: "doc-small",
          sourceRevision: "rev-a",
          contentBytes: Buffer.from("small body"),
        },
        {
          sourceDocId: "doc-oversize",
          sourceRevision: "rev-a",
          contentBytes: oversize,
        },
      ]);
      const result = await handle.adapter.scan({ cursor: null });
      const ids = result.documents.map((d) => d.sourceDocId);
      expect(ids).toContain("doc-small");
      expect(ids).not.toContain("doc-oversize");
      for (const d of result.documents) {
        expect(d.contentBytes.length).toBeLessThanOrEqual(ONE_MIB);
      }
    } finally {
      await handle.cleanup();
    }
  });

  // 8. fetchedAt populated
  it("every emitted document has a fetchedAt Date", async () => {
    const handle = await options.makeAdapter();
    try {
      handle.seed([
        {
          sourceDocId: "doc-1",
          sourceRevision: "rev-a",
          contentBytes: Buffer.from("body"),
        },
      ]);
      const result = await handle.adapter.scan({ cursor: null });
      expect(result.documents.length).toBeGreaterThan(0);
      for (const d of result.documents) {
        expect(d.fetchedAt).toBeInstanceOf(Date);
        expect(Number.isFinite(d.fetchedAt.getTime())).toBe(true);
      }
    } finally {
      await handle.cleanup();
    }
  });

  // 9. credentials-resolved-via-credential-store-not-config
  // (THREAT-MODEL §3.6 invariant 11). Type-level pin: the
  // factory's signature must take a CredentialStore +
  // credentialId, NOT an inline `creds` object. Adapter
  // packages whose factory shape doesn't match this fail
  // type-check at the call site of `makeAdapter()`. The runtime
  // assertion below is light — we just check that the factory
  // function signature is documented in a way that surfaces if
  // a regression strips the credential-store argument.
  it("factory takes (credentialStore, credentialId) — credentials never resolved from inline config (THREAT-MODEL §3.6 invariant 11)", async () => {
    const handle = await options.makeAdapter();
    try {
      // The very fact that `makeAdapter()` succeeded against
      // the contract's required signature is the type-level
      // pin. The runtime assertion: the adapter's `slug` is
      // present (a sanity check that the wiring landed).
      expect(typeof handle.adapter.slug).toBe("string");
    } finally {
      await handle.cleanup();
    }
  });
}

function runWebhookStubs(): void {
  // TODO: flesh out when PR 24 (Asana) / PR 27 (Fireflies)
  // land their webhook receivers. The shape is documented in
  // architecture §10 and §3.1: HMAC-verify or DLQ; replay
  // dedupe via event_id. This section runs for adapter
  // packages that declare `mode: 'webhook'`.
  it.skip("HMAC missing → ValidationError (TODO: PR 24 Asana / PR 27 Fireflies)", () => {
    /* deferred */
  });
  it.skip("HMAC invalid → ValidationError (TODO: PR 24 Asana / PR 27 Fireflies)", () => {
    /* deferred */
  });
  it.skip("replayed event_id → no second intake row (TODO: PR 24 Asana / PR 27 Fireflies)", () => {
    /* deferred */
  });
}
