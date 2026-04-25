/**
 * Scanner pipeline (architecture §9 pipeline 1, plan #77).
 *
 * Every 4h: for each enabled binding, look up the matching
 * SourceAdapter (by slug), call `adapter.scan({cursor})` with
 * the persisted last_scan_cursor, dedupe each returned document
 * against `ingestion_intake` (UNIQUE(binding_id, source_doc_id,
 * source_revision) means a same-revision repeat is a no-op),
 * enqueue a `scanner.classify` job for each NEW document, and
 * persist the new cursor + last_scanned_at.
 *
 * The classify job payload inlines the document content as a
 * Buffer (1MiB cap; the spotlight stage in the Compilation
 * Worker rejects oversized payloads via SpotlightOverflowError).
 * PR 23+ swaps to a re-fetch pattern when adapters land — at
 * that point payloads carry only sourceRef + intake row id.
 *
 * Enqueue + cursor persist happen in the same loop so that:
 *   - a successful scan + enqueue → cursor advances.
 *   - a failed enqueue mid-loop → cursor for THIS binding is not
 *     advanced; the next 4h-cron run retries from the previous
 *     cursor (at-least-once delivery; the intake UNIQUE
 *     constraint deduplicates).
 *
 * Per-binding sequential; the BullMQ scheduler caps per-domain
 * concurrency at 1 anyway (§16.2). Cross-binding parallelism
 * is a v0.2 concern.
 */

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Logger } from "@opencoo/shared/logger";
import type {
  SourceAdapter,
  SourceChangedDocument,
} from "@opencoo/shared/source-adapter";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
  readonly rowCount?: number;
  readonly affectedRows?: number;
}

/**
 * Canonical full queue name the Compilation Worker subscribes to.
 * Multi-dot prefix bypasses `buildIngestionQueue` (which rejects
 * dotted slugs) and is constructed directly via `new Queue(...)`
 * — same shape as `ingestion.dlq.intake` from PR 14 and
 * `ingestion.review.dispatch` from this PR. Keep byte-for-byte
 * consistent across producer (Scanner), consumer (Compilation
 * Worker), README, and the composition-root wiring (copilot #19
 * followup).
 */
export const SCANNER_CLASSIFY_QUEUE_SLUG =
  "ingestion.scanner.classify" as const;

/** v0.1 inline-payload size cap. Beyond this, classification
 *  would hit SpotlightOverflowError; the Scanner short-circuits
 *  here so we never enqueue a doomed job. */
export const INLINE_CONTENT_CAP_BYTES = 1024 * 1024; // 1 MiB

/**
 * In-memory registry of source adapters keyed by slug — the
 * engine harness populates one at boot from the configured
 * adapter packages. Concrete adapters land in PR 23+; for
 * v0.1 only the in-memory shape is exercised.
 */
export interface SourceAdapterRegistry {
  get(slug: string): SourceAdapter | undefined;
}

/**
 * BullMQ queue surface the Scanner enqueues onto. Kept narrow
 * so tests can stub without instantiating a real Queue. The
 * harness wires the real one via `new Queue(SCANNER_CLASSIFY_QUEUE_SLUG, ...)`
 * — multi-dot prefix bypasses `buildIngestionQueue` since that
 * helper rejects dotted slugs.
 */
export interface ScannerEnqueue {
  add(name: string, data: ScannerClassifyJob): Promise<unknown>;
}

export interface ScannerClassifyJob {
  readonly bindingId: string;
  readonly intakeId: string;
  readonly domainSlug: string;
  readonly sourceRef: string;
  /** Base64-encoded document body (Buffer.toString('base64')).
   *  Limited to INLINE_CONTENT_CAP_BYTES bytes pre-encoding. */
  readonly contentBase64: string;
  readonly fetchedAt: string; // ISO
}

interface BindingRow {
  readonly id: string;
  readonly domainSlug: string;
  readonly adapterSlug: string;
  readonly lastScanCursor: string | null;
}

export interface RunScannerArgs {
  readonly db: Db;
  readonly logger: Logger;
  readonly adapterRegistry: SourceAdapterRegistry;
  readonly enqueue: ScannerEnqueue;
  readonly now?: () => Date;
}

export interface ScannerResult {
  readonly bindingsScanned: number;
  readonly documentsEnqueued: number;
  readonly documentsSkipped: number;
}

