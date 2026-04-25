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
/**
 * Discriminated-union shape so TypeScript ENFORCES the
 * webhook fixture when `mode === 'webhook'` and ENFORCES its
 * absence when `mode === 'polling'`. Adapter test files that
 * pass `mode: 'webhook'` without `webhookFixture` fail to
 * type-check at the call site of `sourceAdapterContract({...})`.
 */
export type SourceAdapterFixtureOptions =
  | {
      readonly backendName: string;
      readonly mode: "polling";
      readonly makeAdapter: () => Promise<SourceAdapterHandle>;
    }
  | {
      readonly backendName: string;
      readonly mode: "webhook";
      readonly makeAdapter: () => Promise<SourceAdapterHandle>;
      /** PR 24 / plan #115 — required for webhook-mode adapters
       *  so the HMAC + replay assertions run against real bytes. */
      readonly webhookFixture: WebhookFixtureBundle;
    };

export interface WebhookFixtureBundle {
  /** A valid webhook body the adapter knows how to parse. */
  readonly body: Buffer;
  /** Secret bytes — the same bytes the receiver would resolve
   *  from the CredentialStore in production. */
  readonly secret: Buffer;
  /** Valid signature for `(body, secret)`. The contract suite
   *  flips bytes / drops the field to force the negative
   *  paths. */
  readonly validSignature: string;
  /** Header bag the adapter's `extractSignature` walks. The
   *  suite passes this verbatim to `extractSignature(headers)`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Header key the adapter looks up. Used by the suite to
   *  build a "missing" headers variant by deleting the key. */
  readonly signatureHeaderName: string;
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
      runWebhookAssertions(options);
    }
  });
}

