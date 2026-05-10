/**
 * Workers public surface (PR-M1, phase-a appendix #5).
 *
 * Five BullMQ Workers — one per ingestion pipeline — with a
 * single boot helper (`startIngestionWorkers`) the engine wires
 * at boot when `mode: 'workers'` is set. SSE run-event emission
 * lives in `sse-bridge.ts`.
 */
import type { ConnectionOptions, Worker } from "bullmq";

import {
  WIKI_DELETE_QUEUE_SLUG,
  WIKI_RECOMPILE_QUEUE_SLUG,
} from "@opencoo/shared/forget";

import { startScannerWorker, type ScannerWorkerDeps } from "./scanner-worker.js";
import { startCompileWorker, type CompileWorkerDeps } from "./compile-worker.js";
import {
  startReviewDispatchWorker,
  type ReviewDispatchWorkerDeps,
} from "./review-dispatch-worker.js";
import {
  startIndexRebuildWorker,
  type IndexRebuildWorkerDeps,
} from "./index-rebuild-worker.js";
import { startCleanupWorker, type CleanupWorkerDeps } from "./cleanup-worker.js";
import {
  defaultRecompilePageStub,
  startForgetConsumerWorkers,
  type ForgetDeleteDeps,
  type ForgetRecompileDeps,
  type RecompilePageHook,
} from "./forget-consumer.js";
import { attachRunEvents } from "./sse-bridge.js";
import type { WorkerContext } from "./context.js";

export type {
  IngestionRunEvent,
  IngestionRunEventEmitter,
  WorkerContext,
} from "./context.js";

export {
  buildScannerHandler,
  startScannerWorker,
  type ScannerWorkerDeps,
} from "./scanner-worker.js";
export {
  buildCompilationHandler,
  startCompileWorker,
  type CompileWorkerDeps,
} from "./compile-worker.js";
export {
  buildReviewDispatchHandler,
  startReviewDispatchWorker,
  type ReviewDispatchWorkerDeps,
} from "./review-dispatch-worker.js";
export {
  buildIndexRebuildHandler,
  startIndexRebuildWorker,
  type IndexRebuildWorkerDeps,
} from "./index-rebuild-worker.js";
export {
  buildCleanupHandler,
  startCleanupWorker,
  type CleanupWorkerDeps,
} from "./cleanup-worker.js";
export {
  buildForgetDeleteHandler,
  buildForgetRecompileHandler,
  defaultRecompilePageStub,
  startForgetConsumerWorkers,
  type ForgetConsumerWorkers,
  type ForgetDeleteDeps,
  type ForgetRecompileDeps,
  type RecompilePageHook,
  type RemainingCitation,
} from "./forget-consumer.js";

/** Default graceful-shutdown drain window. SIGTERM allows BullMQ
 *  to finish in-flight jobs before forcibly disconnecting Redis. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

export interface StartIngestionWorkersArgs {
  readonly ctx: WorkerContext;
  readonly connection: ConnectionOptions;
  /** Override compile-worker concurrency (defaults to 2). All
   *  other workers run at concurrency 1. */
  readonly compileConcurrency?: number;
  /** When `false`, Workers are constructed but do NOT start the
   *  background pull loop. Tests rely on this so assertions don't
   *  race against concurrent pulls. Defaults to `true` in
   *  production. */
  readonly autorun?: boolean;
  /** PR-W6 (phase-a appendix #11 follow-up #65) — the recompile
   *  hook the forget consumer's `wiki.recompile` worker invokes
   *  per processed job. v0.1 production wires
   *  `defaultRecompilePageStub(ctx.logger)` (audit-only); tests
   *  inject a spy. When undefined `startIngestionWorkers` defaults
   *  to the v0.1 stub. */
  readonly recompilePageHook?: RecompilePageHook;
}

