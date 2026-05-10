/**
 * Forget consumer worker (PR-W6, phase-a appendix #11 follow-up
 * task #65).
 *
 * Drains the two queues PR-W1's `createForgetJobEnqueuer` produces:
 *
 *   - `wiki.recompile` (job name `recompile_page`) — the page
 *     survives the forget but its body must drop the forgotten
 *     binding's contributions. Worker semantics:
 *       1. Read existing `page_citations` for `(domainSlug, pagePath)`.
 *       2. Partition: forgotten (`source_binding_id === bindingId`) vs
 *          remaining.
 *       3. If no remaining citations → race detected. The route's
 *          planner saw OTHER bindings citing this page and queued a
 *          recompile, but a concurrent forget operation drained those
 *          OTHER bindings' citations between plan + consume. The page
 *          is now an orphan with no remaining citations — and the
 *          companion `delete_page` job for THIS forget operation was
 *          NOT queued (the planner snapshot didn't see this page as
 *          a delete candidate). To avoid leaving an orphan wiki page
 *          behind, we DROP the forgotten binding's citation row(s),
 *          then FALL THROUGH to an inline wiki delete via the same
 *          `wikiWrite` path the delete handler uses. If the wiki
 *          page is itself already gone (the other forget operation's
 *          delete fired first), we log + no-op.
 *       4. Otherwise: DELETE the forgotten citations (cascade
 *          hygiene — the page_citations table allows DELETE for the
 *          erasure path per the schema's APPEND-ONLY-modulo-DELETE
 *          comment) and invoke the injected `recompilePage` hook
 *          with the remaining citations.
 *
 *     The actual recompile body (the LLM call that re-derives the
 *     page from the remaining citations) is owned by `recompilePage`
 *     — production wires a v0.1 stub that logs intent only,
 *     mirroring the CLI `recompile.ts` audit-only shape (the engine
 *     re-compiles on its next cron tick / next ingestion event from
 *     a remaining binding). v0.2 will replace the stub with a real
 *     Thinker recompile.
 *
 *   - `wiki.delete` (job name `delete_page`) — the page has no
 *     remaining attribution and must be removed entirely. Worker
 *     semantics:
 *       1. Scope-prune `page_citations` to ONLY the forgotten
 *          binding's row(s) for `(domainSlug, pagePath)`. The
 *          planner's snapshot said only this binding cited the page,
 *          but a concurrent edit could have added a NEW binding's
 *          citation between plan + consume — blindly deleting all
 *          rows would destroy the new binding's contributions.
 *       2. Probe for any remaining `page_citations` rows for the
 *          same page after the scoped prune. If any remain →
 *          another binding now owns the page (race with a concurrent
 *          ingestion or compile); log `delete.race_detected` and
 *          SKIP the wiki delete. The other binding's planner will
 *          handle the page on its own forget; recompile-on-next-tick
 *          will refresh the page body.
 *       3. Otherwise → no surviving citations: issue a `wikiWrite`
 *          with `mode: 'delete'` op. Caller is `{ kind: 'admin',
 *          userId: callerUsername }` — the route ALREADY reserved
 *          against the shared DeleteCap before enqueueing
 *          (source-bindings.ts:933), so `engine` caller would
 *          double-reserve. The W1 enqueue.ts comment block documents
 *          this contract:
 *            "the route already reserved against the cap via
 *             deleteCap.reserve(...) BEFORE enqueuing, so the worker
 *             should mark its calls as admin-caller to avoid
 *             double-reserving".
 *       4. Defensive: if the wiki adapter reports the page is
 *          already gone (readPage returns null), no-op + warn —
 *          another forget could have raced ahead.
 *
 * # Audit
 *
 * The route already wrote `source_binding.forget` with COUNTS at
 * enqueue time. The worker emits a per-job logger entry with
 * `(binding_id, domain_slug, page_path)` and exits — NO additional
 * `admin_audit_log` insert (that would double-count the same
 * operation). Per-job log lines flow into the standard execution log
 * via the SSE bridge.
 *
 * # Failure semantics
 *
 * Throwing from the handler is the BullMQ-canonical way to signal a
 * retryable failure. The producer-side queue defaults
 * (`production-composition.ts` wires `attempts: 5` + exponential
 * backoff starting at 30s) govern retry shape: a transport blip
 * retries, a cap-exceeded throw retries until the daily window
 * resets, and a permanent failure (malformed payload, binding row
 * missing entirely, schema drift) lands in BullMQ's failed set
 * after the attempts cap (the failed set is bounded by
 * `removeOnFail: { count: 1000 }` and acts as the DLQ for operator
 * inspection). We throw bare Error here — the route's audit row is
 * the operator-facing record; BullMQ's job log + the per-job logger
 * entry are the engine-facing record.
 *
 * Forget is safely re-runnable end-to-end: the delete handler's
 * existence probe absorbs a prior partial commit (page already
 * gone → warn + still prune orphan citations), the recompile stub
 * is log-only, and the citations DELETE is idempotent. A retry
 * after a partial success is therefore a no-op + warn, not a
 * double-delete or double-write.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  Worker,
  type ConnectionOptions,
  type Job,
  type WorkerOptions,
} from "bullmq";
import { z } from "zod";

import {
  WIKI_DELETE_JOB_NAME,
  WIKI_DELETE_QUEUE_SLUG,
  WIKI_RECOMPILE_JOB_NAME,
  WIKI_RECOMPILE_QUEUE_SLUG,
  type ForgetJobPayload,
} from "@opencoo/shared/forget";
import type { Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import {
  wikiWrite,
  type WikiAuthor,
  type WikiWriteDeps,
  type WikiWriteInput,
} from "@opencoo/shared/wiki-write";
import type { DomainSlug } from "@opencoo/shared/db";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Slug shape mirrors the admin-api routes' validators (domains.ts
 *  `SLUG_REGEX` + agents-dispatch.ts `SLUG_PATTERN`): lowercase alpha
 *  start, then alphanumerics or hyphens, max 63 chars. Centralised
 *  here as a defensive parse at the consumer boundary so a malformed
 *  payload (operator-scripted off-spec `queue.add`, schema drift)
 *  fails fast with a typed error instead of being passed-through to
 *  the wiki adapter as an `as DomainSlug` cast. */
