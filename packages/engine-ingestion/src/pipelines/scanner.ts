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

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import type { SourceAdapter } from "@opencoo/shared/source-adapter";

import { upsertIntake } from "../intake/upsert-intake.js";

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
    // PR-Z2 — seed-vs-scan dispatch.
    // Bindings with no persisted cursor (= never scanned) get
    // routed to `adapter.seed(...)` instead of `adapter.scan(...)`
    // so existing source content (Drive files, Asana tasks) is
    // backfilled, not invisible until the next mutation. The
    // adapter's seed() returns a cursor that we persist as
    // `last_scan_cursor`, so the NEXT tick goes through scan().
    //
    // Webhook-only adapters that don't implement seed (fireflies,
    // generic webhook, n8n) fall back to scan() even on first
    // tick — that's correct behavior because their "existing
    // content" set is genuinely empty (transcripts / events
    // only exist forward-in-time).
    //
    // A failed seed leaves `last_scan_cursor` null; the next
    // tick re-tries from zero. Partial-seed replay is
    // idempotent via the `ingestion_intake` UNIQUE constraint.
    let scanResult: {
      readonly documents: ReadonlyArray<{
        readonly sourceDocId: string;
        readonly sourceRevision: string;
        readonly sourceRef: string;
        readonly fetchedAt: Date;
        readonly contentBytes: Buffer;
      }>;
      readonly nextCursor: string | null;
    };
    const seedRoute =
      binding.lastScanCursor === null && adapter.seed !== undefined;
    try {
      if (seedRoute) {
        args.logger.info("scanner.seed_started", {
          binding_id: binding.id,
          adapter_slug: binding.adapterSlug,
        });
        const seeded = await adapter.seed!({ now: now.getTime() });
        scanResult = {
          documents: seeded.documents,
          nextCursor: seeded.cursor,
        };
        args.logger.info("scanner.seed_completed", {
          binding_id: binding.id,
          adapter_slug: binding.adapterSlug,
          document_count: seeded.documents.length,
        });
      } else {
        scanResult = await adapter.scan({
          cursor: binding.lastScanCursor,
          now: now.getTime(),
        });
      }
    } catch (err) {
      // Route the error message through `safeErrorMessage` so
      // any credential bytes that bubbled into Error#message
      // (mistyped PAT, malformed signing secret) are scrubbed
      // before they hit the log stream. THREAT-MODEL §3
      // logging-hygiene invariant — every engine-ingestion
      // catch-and-log path uses the same helper.
      args.logger.error(
        seedRoute ? "scanner.seed_failed" : "scanner.scan_failed",
        {
          binding_id: binding.id,
          adapter_slug: binding.adapterSlug,
          error: safeErrorMessage(err),
        },
      );
      // Don't advance the cursor — the next cron run retries
      // from the previous cursor (which is null on a failed
      // seed → next tick re-tries seed from zero).
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
          error: safeErrorMessage(err),
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

    // Cursor-preserve rule (PR-Z2 Copilot triage):
    //   scan() returning `nextCursor === null` means "no cursor
    //   advancement", NOT "reset cursor state". Webhook-driven
    //   adapters (Asana in default modes) deliberately return
    //   `nextCursor: null` from scan() because they have no
    //   resumable cursor in the REST API. If we persisted that
    //   null over a non-null sentinel (e.g. `asana-seeded:<ISO>`),
    //   the next tick would see `last_scan_cursor === null &&
    //   adapter.seed !== undefined` and re-route to seed() —
    //   every 4h tick would then re-seed every webhook-driven
    //   binding forever.
    //
    // Seed-path null is impossible by the SourceSeedResult type
    // (cursor: string, not string | null) — `seedRoute` always
    // produces a non-null cursor and falls through normally.
    const persistedCursor =
      scanResult.nextCursor !== null
        ? scanResult.nextCursor
        : binding.lastScanCursor;

    // Persist new cursor + last_scanned_at — only after every
    // enqueue for this binding succeeded.
    await args.db.execute(sql`
      UPDATE sources_bindings
      SET last_scan_cursor = ${persistedCursor},
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

// Re-export the shared upsert helper under the historical name so any
// existing import path (`@opencoo/engine-ingestion/.../pipelines/scanner`
// or sibling-package consumers via the package barrel) keeps resolving.
// PR-N2 extracted the implementation to `intake/upsert-intake.ts` so the
// webhook receiver's direct-intake branch can call the same code path
// without dragging in the rest of the scanner pipeline module.
export { upsertIntake };
