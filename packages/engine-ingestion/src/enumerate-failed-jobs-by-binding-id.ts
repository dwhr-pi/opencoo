/**
 * `enumerateFailedJobsByBindingId` — PR-W2 (phase-a appendix #14).
 *
 * Read-only enumerator over the `ingestion.scanner.classify` BullMQ
 * queue's `failed` set. The admin-API `POST /api/admin/source-bindings/:id/retry-failed`
 * route uses this to find the failed jobs whose payload `bindingId`
 * matches the operator's target, then re-enqueues each as a fresh
 * job (letting BullMQ assign a new id).
 *
 * The helper:
 *   1. Asks BullMQ for the failed-set Jobs via `queue.getFailed()`.
 *      BullMQ's getter wraps the underlying `ZRANGE` + `HGETALL`
 *      pattern the scoping doc describes — same semantics, cleaner
 *      callsite than raw Redis commands.
 *   2. Filters by `data.bindingId === bindingId` AND optionally by
 *      `data.intakeId === intakeId` when the caller supplied the
 *      single-job scope (per-row Retry buttons).
 *   3. Skips malformed payloads (missing `data`, non-object data,
 *      wrong-typed `bindingId`) without throwing — the failed set
 *      can contain historical payloads that don't match the current
 *      schema, and the retry surface should never crash on those.
 *
 * The helper is PURE read-side: it does NOT remove failed jobs from
 * the queue (the route's re-enqueue creates fresh jobs; the original
 * failed jobs stay until BullMQ's `removeOnFail` policy reaps them
 * or an operator explicitly drains the failed set).
 */

/** Structural shape of a BullMQ `Job` exposed via `Queue.getFailed()`.
 *  Pinned narrow so tests can stub without instantiating a real Job. */
export interface FailedJobLike {
  readonly id: string | undefined;
  readonly data: unknown;
  readonly failedReason: string;
}

/** Structural shape of a BullMQ `Queue` exposing `getFailed()`.
 *  Real `Queue<ScannerClassifyJob>` from bullmq satisfies this
 *  structurally; tests inject a plain object. */
export interface FailedJobsQueueLike {
  getFailed(start?: number, end?: number): Promise<readonly FailedJobLike[]>;
}

/** A failed job whose payload identifies a re-enqueueable target. */
export interface FailedJobEntry {
  readonly jobId: string;
  /** The classifier job payload (`ScannerClassifyJob` shape — at minimum
   *  `bindingId: string`, plus the rest of the producer's fields). */
  readonly data: {
    readonly bindingId: string;
    readonly intakeId?: string;
    readonly [k: string]: unknown;
  };
  /** The reason BullMQ recorded when the job failed. The route
   *  doesn't surface this directly; it's available for debugging
   *  and for the route to fold into structured logs. */
  readonly failedReason: string;
}

/**
 * Enumerate the failed jobs in the given queue whose payload
 * `bindingId` matches `bindingId` and (when supplied) whose
 * `intakeId` matches `intakeId`.
 *
 * Pure read; no mutations. Safe to call from a request handler.
 */
export async function enumerateFailedJobsByBindingId(
  queue: FailedJobsQueueLike,
  bindingId: string,
  intakeId?: string,
): Promise<readonly FailedJobEntry[]> {
  const jobs = await queue.getFailed();
  const out: FailedJobEntry[] = [];
  for (const job of jobs) {
    // Defensive: BullMQ types declare `id?: string`. We cannot
    // re-enqueue deterministically without an id (the retry path
    // needs to log which jobs were retried), so we skip id-less
    // entries. In practice they should not occur — the failed set
    // is keyed by job id — but defensive code is cheap here.
    if (typeof job.id !== "string" || job.id.length === 0) continue;
    const data = job.data;
    if (data === null || data === undefined) continue;
    if (typeof data !== "object") continue;
    const dataObj = data as { readonly bindingId?: unknown; readonly intakeId?: unknown };
    if (typeof dataObj.bindingId !== "string") continue;
    if (dataObj.bindingId !== bindingId) continue;
    if (intakeId !== undefined) {
      if (typeof dataObj.intakeId !== "string") continue;
      if (dataObj.intakeId !== intakeId) continue;
    }
    out.push({
      jobId: job.id,
      data: dataObj as FailedJobEntry["data"],
      failedReason: job.failedReason,
    });
  }
  return out;
}