const DOMAIN_SLUG_REGEX = /^[a-z][a-z0-9-]{0,62}$/;
const FORGET_PAYLOAD_SCHEMA = z.object({
  bindingId: z.string().min(1),
  domainSlug: z.string().regex(DOMAIN_SLUG_REGEX),
  pagePath: z.string().min(1),
  callerUsername: z.string().min(1),
});

/** Parse + brand the payload's `domainSlug` at handler entry. Throws
 *  on a malformed payload so BullMQ marks the job failed; the
 *  producer-side `attempts` cap (5, with exponential backoff) means
 *  malformed-payload jobs land in the failed set after a small retry
 *  burst — that's fine because they're operator-induced and rare. */
function validatedDomainSlug(payload: ForgetJobPayload): DomainSlug {
  const parsed = FORGET_PAYLOAD_SCHEMA.parse(payload);
  return parsed.domainSlug as DomainSlug;
}

/** A surviving citation row the recompile hook receives. Carries
 *  enough to identify the source without leaking the underlying
 *  document content (which the worker doesn't have anyway — refetch
 *  is the recompile hook's responsibility when v0.2 wires real
 *  Thinker recompile). */
export interface RemainingCitation {
  readonly sourceBindingId: string;
  readonly sourceRef: string;
  readonly promptVersion: string | null;
}

/** Hook the recompile worker invokes with the post-drop citations.
 *  v0.1 production wires a stub that logs intent only; v0.2 wires a
 *  real Thinker recompile path that re-derives the page body from
 *  the remaining citations (refetch the source content for each
 *  remaining citation, run mergePage, write atomically).
 *
 *  The hook returning normally signals success. Throwing rolls the
 *  job into BullMQ's retry path. */
export type RecompilePageHook = (args: {
  readonly bindingId: string;
  readonly domainSlug: string;
  readonly pagePath: string;
  readonly callerUsername: string;
  readonly remainingCitations: readonly RemainingCitation[];
}) => Promise<void>;

interface CitationRow {
  readonly source_binding_id: string;
  readonly source_ref: string;
  readonly prompt_version: string | null;
}

