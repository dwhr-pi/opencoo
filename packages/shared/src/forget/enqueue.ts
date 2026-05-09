/**
 * `createForgetJobEnqueuer` — turns the planner output into BullMQ
 * recompile + delete jobs (PR-W1, phase-a appendix #11).
 *
 * The admin-API `POST /api/admin/source-bindings/:id/forget?dryRun=0`
 * route (PR-R7) accepts an opaque
 * `forgetJobEnqueuer: (args) => Promise<void>` callable from the
 * composition root. PR-R7 wired the route's expectation; PR-W1 wires
 * the production composition. This factory is the bridge — it owns
 * the per-page fan-out + the (queue-name, job-name, payload) shape so
 * the route stays narrow and the CLI verb (when it grows a queue
 * producer in v0.2 — see `commands/recompile.ts`) can call the same
 * helper.
 *
 * # Job shapes
 *
 *   Recompile queue (`wiki.recompile`, job name `recompile_page`):
 *     `{ bindingId, domainSlug, pagePath, callerUsername }`
 *
 *   Delete queue (`wiki.delete`, job name `delete_page`):
 *     `{ bindingId, domainSlug, pagePath, callerUsername }`
 *
 * Path format from the planner is `${domainSlug}/${pagePath}` — we
 * split on the first `/` so the worker payload carries `pagePath`
 * without the domain prefix (the worker re-derives the wiki path
 * from the domain). The `domainSlug` field is also threaded so the
 * worker can pin the per-domain LLM policy + delete-cap budget
 * without a second pg lookup.
 *
 * # Why a shared helper
 *
 * Two callers will produce these jobs:
 *   1. The admin-API forget route (this PR).
 *   2. The CLI `opencoo recompile` verb when its v0.2 queue producer
 *      lands. Today the verb only writes `erasure_log` rows; once
 *      the worker exists the verb can call this same helper to
 *      enqueue alongside the audit row.
 *
 * Keeping the (queue-name, job-name, payload) tuple in one place
 * means a future rename or schema bump touches one file, not three.
 *
 * # Worker side
 *
 * v0.1 ships the *enqueue* path only — the worker that consumes the
 * `wiki.recompile` / `wiki.delete` queues lands in a follow-up PR
 * (the brief calls this out as "the route 503s today; W1 closes the
 * 503 by wiring the producer"). Until the worker ships, jobs sit on
 * the BullMQ backlog; the operator sees the queue depth via the
 * standard pipelines view and can `bullmq drain` if a forget needs
 * to be reverted.
 *
 * # No direct wiki writes here
 *
 * This helper enqueues; it does NOT invoke the WikiAdapter. The
 * `no-direct-gitea-write` ESLint boundary keeps the engine boundary
 * clean — the consumer worker (when it lands) goes through
 * `wikiWrite()` like every other delete site, which means the
 * delete-cap reservation that the route already performed flows
 * through the wikiWrite admin-bypass path (caller.kind === 'admin'
 * in wiki-write.ts:96 — the route already reserved against the cap
 * via `deleteCap.reserve(...)` BEFORE enqueuing, so the worker
 * should mark its calls as admin-caller to avoid double-reserving).
 */

/** BullMQ Queue handle, narrowed to the single method this helper
 *  invokes. Same shape as `ScannerEnqueue` in
 *  `engine-ingestion/pipelines/scanner.ts` — kept structural so the
 *  shared package doesn't import from `bullmq` (the `bullmq` import
 *  lives in the composition root which already depends on it). */
export interface ForgetJobQueue {
  add(name: string, data: ForgetJobPayload): Promise<unknown>;
}

/** Payload threaded into every recompile + delete job. Same shape
 *  for both queues — the worker dispatches on the queue name (or its
 *  own job name) rather than a discriminator field. */