export interface IngestionWorkers {
  readonly scanner: Worker;
  readonly compile: Worker;
  readonly reviewDispatch: Worker;
  readonly indexRebuild: Worker;
  readonly cleanup: Worker;
  /** PR-W6 — drains the `wiki.recompile` queue the route's
   *  `forgetJobEnqueuer` produces into. */
  readonly forgetRecompile: Worker;
  /** PR-W6 — drains the `wiki.delete` queue the route's
   *  `forgetJobEnqueuer` produces into. */
  readonly forgetDelete: Worker;
  /** Drain every worker in parallel. Idempotent — subsequent
   *  calls share the in-flight close. */
  closeAll(timeoutMs?: number): Promise<void>;
}

/** Diagnostic message MISSING_ENQUEUE.add() throws when the
 *  orchestrator forgets to wire `ctx.enqueue`. Exported so tests
 *  can pin the exact message that lands in `scanner.enqueue_failed`
 *  logger entries — drift between the diagnostic and the test
 *  assertion would mean a regression at debug time, not at boot. */
export const MISSING_ENQUEUE_MESSAGE =
  "scanner-worker: ctx.enqueue is undefined — orchestrator did not wire the ingestion.scanner.classify queue handle";

/** Producer-side enqueue fallback. The orchestrator wires the real
 *  `Queue` handle for `ingestion.scanner.classify` via `ctx.enqueue`;
 *  in the test contexts that omit it (empty adapter registry → the
 *  scanner never calls .add) a throwing stub is safer than silently
 *  dropping jobs in production if the orchestrator forgets the wire.
 *
 *  When the scanner DOES dispatch (adapter resolved + document
 *  returned) and `ctx.enqueue` is missing, this stub throws — the
 *  scanner pipeline catches the throw and logs it via
 *  `scanner.enqueue_failed`, surfacing the misconfiguration in the
 *  operator log without taking the whole scan run down. */
export const MISSING_ENQUEUE: ScannerWorkerDeps["enqueue"] = {
  async add() {
    throw new Error(MISSING_ENQUEUE_MESSAGE);
  },
};

/** Spread an optional field only when defined. Avoids the
 *  `exactOptionalPropertyTypes` clash that `{ x: undefined }` triggers. */
function ifDefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Construct + start all five ingestion workers. Returns a typed
 * handle the engine can store and `closeAll` on shutdown.
 *
 * The orchestrator (CLI `serve.ts`) is responsible for SIGTERM
 * → `closeAll` wiring; this function only owns construction.
 */