export interface ForgetRecompileDeps {
  readonly db: Db;
  readonly logger: Logger;
  /** v0.1 production wires a stub that logs intent + returns; v0.2
   *  swaps in a real Thinker recompile. Tests inject a spy. */
  readonly recompilePage: RecompilePageHook;
  /** Production wikiDeps from the WorkerContext — needed for the
   *  fall-through inline delete when the recompile worker discovers
   *  every remaining binding's citation has been forgotten by a
   *  concurrent forget operation between plan + consume (the page
   *  is now an orphan and there's no companion `delete_page` job
   *  for THIS forget operation that would clean it up). Same shape
   *  as the delete handler's `wikiDeps`. */
  readonly wikiDeps: WikiWriteDeps;
  /** Service-account author stamped on the fall-through delete
   *  commit. Same `WikiAuthor` the orchestrator already wires for
   *  the delete handler — not a separate identity. */
  readonly author: WikiAuthor;
}

export interface ForgetDeleteDeps {
  readonly db: Db;
  readonly logger: Logger;
  /** Production wikiDeps from the WorkerContext. Carries the SHARED
   *  DeleteCap instance the route reserves against — passing this
   *  through ensures any cap-budget reads in the future see the
   *  same source-of-truth. */
  readonly wikiDeps: WikiWriteDeps;
  /** Service-account author stamped on the `[review-applied]`-style
   *  delete commit. Same `WikiAuthor` the orchestrator already wires
   *  for compile / index-rebuild commits — not a separate identity. */
  readonly author: WikiAuthor;
}

/** Build the recompile-job handler. Pure — for unit testing inject
 *  a spy `recompilePage` and exercise the partition + db-delete
 *  branches without standing up BullMQ.
 *
 *  v0.1 contract:
 *    - `domainSlug`, `pagePath`, `bindingId`, `callerUsername` are
 *      forwarded from the producer payload; the worker does not
 *      re-derive them.
 *    - The page-existence check is the citations lookup. A page with
 *      zero recorded citations means the route's planner over-
 *      reported (race or operator concurrency); we warn + no-op,
 *      we do NOT throw (no point retrying — the page truly has no
 *      citations and never will via this binding). */
export function buildForgetRecompileHandler(
  deps: ForgetRecompileDeps,
): (job: Job<ForgetJobPayload>) => Promise<void> {
  return async (job) => {
    const payload = job.data;
    // Validate payload at handler entry — Zod throws on malformed
    // shape and the throw flows into BullMQ's retry path. The
    // recompile path doesn't itself need the branded slug (db reads
    // accept `string`), but parsing here keeps the contract uniform
    // with the delete handler and surfaces operator-scripted off-spec
    // `queue.add` payloads early instead of letting them silently
    // mismatch downstream.
    validatedDomainSlug(payload);
    const ctx = jobLogContext(payload);
    const citations = await readCitations(
      deps.db,
      payload.domainSlug,
      payload.pagePath,
    );

    if (citations.length === 0) {
      // Race: the route's planner saw citations but they're gone now
      // (operator concurrency, prior forget, or a manual db prune).
      // No-op + warn — retrying won't bring them back.
      deps.logger.warn("forget_consumer.recompile.page_missing", ctx);
      return;
    }

    const remaining = citations.filter(
      (c) => c.source_binding_id !== payload.bindingId,
    );
    if (remaining.length === 0) {
      // Race: the route's planner saw OTHER bindings citing this
      // page (otherwise it would have queued a `delete_page` job
      // instead of `recompile_page`), but a concurrent forget
      // operation drained those OTHER bindings' citations between
      // plan + consume. The page is now an orphan with no remaining
      // citations — and the OTHER forget operation queued its
      // delete jobs against ITS planner snapshot, which did NOT
      // include this page. If we no-op here we leave a permanently
      // orphaned wiki page behind. Drop the forgotten binding's
      // citation row(s), then fall through to an inline delete via
      // the same wikiWrite path the delete handler uses.
      deps.logger.warn("forget_consumer.recompile.no_remaining_citations", {
        ...ctx,
        forgotten_count: citations.length,
      });
      await deletePageCitations(
        deps.db,
        payload.domainSlug,
        payload.pagePath,
        { bindingId: payload.bindingId },
      );
      await fallThroughDeleteOrphanPage(deps, payload, ctx);
      return;
    }

    // Drop the forgotten binding's citation rows for THIS page so the
    // post-recompile state matches reality (the page no longer cites
    // this binding's source). DELETE is permitted on `page_citations`
    // for the erasure path per the schema's "APPEND-ONLY ... Source
    // forgetting happens via DELETE" comment.
    await deletePageCitations(deps.db, payload.domainSlug, payload.pagePath, {
      bindingId: payload.bindingId,
    });

    // Invoke the recompile hook. v0.1 wires a stub that logs only;
    // v0.2 will replace it with a real Thinker recompile.
    await deps.recompilePage({
      bindingId: payload.bindingId,
      domainSlug: payload.domainSlug,
      pagePath: payload.pagePath,
      callerUsername: payload.callerUsername,
      remainingCitations: remaining.map((r) => ({
        sourceBindingId: r.source_binding_id,
        sourceRef: r.source_ref,
        promptVersion: r.prompt_version,
      })),
    });

    deps.logger.info("forget_consumer.recompile.completed", {
      ...ctx,
      remaining_count: remaining.length,
    });
  };
}