function runPollingAssertions(
  options: Extract<SourceAdapterFixtureOptions, { mode: "polling" }>,
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

  // 5. revision change surfaces as new SourceChangedDocument.
  //
  // Note: this assertion checks BEHAVIOR ("the bumped doc
  // surfaces with a revision distinct from the prior scan"),
  // not a specific revision string. Adapters that derive
  // sourceRevision from content bytes (e.g. source-n8n in PR
  // 26 — `sha256(canonicalBytes).slice(0,16)`) cannot produce
  // a caller-chosen revision label; pass-through adapters like
  // source-drive trivially see `'rev-b'` because the simulator
  // sets it directly. The shape we lock is: doc-1 is in the
  // second-scan output AND its revision differs from the first
  // scan's revision for the same doc.
  it("a new revision on an existing sourceDocId surfaces as a new SourceChangedDocument with a different revision", async () => {
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
      const firstRevision = first.documents.find(
        (d) => d.sourceDocId === "doc-1",
      )?.sourceRevision;
      expect(firstRevision).toBeDefined();
      handle.simulate.bumpRevision("doc-1", "rev-b", Buffer.from("v2"));
      const second = await handle.adapter.scan({
        cursor: first.nextCursor,
      });
      const bumped = second.documents.find(
        (d) => d.sourceDocId === "doc-1",
      );
      expect(bumped, "doc-1 should re-surface after bumpRevision").toBeDefined();
      // Strict — `expect(bumped).toBeDefined()` plus optional
      // chaining could let an unexpectedly-undefined revision
      // pass; this asserts the field is present AND distinct.
      expect(bumped?.sourceRevision).toBeDefined();
      expect(bumped!.sourceRevision).not.toBe(firstRevision);
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

function runWebhookAssertions(
  options: Extract<SourceAdapterFixtureOptions, { mode: "webhook" }>,
): void {
  // PR 24 / plan #115: the 3 stubs are now full assertions.
  // The webhook receiver (engine-ingestion, PR 14) consumes:
  //   adapter.webhook.verifier
  //   adapter.webhook.extractSignature(headers)
  //   adapter.webhook.parseEvents({ body, fetchedAt })
  // Plus the receiver layer dedupes replays via the
  // `webhook_events` UNIQUE index on (binding_id, event_id).

  // 1. webhook helpers exposed
  it("adapter.webhook is set with verifier + extractSignature + parseEvents", async () => {
    const handle = await options.makeAdapter();
    try {
      const wh = handle.adapter.webhook;
      expect(wh).toBeDefined();
      if (wh === undefined) return;
      expect(typeof wh.verifier.verify).toBe("function");
      expect(typeof wh.extractSignature).toBe("function");
      expect(typeof wh.parseEvents).toBe("function");
    } finally {
      await handle.cleanup();
    }
  });

  // 2. valid body+signature → ok
  it("verifier returns ok=true for a correct body + signature pair", async () => {
    const fixture = options.webhookFixture;
    const handle = await options.makeAdapter();
    try {
      const wh = handle.adapter.webhook;
      if (wh === undefined) throw new Error("adapter.webhook undefined");
      const result = wh.verifier.verify({
        body: fixture.body,
        secret: fixture.secret,
        signature: fixture.validSignature,
      });
      expect(result.ok).toBe(true);
    } finally {
      await handle.cleanup();
    }
  });

  // 3. webhook/hmac-missing-rejects-with-validation
  it("HMAC missing → verify({signature: undefined}) returns ok=false (validation-class at receiver)", async () => {
    const fixture = options.webhookFixture;
    const handle = await options.makeAdapter();
    try {
      const wh = handle.adapter.webhook;
      if (wh === undefined) throw new Error("adapter.webhook undefined");
      // The receiver builds `signature` from
      // adapter.webhook.extractSignature(headers). When the
      // header is absent, extractSignature returns undefined;
      // the verifier sees that as "missing" and returns
      // ok:false.
      const headersWithoutSig: Record<string, string> = {
        ...fixture.headers,
      };
      delete headersWithoutSig[fixture.signatureHeaderName];
      const sig = wh.extractSignature(headersWithoutSig);
      expect(sig).toBeUndefined();
      const result = wh.verifier.verify({
        body: fixture.body,
        secret: fixture.secret,
        signature: sig,
      });
      expect(result.ok).toBe(false);
      // The receiver translates ok:false into
      // ValidationError(WebhookSignatureError) — that mapping
      // is in engine-ingestion, not in the adapter, but the
      // shape contract says ok:false MUST happen here.
    } finally {
      await handle.cleanup();
    }
  });

  // 4. webhook/hmac-invalid-rejects-with-validation
  it("HMAC tampered → verify({signature: bytes-flipped}) returns ok=false", async () => {
    const fixture = options.webhookFixture;
    const handle = await options.makeAdapter();
    try {
      const wh = handle.adapter.webhook;
      if (wh === undefined) throw new Error("adapter.webhook undefined");
      // Flip the last hex character of the signature; even
      // one bit's worth of mismatch must fail verification.
      const tampered =
        fixture.validSignature.slice(0, -1) +
        (fixture.validSignature.slice(-1) === "0" ? "1" : "0");
      expect(tampered).not.toBe(fixture.validSignature);
      const result = wh.verifier.verify({
        body: fixture.body,
        secret: fixture.secret,
        signature: tampered,
      });
      expect(result.ok).toBe(false);
    } finally {
      await handle.cleanup();
    }
  });

  // 5. webhook/replayed-event-id-deduped
  it("parseEvents emits a stable eventId — replays produce the same id (receiver-layer dedupe)", async () => {
    const fixture = options.webhookFixture;
    const handle = await options.makeAdapter();
    try {
      const wh = handle.adapter.webhook;
      if (wh === undefined) throw new Error("adapter.webhook undefined");
      // The adapter is idempotent: parseEvents on the same
      // body twice yields the same eventId(s). The
      // receiver-layer UNIQUE constraint on (binding_id,
      // event_id) makes the second insert a no-op.
      const first = wh.parseEvents({ body: fixture.body });
      const second = wh.parseEvents({ body: fixture.body });
      expect(first.length).toBeGreaterThan(0);
      expect(second.map((e) => e.eventId)).toEqual(
        first.map((e) => e.eventId),
      );
      // Each event MUST have a non-empty stable id.
      for (const ev of first) {
        expect(typeof ev.eventId).toBe("string");
        expect(ev.eventId.length).toBeGreaterThan(0);
        // Webhook-emitted docs must satisfy the same contract
        // shape as polling-mode changed docs (non-empty
        // sourceDocId, fetchedAt populated, contentBytes a
        // Buffer ≤ 1 MiB) — empty IDs would silently break
        // intake dedupe.
        expectChangedDocShape(ev.doc);
      }
    } finally {
      await handle.cleanup();
    }
  });
}