export function startIngestionWorkers(
  args: StartIngestionWorkersArgs,
): IngestionWorkers {
  const { ctx, connection, autorun } = args;
  const autorunOpt = ifDefined("autorun", autorun);

  const scanner = startScannerWorker({
    db: ctx.db,
    logger: ctx.logger,
    adapterRegistry: ctx.adapterRegistry,
    enqueue: ctx.enqueue ?? MISSING_ENQUEUE,
    connection,
    ...autorunOpt,
  });

  const compile = startCompileWorker({
    db: ctx.db,
    logger: ctx.logger,
    router: ctx.router,
    wikiDeps: ctx.wikiDeps,
    author: ctx.author,
    guardAdapter: ctx.guardAdapter,
    connection,
    ...ifDefined("concurrency", args.compileConcurrency),
    ...autorunOpt,
  } satisfies CompileWorkerDeps & {
    connection: ConnectionOptions;
    concurrency?: number;
    autorun?: boolean;
  });

  const reviewDispatch = startReviewDispatchWorker({
    logger: ctx.logger,
    connection,
    ...autorunOpt,
  } satisfies ReviewDispatchWorkerDeps & {
    connection: ConnectionOptions;
    autorun?: boolean;
  });

  const indexRebuild = startIndexRebuildWorker({
    logger: ctx.logger,
    wikiDeps: ctx.wikiDeps,
    wikiAdapter: ctx.wikiAdapter,
    author: ctx.author,
    connection,
    ...autorunOpt,
  } satisfies IndexRebuildWorkerDeps & {
    connection: ConnectionOptions;
    autorun?: boolean;
  });

  const cleanup = startCleanupWorker({
    db: ctx.db,
    logger: ctx.logger,
    connection,
    ...autorunOpt,
  } satisfies CleanupWorkerDeps & {
    connection: ConnectionOptions;
    autorun?: boolean;
  });

  // PR-W6 (phase-a appendix #11 follow-up #65) — the two forget
  // consumer workers. Drain the `wiki.recompile` + `wiki.delete`
  // queues the admin-API source-binding-forget route enqueues into.
  // Without these, jobs accumulate in Redis with no consumer side.
  const recompileDeps: ForgetRecompileDeps = {
    db: ctx.db,
    logger: ctx.logger,
    recompilePage: args.recompilePageHook ?? defaultRecompilePageStub(ctx.logger),
    // PR-W6 follow-up #2 — the recompile worker may fall through to
    // an inline delete when a concurrent forget races between plan +
    // consume and leaves the page with zero remaining citations
    // (no companion `delete_page` job exists for THIS forget). It
    // uses the same wikiDeps + author the delete handler uses so
    // the wikiWrite shape is identical.
    wikiDeps: ctx.wikiDeps,
    author: ctx.author,
  };
  const deleteDeps: ForgetDeleteDeps = {
    db: ctx.db,
    logger: ctx.logger,
    wikiDeps: ctx.wikiDeps,
    author: ctx.author,
  };
  const forgetWorkers = startForgetConsumerWorkers({
    recompileDeps,
    deleteDeps,
    connection,
    ...autorunOpt,
  });

  // Wire SSE run-event emission on every worker. Listener-based
  // (not inside the handler) so emission survives uncaught throws
  // — same pattern as bindOutputDlq in sse-bus.ts.
  const allWorkers: ReadonlyArray<readonly [Worker, string]> = [
    [scanner, "ingestion.scanner"],
    [compile, "ingestion.scanner.classify"],
    [reviewDispatch, "ingestion.review.dispatch"],
    [indexRebuild, "ingestion.index-rebuild"],
    [cleanup, "ingestion.cleanup"],
    [forgetWorkers.recompile, WIKI_RECOMPILE_QUEUE_SLUG],
    [forgetWorkers.delete, WIKI_DELETE_QUEUE_SLUG],
  ];
  for (const [worker, slug] of allWorkers) {
    attachRunEvents(worker, slug, ctx.sseBus);
  }

  let closing: Promise<void> | undefined;
  return {
    scanner,
    compile,
    reviewDispatch,
    indexRebuild,
    cleanup,
    forgetRecompile: forgetWorkers.recompile,
    forgetDelete: forgetWorkers.delete,
    closeAll(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
      if (closing !== undefined) return closing;
      const closes = allWorkers.map(([worker]) =>
        worker.close().catch((err) => {
          // Best-effort: log + swallow so siblings still close.
          ctx.logger.error("ingestion_workers.close_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
      // Race the parallel-close against a watchdog timer. Capture
      // the timer handle so the success branch can `clearTimeout`
      // it — `setTimeout` returns a REFERENCED timer that holds
      // the event loop alive until it fires or is cleared. BullMQ's
      // `worker.close()` resolves promptly when there are no
      // in-flight jobs, so the typical close path lands here in
      // milliseconds; without `clearTimeout` the watchdog timer
      // would still pin the loop for the full `timeoutMs` after
      // every worker had already closed cleanly.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          ctx.logger.warn("ingestion_workers.close_timeout", {
            timeout_ms: timeoutMs,
          });
          resolve();
        }, timeoutMs);
      });
      closing = Promise.race([
        Promise.all(closes).then(() => {
          if (timer !== undefined) clearTimeout(timer);
        }),
        timeout,
      ]);
      return closing;
    },
  };
}