/** Build the delete-job handler. Pure — for unit testing inject
 *  a stub `wikiDeps` (with the in-memory adapter + cap fixture) and
 *  exercise the cascade-prune + delete branches without standing up
 *  BullMQ. */
export function buildForgetDeleteHandler(
  deps: ForgetDeleteDeps,
): (job: Job<ForgetJobPayload>) => Promise<void> {
  return async (job) => {
    const payload = job.data;
    // Validate + brand the slug at handler entry — replaces the
    // unchecked `as DomainSlug` cast that previously sat at the two
    // adapter call-sites. A malformed payload throws here (Zod parse
    // error) and the throw flows into BullMQ's retry path; the
    // producer-side attempts cap then lands the failed job in the
    // failed set for operator inspection.
    const domainSlug = validatedDomainSlug(payload);
    const ctx = jobLogContext(payload);

    // Defensive existence probe — if the page is already gone (a
    // concurrent forget, a manual delete, a prior retry of THIS
    // job that landed the wiki commit then crashed before the db
    // prune), we still want to clear any orphaned citation rows
    // and exit cleanly. Retrying a delete against a missing page
    // would surface as a confusing wiki transport error.
    const existing = await deps.wikiDeps.adapter.readPage(
      domainSlug,
      payload.pagePath,
    );

    // Scoped prune: drop ONLY the forgotten binding's citation
    // row(s). Previously this DELETEd every citation row for the
    // page unconditionally, which destroyed any concurrent binding's
    // contributions if the citation set had changed between plan +
    // consume (e.g. a fresh ingestion added a new binding's citation
    // after the planner snapshot). The race-detection check below
    // then decides whether the wiki page itself is safe to delete.
    await deletePageCitations(deps.db, payload.domainSlug, payload.pagePath, {
      bindingId: payload.bindingId,
    });

    if (existing === null) {
      deps.logger.warn("forget_consumer.delete.page_already_gone", ctx);
      return;
    }

    // Race check: if any citation row survives the scoped prune,
    // another binding now cites this page (its row was added between
    // plan + consume). Skip the wiki delete — the other binding owns
    // the page; deleting it now would destroy that binding's
    // contributions and leave the new owner pointing at a 404. The
    // other binding's own forget (if/when it runs) will plan a
    // recompile or delete from its own snapshot; the engine's next
    // ingestion tick from the surviving binding will refresh the
    // page body. The cap was reserved at enqueue time and is not
    // refunded — that's an acceptable budget over-charge for the
    // race window (sub-second; the cap is a daily safety budget,
    // not exact accounting).
    const survivors = await readCitations(
      deps.db,
      payload.domainSlug,
      payload.pagePath,
    );
    if (survivors.length > 0) {
      deps.logger.warn("forget_consumer.delete.race_detected", {
        ...ctx,
        surviving_citation_count: survivors.length,
      });
      return;
    }

    // Issue the wiki delete via the standard wikiWrite path.
    //
    // Caller is `{ kind: 'admin', userId: callerUsername }` per the
    // W1 enqueue.ts contract: the admin-API route already reserved
    // the cap budget BEFORE enqueueing this job; an `engine` caller
    // would double-reserve. wikiWrite's per-domain queue still
    // serialises this delete against any concurrent engine writes,
    // and the `[review-applied]` tag matches what the management UI
    // surfaces for operator-triggered actions.
    const writeInput: WikiWriteInput = {
      domainSlug: payload.domainSlug,
      tag: "[review-applied]",
      description: `forget: delete ${payload.pagePath}`,
      author: deps.author,
      caller: { kind: "admin", userId: payload.callerUsername },
      operations: [{ mode: "delete", path: payload.pagePath }],
    };
    try {
      await wikiWrite(deps.wikiDeps, writeInput);
    } catch (err) {
      deps.logger.error("forget_consumer.delete.wiki_write_failed", {
        ...ctx,
        // Round-2 fix #2 style — scrub + cap. THREAT-MODEL §3.6.
        error: safeErrorMessage(err),
      });
      // Re-throw so BullMQ retries (cap-exceeded would surface as a
      // typed WikiWriteCapExceededError; the retry will succeed once
      // the daily window resets).
      throw err;
    }

    deps.logger.info("forget_consumer.delete.completed", ctx);
  };
}

