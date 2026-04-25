/**
 * `SourceAdapter` — minimal v0.1 port for source ingestion
 * (architecture §10 SourceAdapter, plan #77 Q3 minimal surface).
 *
 * Concrete adapters (Drive, Asana, Fireflies, n8n, gitea-wiki)
 * land in PR 23+. v0.1 only ships the port shape so the Scanner
 * pipeline + the engine harness can compile against it.
 *
 * The Scanner persists `nextCursor` into
 * `sources_bindings.last_scan_cursor` after a successful scan
 * (migration 0004). The cursor is opaque: the engine does not
 * parse it; the adapter sees what it returned last time.
 *
 * The Compilation Worker inlines `contentBytes` into the
 * BullMQ job payload (1MiB cap; SpotlightOverflowError catches
 * overflow during classification). PR 23+ swaps to a re-fetch
 * pattern when adapters land — at that point `contentBytes`
 * goes away and the worker calls `adapter.fetch(sourceRef)`.
 */

export interface SourceScanArgs {
  /** Cursor persisted from the previous scan, or `null` for a
   *  first run. The adapter chooses the semantics — Drive uses
   *  a change-token, Asana uses a sync cursor, Fireflies uses
   *  a since-timestamp ISO string. */
  readonly cursor: string | null;
  /** Optional clock injection for deterministic tests. Adapters
   *  that don't need a clock ignore this field. */
  readonly now?: number;
}

export interface SourceChangedDocument {
  /** Source-system identifier — opaque text. Combined with
   *  sourceRevision to form the `ingestion_intake` UNIQUE key
   *  (binding_id, source_doc_id, source_revision). */
  readonly sourceDocId: string;
  /** Source-system version of this document — opaque text. A
   *  new sourceRevision means the body changed; same revision
   *  means a no-op (Scanner skips re-classifying). */
  readonly sourceRevision: string;
  /** Human-readable reference for audit logs and citations,
   *  e.g. `drive:1XYZ...`, `asana:task/1234`. */
  readonly sourceRef: string;
  /** When the adapter fetched this document. */
  readonly fetchedAt: Date;
  /** Inline document bytes for the Compilation Worker to
   *  consume. v0.1 inlines into the BullMQ job payload (1MiB
   *  cap); PR 23+ replaces with re-fetch. */
  readonly contentBytes: Buffer;
}

export interface SourceScanResult {
  /** Documents that changed since `cursor`. Empty array means
   *  no work for the Scanner — it persists the new cursor and
   *  exits cleanly. */
  readonly documents: readonly SourceChangedDocument[];
  /** Cursor for the NEXT scan. `null` is legal when the
   *  adapter has no resumable cursor (e.g. a stateless
   *  full-fetch adapter). */
  readonly nextCursor: string | null;
}

export interface SourceAdapter {
  /** Stable identifier matching `sources_bindings.adapter_slug`.
   *  The Scanner pipeline picks the adapter for a binding by
   *  this slug. */
  readonly slug: string;
  /** Discover documents changed since `args.cursor`. Returns
   *  the new cursor for the engine to persist. */
  scan(args: SourceScanArgs): Promise<SourceScanResult>;
}