export interface ForgetJobPayload {
  readonly bindingId: string;
  readonly domainSlug: string;
  /** Wiki path WITHOUT the leading `${domainSlug}/` prefix. The
   *  planner emits `${domainSlug}/${pagePath}`; this helper strips
   *  the prefix so the worker payload matches the per-domain
   *  WikiAdapter's path expectations. */
  readonly pagePath: string;
  /** Audit cross-reference — same value the route writes into
   *  `admin_audit_log.metadata.caller_username`. */
  readonly callerUsername: string;
}

/** Args the route hands the enqueuer per `ForgetJobEnqueueArgs` in
 *  `engine-self-operating/admin-api/routes/source-bindings.ts`. We
 *  redeclare the shape here (rather than importing across the engine
 *  boundary) so the shared package stays free of engine deps. */
export interface ForgetJobEnqueueArgs {
  readonly bindingId: string;
  readonly domainSlug: string;
  readonly pagesRecompiled: readonly string[];
  readonly pagesDeleted: readonly string[];
  readonly callerUsername: string;
}

export interface CreateForgetJobEnqueuerArgs {
  readonly recompileQueue: ForgetJobQueue;
  readonly deleteQueue: ForgetJobQueue;
}

/** Canonical queue + job names. Centralised so the (yet-to-ship)
 *  consumer worker reads the SAME constants — a rename surfaces as
 *  a TS break at every call site. */
export const WIKI_RECOMPILE_QUEUE_SLUG = "wiki.recompile" as const;
export const WIKI_DELETE_QUEUE_SLUG = "wiki.delete" as const;
export const WIKI_RECOMPILE_JOB_NAME = "recompile_page" as const;
export const WIKI_DELETE_JOB_NAME = "delete_page" as const;

/** Strip the `${domainSlug}/` prefix from a planner-emitted path.
 *  The planner format is `${domainSlug}/${pagePath}` (planner.ts:62
 *  / planner.ts:136). When the path doesn't start with the expected
 *  prefix (defensive — shouldn't happen given the planner's invariant),
 *  return the path verbatim so the worker can surface the mismatch
 *  rather than silently drop a slash. */
function stripDomainPrefix(fullPath: string, domainSlug: string): string {
  const prefix = `${domainSlug}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

/** Build the `forgetJobEnqueuer` callable the admin-API route accepts.
 *
 *  Behavior:
 *    1. For each path in `pagesRecompiled`, enqueue ONE
 *       `recompile_page` job onto `recompileQueue`.
 *    2. For each path in `pagesDeleted`, enqueue ONE `delete_page`
 *       job onto `deleteQueue`.
 *    3. Per-job adds run sequentially (`for await`-shaped) so a
 *       transport failure surfaces with the path that failed, and a
 *       partial enqueue is reproducible (the route already wrote the
 *       audit row before calling — operator can retry idempotently
 *       per the planner's "no-op when no remaining citations"
 *       contract). Sequential is also the right shape against
 *       BullMQ's connection-per-queue model: a parallel `Promise.all`
 *       wouldn't actually parallelise the network round trips and
 *       would obscure the failing job in the rejection.
 *
 *  Throws on the first queue add failure. The route catches and
 *  surfaces 500 `enqueue_failed`; the audit row already exists.
 */
export function createForgetJobEnqueuer(
  args: CreateForgetJobEnqueuerArgs,
): (input: ForgetJobEnqueueArgs) => Promise<void> {
  return async (input) => {
    for (const fullPath of input.pagesRecompiled) {
      const pagePath = stripDomainPrefix(fullPath, input.domainSlug);
      await args.recompileQueue.add(WIKI_RECOMPILE_JOB_NAME, {
        bindingId: input.bindingId,
        domainSlug: input.domainSlug,
        pagePath,
        callerUsername: input.callerUsername,
      });
    }
    for (const fullPath of input.pagesDeleted) {
      const pagePath = stripDomainPrefix(fullPath, input.domainSlug);
      await args.deleteQueue.add(WIKI_DELETE_JOB_NAME, {
        bindingId: input.bindingId,
        domainSlug: input.domainSlug,
        pagePath,
        callerUsername: input.callerUsername,
      });
    }
  };
}