async function readCitations(
  db: Db,
  domainSlug: string,
  pagePath: string,
): Promise<readonly CitationRow[]> {
  const result = (await db.execute(sql`
    SELECT source_binding_id::text AS source_binding_id,
           source_ref               AS source_ref,
           prompt_version           AS prompt_version
    FROM page_citations
    WHERE domain_slug = ${domainSlug}
      AND page_path = ${pagePath}
  `)) as unknown as { rows: CitationRow[] };
  return result.rows;
}

/** DELETE `page_citations` rows for `(domainSlug, pagePath)`. When
 *  `filter.bindingId` is supplied the delete narrows to that binding
 *  (recompile path: drop only the forgotten binding's rows); without
 *  a filter every citation for the page is removed (delete path:
 *  cascade prune for a page that is being removed entirely). DELETE
 *  is permitted on `page_citations` for the erasure path per the
 *  schema's "APPEND-ONLY ... Source forgetting happens via DELETE"
 *  comment. */
async function deletePageCitations(
  db: Db,
  domainSlug: string,
  pagePath: string,
  filter?: { readonly bindingId: string },
): Promise<void> {
  if (filter !== undefined) {
    await db.execute(sql`
      DELETE FROM page_citations
      WHERE domain_slug = ${domainSlug}
        AND page_path = ${pagePath}
        AND source_binding_id = ${filter.bindingId}::uuid
    `);
    return;
  }
  await db.execute(sql`
    DELETE FROM page_citations
    WHERE domain_slug = ${domainSlug}
      AND page_path = ${pagePath}
  `);
}

/** Inline wiki delete for the recompile worker's race-detected
 *  branch (Issue 1 fix-up): the planner queued a recompile because
 *  it saw OTHER bindings citing the page, but a concurrent forget
 *  drained those bindings between plan + consume. The page is now
 *  an orphan and no companion `delete_page` job exists for THIS
 *  forget operation to clean it up. Issues the same admin-caller
 *  wikiWrite the delete handler issues so the cap behaviour is
 *  identical (no double-reserve; route already reserved at enqueue
 *  for THIS forget operation's planned-delete count, but the page
 *  wasn't in that count — the cap may be slightly under-charged
 *  for this single orphan, which is acceptable for a race-window
 *  cleanup). Defensive: if the page is already gone (the OTHER
 *  forget operation's delete fired first), warn + no-op. */
async function fallThroughDeleteOrphanPage(
  deps: ForgetRecompileDeps,
  payload: ForgetJobPayload,
  ctx: ReturnType<typeof jobLogContext>,
): Promise<void> {
  const domainSlug = payload.domainSlug as DomainSlug;
  const existing = await deps.wikiDeps.adapter.readPage(
    domainSlug,
    payload.pagePath,
  );
  if (existing === null) {
    // The other forget operation's delete fired first (or a manual
    // delete / earlier retry of this branch landed). Nothing to do.
    deps.logger.warn("forget_consumer.recompile.fallback_delete_skipped", {
      ...ctx,
      reason: "page_already_gone",
    });
    return;
  }
  const writeInput: WikiWriteInput = {
    domainSlug: payload.domainSlug,
    tag: "[review-applied]",
    description: `forget: delete ${payload.pagePath}`,
    author: deps.author,
    caller: { kind: "admin", userId: payload.callerUsername },
    operations: [{ mode: "delete", path: payload.pagePath }],
  };
  try {
    await wikiWrite(deps.wikiDeps, writeInput);
  } catch (err) {
    deps.logger.error("forget_consumer.recompile.fallback_delete_failed", {
      ...ctx,
      error: safeErrorMessage(err),
    });
    throw err;
  }
  deps.logger.warn("forget_consumer.recompile.fallback_delete_completed", ctx);
}

/** Standard `(binding_id, domain_slug, page_path)` log triple stamped
 *  on every per-job log line. Spread (`...ctx`) when the call site
 *  needs to add additional fields. */