export async function runScanner(args: RunScannerArgs): Promise<ScannerResult> {
  const now = (args.now ?? ((): Date => new Date()))();

  const bindingRows = (await args.db.execute(sql`
    SELECT b.id::text AS id,
           d.slug AS domain_slug,
           b.adapter_slug,
           b.last_scan_cursor
    FROM sources_bindings b
    JOIN domains d ON d.id = b.domain_id
    WHERE b.enabled = true
    ORDER BY b.created_at
  `)) as unknown as ExecResult<{
    id: string;
    domain_slug: string;
    adapter_slug: string;
    last_scan_cursor: string | null;
  }>;
  const bindings: BindingRow[] = bindingRows.rows.map((r) => ({
    id: r.id,
    domainSlug: r.domain_slug,
    adapterSlug: r.adapter_slug,
    lastScanCursor: r.last_scan_cursor,
  }));

  let totalEnqueued = 0;
  let totalSkipped = 0;

  for (const binding of bindings) {
    const adapter = args.adapterRegistry.get(binding.adapterSlug);
    if (adapter === undefined) {
      args.logger.warn("scanner.adapter_missing", {
        binding_id: binding.id,
        adapter_slug: binding.adapterSlug,
      });
      continue;
    }
    let scanResult;
    try {
      scanResult = await adapter.scan({
        cursor: binding.lastScanCursor,
        now: now.getTime(),
      });
    } catch (err) {
      args.logger.error("scanner.scan_failed", {
        binding_id: binding.id,
        adapter_slug: binding.adapterSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't advance the cursor — the next cron run retries
      // from the previous cursor.
      continue;
    }

    let enqueuedForBinding = 0;
    let bindingFailed = false;
    for (const doc of scanResult.documents) {
      const contentLen = doc.contentBytes.byteLength;
      if (contentLen > INLINE_CONTENT_CAP_BYTES) {
        totalSkipped += 1;
        args.logger.warn("scanner.payload_too_large", {
          binding_id: binding.id,
          source_doc_id: doc.sourceDocId,
          source_ref: doc.sourceRef,
          bytes: contentLen,
          cap_bytes: INLINE_CONTENT_CAP_BYTES,
        });
        continue;
      }
      const intakeId = await upsertIntake(args.db, binding.id, doc);
      if (intakeId === null) {
        totalSkipped += 1;
        continue; // dedupe — same (binding, doc, revision) already seen
      }
      try {
        await args.enqueue.add("classify", {
          bindingId: binding.id,
          intakeId,
          domainSlug: binding.domainSlug,
          sourceRef: doc.sourceRef,
          contentBase64: doc.contentBytes.toString("base64"),
          fetchedAt: doc.fetchedAt.toISOString(),
        });
        enqueuedForBinding += 1;
      } catch (err) {
        // Skip the rest of THIS binding (cursor not advanced
        // → next cron run retries, intake UNIQUE dedupes the
        // docs we already enqueued). Sibling bindings are
        // unaffected (copilot #19) — a transient Redis hiccup
        // on one binding must not take down the whole scan.
        args.logger.error("scanner.enqueue_failed", {
          binding_id: binding.id,
          intake_id: intakeId,
          error: err instanceof Error ? err.message : String(err),
        });
        bindingFailed = true;
        break;
      }
    }

    totalEnqueued += enqueuedForBinding;

    // If this binding's enqueue failed, skip the cursor advance
    // (at-least-once: next cron run retries from the previous
    // cursor) and move on to the next binding.
    if (bindingFailed) continue;

    // Persist new cursor + last_scanned_at — only after every
    // enqueue for this binding succeeded.
    await args.db.execute(sql`
      UPDATE sources_bindings
      SET last_scan_cursor = ${scanResult.nextCursor},
          last_scanned_at = ${now.toISOString()}
      WHERE id = ${binding.id}::uuid
    `);
  }

  return {
    bindingsScanned: bindings.length,
    documentsEnqueued: totalEnqueued,
    documentsSkipped: totalSkipped,
  };
}

/**
 * Insert into ingestion_intake. Returns the new row's id, or
 * `null` when the (binding_id, source_doc_id, source_revision)
 * UNIQUE constraint already matches an existing row (dedupe).
 */
async function upsertIntake(
  db: Db,
  bindingId: string,
  doc: SourceChangedDocument,
): Promise<string | null> {
  const contentHash = createHash("sha256")
    .update(doc.contentBytes)
    .digest("hex");
  const result = (await db.execute(sql`
    INSERT INTO ingestion_intake (binding_id, source_doc_id, source_revision, content_hash)
    VALUES (${bindingId}::uuid, ${doc.sourceDocId}, ${doc.sourceRevision}, ${contentHash})
    ON CONFLICT (binding_id, source_doc_id, source_revision) DO NOTHING
    RETURNING id::text AS id
  `)) as unknown as ExecResult<{ id: string }>;
  if (result.rows.length === 0) return null;
  return result.rows[0]?.id ?? null;
}