function jobLogContext(payload: ForgetJobPayload): {
  readonly binding_id: string;
  readonly domain_slug: string;
  readonly page_path: string;
} {
  return {
    binding_id: payload.bindingId,
    domain_slug: payload.domainSlug,
    page_path: payload.pagePath,
  };
}

/** Default v0.1 production stub for the recompile hook.
 *
 *  v0.1 ships the FORGET-side cascade (drop forgotten citations) but
 *  DOES NOT yet ship the page-body recompile (re-derive the wiki
 *  page from the remaining citations via a Thinker call). Mirrors
 *  the CLI `recompile.ts` audit-only shape: the operator's intent is
 *  recorded; the engine re-compiles on its next cron tick / next
 *  ingestion event from a remaining binding.
 *
 *  v0.2 will replace this with a real Thinker recompile that
 *  refetches the remaining sources and re-runs `mergePage`. */
export function defaultRecompilePageStub(logger: Logger): RecompilePageHook {
  return async (args) => {
    logger.info("forget_consumer.recompile.audit_only_stub", {
      binding_id: args.bindingId,
      domain_slug: args.domainSlug,
      page_path: args.pagePath,
      remaining_count: args.remainingCitations.length,
      note: "v0.1 audit-only — page body recompile lands in v0.2 (Thinker recompile from remaining citations)",
    });
  };
}

const DEFAULT_FORGET_CONSUMER_CONCURRENCY = 1;

export interface StartForgetConsumerWorkersArgs {
  readonly recompileDeps: ForgetRecompileDeps;
  readonly deleteDeps: ForgetDeleteDeps;
  readonly connection: ConnectionOptions;
  readonly concurrency?: number;
  readonly autorun?: boolean;
}

export interface ForgetConsumerWorkers {
  readonly recompile: Worker<ForgetJobPayload, void>;
  readonly delete: Worker<ForgetJobPayload, void>;
}

/** Wrap a handler so the worker fails loud if BullMQ delivers a job
 *  whose `name` does not match the queue's pinned producer-side
 *  constant. Defensive: the producer in `enqueue.ts` always pins the
 *  expected name, but a malformed job (operator scripted an off-spec
 *  `queue.add`) should throw rather than silently no-op. */
function withJobNameGuard<T>(
  queueSlug: string,
  expectedName: string,
  handler: (job: Job<T>) => Promise<void>,
): (job: Job<T>) => Promise<void> {
  return async (job) => {
    if (job.name !== expectedName) {
      throw new Error(
        `forget-consumer: ${queueSlug} expected job name ${expectedName}, got ${job.name}`,
      );
    }
    return handler(job);
  };
}

/** Construct + return the two BullMQ Worker instances for the
 *  forget queues. The queue slugs (`wiki.recompile`, `wiki.delete`)
 *  are multi-dot so we bypass `buildEngineWorker` (which rejects
 *  dotted slugs) and use `new Worker(...)` directly — same pattern
 *  `compile-worker.ts` uses for `ingestion.scanner.classify`.
 *
 *  Concurrency defaults to 1: the recompile path issues a Thinker
 *  call (LLM-bound) and the delete path serialises through wikiWrite
 *  per-domain anyway. v0.2 may lift the cap if these become a
 *  bottleneck. */
export function startForgetConsumerWorkers(
  args: StartForgetConsumerWorkersArgs,
): ForgetConsumerWorkers {
  const baseOpts: WorkerOptions = {
    connection: args.connection,
    concurrency: args.concurrency ?? DEFAULT_FORGET_CONSUMER_CONCURRENCY,
    ...(args.autorun !== undefined ? { autorun: args.autorun } : {}),
  };
  const recompile = new Worker<ForgetJobPayload, void>(
    WIKI_RECOMPILE_QUEUE_SLUG,
    withJobNameGuard(
      WIKI_RECOMPILE_QUEUE_SLUG,
      WIKI_RECOMPILE_JOB_NAME,
      buildForgetRecompileHandler(args.recompileDeps),
    ),
    baseOpts,
  );
  const del = new Worker<ForgetJobPayload, void>(
    WIKI_DELETE_QUEUE_SLUG,
    withJobNameGuard(
      WIKI_DELETE_QUEUE_SLUG,
      WIKI_DELETE_JOB_NAME,
      buildForgetDeleteHandler(args.deleteDeps),
    ),
    baseOpts,
  );
  return { recompile, delete: del };
}
