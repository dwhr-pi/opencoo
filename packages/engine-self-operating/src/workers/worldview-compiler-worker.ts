/**
 * Worldview compiler worker — PR-W1 (phase-a appendix #13).
 *
 * Closes G1: `compileDomainWorldview` had no production caller.
 *
 * Consumes `selfop.worldview.compile` jobs (one per per-domain
 * recompile trigger) and:
 *
 *   1. Lists every page in the domain via the WikiAdapter, filters
 *      out `worldview.md` (the output target).
 *   2. Invokes `compileDomainWorldview` to produce the bounded
 *      synthesis body.
 *   3. Writes `worldview.md` via `wikiWrite()` with the
 *      `[worldview]` tag + `Worldview-Recompile: <triggerType>`
 *      trailer so downstream audit greps can distinguish
 *      event-driven from cron-driven refreshes.
 *
 * Error taxonomy:
 *   - `WorldviewOverflowError` → log + return `{status: 'overflow'}`.
 *     BullMQ treats this as a SUCCESSFUL completion (not a DLQ /
 *     failed-permanent), which is the desired behavior: the LLM
 *     emitted >24KB twice in a row, and a retry will hit the same
 *     bound. Burning attempts on a non-retriable failure mode is
 *     pure cost with no recovery. The operator-visible signal is
 *     the `worldview.compile_overflow` structured log line (which
 *     surfaces in the Activity feed); the completed-with-overflow
 *     status simply lets BullMQ move past the job without retry-
 *     looping.
 *   - Other errors → re-throw so BullMQ retries per the queue's
 *     attempts policy. A transient LLM/transport failure recovers
 *     on the next attempt.
 */
import {
  Worker,
  type ConnectionOptions,
  type Job,
  type WorkerOptions,
} from "bullmq";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { DomainId, DomainSlug } from "@opencoo/shared/db";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import {
  wikiWrite,
  type WikiAdapter,
  type WikiAuthor,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";

import {
  compileDomainWorldview,
  WorldviewOverflowError,
} from "../pipelines/worldview/index.js";
import {
  WORLDVIEW_COMPILE_JOB_NAME,
  WORLDVIEW_COMPILE_QUEUE_SLUG,
} from "../pipelines/worldview/trigger.js";

/** Safety-net fanout sentinel — when a cron-fired job arrives with
 *  this `domainId`/`domainSlug`, the worker handler treats it as a
 *  "compile every enabled domain" instruction. See
 *  `composition/worldview-bundle.ts` for the producer side. */
export const SAFETY_NET_FANOUT_SENTINEL = "" as const;

/** Trigger types per architecture §9.4 (plus `manual` for the
 *  admin-API on-demand recompile endpoint). Pinned as a discriminated
 *  union so the worker can switch on the literal without re-parsing
 *  free-form strings. */
export type WorldviewCompileTriggerType =
  | "trailer-high"
  | "trailer-medium"
  | "safety-net"
  | "manual";

/** BullMQ job payload the worker consumes. The trigger pipeline +
 *  the safety-net cron + the admin-API on-demand endpoint all emit
 *  this shape. */
export interface WorldviewCompileJob {
  readonly domainId: string;
  readonly domainSlug: string;
  readonly triggerType: WorldviewCompileTriggerType;
}

export interface WorldviewCompileResult {
  readonly status: "ok" | "overflow";
  readonly bodyBytes?: number;
  readonly retried?: boolean;
  readonly sha?: string;
  readonly latencyMs: number;
}

export interface SafetyNetFanoutDomain {
  readonly domainId: string;
  readonly domainSlug: string;
}

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface WorldviewCompileHandlerDeps {
  readonly router: LlmRouter;
  readonly wikiAdapter: WikiAdapter;
  readonly wikiDeps: WikiWriteDeps;
  readonly author: WikiAuthor;
  readonly logger: Logger;
  /** Drizzle handle forwarded into `compileDomainWorldview`
   *  for the PR-W1 per-domain prompt-override lookup. The
   *  composition root (`composition/worldview-bundle.ts`)
   *  already passes a `db` handle for the `listSafetyNetDomains`
   *  enumerator — same handle threads through here. */
  readonly db: Db;
  /** Per-domain locale lookup. The trigger payload carries only the
   *  id + slug; the orchestrator passes a resolver that looks up
   *  `domains.locale` (typically a cached map). Falls back to
   *  `'auto'` when the domain isn't resolvable (the LlmRouter
   *  itself defaults to the deployment locale, so this stays
   *  recoverable). */
  readonly resolveLocale: (
    domainId: string,
  ) => Promise<"en" | "pl" | "auto">;
  /** Safety-net fanout — when the cron fires with the
   *  `SAFETY_NET_FANOUT_SENTINEL` sentinel, the handler invokes this
   *  callable to enumerate every domain that should receive a
   *  recompile + then enqueues one per-domain `safety-net` job. The
   *  composition root wires this around `SELECT id, slug FROM
   *  domains WHERE disabled_at IS NULL` (typically). When undefined,
   *  the fanout no-ops (event-driven trigger + admin-API recompile
   *  still work; only the daily safety-net is degraded). */
  readonly listSafetyNetDomains?: () => Promise<
    ReadonlyArray<SafetyNetFanoutDomain>
  >;
  /** Producer-side queue handle used by the fanout to re-enqueue
   *  per-domain safety-net jobs. Same Queue the cron tick landed on. */
  readonly enqueueSafetyNetFanout?: (job: WorldviewCompileJob) => Promise<void>;
  /** Optional clock override for deterministic test timings. */
  readonly clock?: () => Date;
}

/** Construct the pure handler. Tests use this directly with a stub
 *  Job; production wraps it via `startWorldviewCompileWorker`. */
export function buildWorldviewCompileHandler(
  deps: WorldviewCompileHandlerDeps,
): (job: Job<WorldviewCompileJob>) => Promise<WorldviewCompileResult> {
  return async (job) => runWorldviewCompile({ ...deps, job: job.data });
}

export interface RunWorldviewCompileArgs extends WorldviewCompileHandlerDeps {
  readonly job: WorldviewCompileJob;
}

/** Single per-job compile + write. Extracted so tests can call it
 *  without a BullMQ Job wrapper.
 *
 *  Safety-net fanout: when the cron tick arrives with the sentinel
 *  `domainId === ''`, the handler enumerates every enabled domain
 *  (via `listSafetyNetDomains`) and enqueues one per-domain
 *  `safety-net` recompile (via `enqueueSafetyNetFanout`). The cron
 *  job itself returns `{ status: 'ok', latencyMs }` without
 *  compiling — the per-domain jobs are what actually compile. */
export async function runWorldviewCompile(
  args: RunWorldviewCompileArgs,
): Promise<WorldviewCompileResult> {
  const startedAt =
    args.clock !== undefined ? args.clock().getTime() : Date.now();
  const { job } = args;

  // Safety-net fanout — the cron tick lands here with sentinel ids.
  // Enumerate live domains + enqueue per-domain jobs; the recursive
  // jobs DON'T hit this branch because they carry real ids.
  if (
    job.domainId === SAFETY_NET_FANOUT_SENTINEL &&
    job.triggerType === "safety-net"
  ) {
    return runSafetyNetFanout(args, startedAt);
  }

  const domainId = job.domainId as DomainId;
  const domainSlug = job.domainSlug as DomainSlug;

  // 1. List every page in the domain, drop the worldview.md output
  //    target so the compiler doesn't ingest its own prior output.
  const allPages = await args.wikiAdapter.listMarkdown(domainSlug);
  const pagePaths = allPages.filter((p) => p !== "worldview.md");

  const locale = await safeResolveLocale(args.resolveLocale, domainId);

  // 2. Compile via the existing per-domain compiler. Token-cap
  //    overflow surfaces as WorldviewOverflowError — log + DLQ
  //    (return overflow status) rather than re-throw so the worker
  //    doesn't busy-loop on a problem retry won't fix.
  let body: string;
  let bodyBytes: number;
  let retried: boolean;
  try {
    const result = await compileDomainWorldview({
      router: args.router,
      wikiAdapter: args.wikiAdapter,
      db: args.db,
      domainId,
      domainSlug,
      locale,
      pagePaths,
      ...(args.clock !== undefined ? { fetchedAt: args.clock() } : {}),
    });
    body = result.body;
    bodyBytes = result.bodyBytes;
    retried = result.retried;
  } catch (err) {
    if (err instanceof WorldviewOverflowError) {
      args.logger.warn("worldview.compile_overflow", {
        domain_id: job.domainId,
        domain_slug: job.domainSlug,
        trigger_type: job.triggerType,
        attempted_bytes: err.attemptedBytes ?? null,
        cap_bytes: err.capBytes,
      });
      const endedAt =
        args.clock !== undefined ? args.clock().getTime() : Date.now();
      return { status: "overflow", latencyMs: endedAt - startedAt };
    }
    // Transient / unknown — bubble up so BullMQ retries.
    throw err;
  }

  // 3. Commit via wikiWrite. The compiled body is the FILE CONTENT
  //    of `worldview.md` (the `operations[0].content` field). It is
  //    deliberately NOT passed as the wikiWrite `body` field, which
  //    is the commit-message body — putting kilobytes of worldview
  //    prose there would bloat the commit log AND can trip the
  //    `TRAILER_LINE` regex validator (compiled bodies may contain
  //    lines that happen to look like trailers). The commit message
  //    is left short: `[worldview] worldview-compile: <triggerType>`
  //    on the subject line + the `Worldview-Recompile:` trailer
  //    carries the structured trigger metadata for audit greps.
  const writeResult = await wikiWrite(args.wikiDeps, {
    domainSlug,
    tag: "[worldview]",
    description: `worldview-compile: ${job.triggerType}`,
    author: args.author,
    caller: { kind: "engine" },
    operations: [
      {
        mode: "replace",
        path: "worldview.md",
        content: body,
      },
    ],
    worldviewRecompile: job.triggerType,
  });

  const endedAt =
    args.clock !== undefined ? args.clock().getTime() : Date.now();
  const latencyMs = endedAt - startedAt;

  args.logger.info("worldview.compile_completed", {
    domain_id: job.domainId,
    domain_slug: job.domainSlug,
    trigger_type: job.triggerType,
    body_bytes: bodyBytes,
    retried,
    latency_ms: latencyMs,
    sha: writeResult.sha,
  });

  return {
    status: "ok",
    bodyBytes,
    retried,
    sha: writeResult.sha,
    latencyMs,
  };
}

async function runSafetyNetFanout(
  args: RunWorldviewCompileArgs,
  startedAt: number,
): Promise<WorldviewCompileResult> {
  const list = args.listSafetyNetDomains;
  const enqueue = args.enqueueSafetyNetFanout;
  if (list === undefined || enqueue === undefined) {
    // Composition didn't wire the fanout — skip cleanly. The event-
    // driven trigger pipeline + admin-API recompile route still
    // work; only the daily safety-net is degraded.
    args.logger.warn("worldview.safety_net_fanout_skipped", {
      reason: "composition incomplete — no listSafetyNetDomains hook",
    });
    const endedAt =
      args.clock !== undefined ? args.clock().getTime() : Date.now();
    return { status: "ok", latencyMs: endedAt - startedAt };
  }
  let domains: ReadonlyArray<SafetyNetFanoutDomain>;
  try {
    domains = await list();
  } catch (err) {
    args.logger.warn("worldview.safety_net_fanout_list_failed", {
      error: safeErrorMessage(err),
    });
    const endedAt =
      args.clock !== undefined ? args.clock().getTime() : Date.now();
    return { status: "ok", latencyMs: endedAt - startedAt };
  }
  let succeeded = 0;
  for (const d of domains) {
    try {
      await enqueue({
        domainId: d.domainId,
        domainSlug: d.domainSlug,
        triggerType: "safety-net",
      });
      succeeded += 1;
    } catch (err) {
      args.logger.warn("worldview.safety_net_fanout_enqueue_failed", {
        domain_id: d.domainId,
        domain_slug: d.domainSlug,
        error: safeErrorMessage(err),
      });
    }
  }
  const endedAt =
    args.clock !== undefined ? args.clock().getTime() : Date.now();
  args.logger.info("worldview.safety_net_fanout_completed", {
    enumerated_count: domains.length,
    enqueued_count: succeeded,
    latency_ms: endedAt - startedAt,
  });
  return { status: "ok", latencyMs: endedAt - startedAt };
}

async function safeResolveLocale(
  resolveLocale: (id: string) => Promise<"en" | "pl" | "auto">,
  domainId: string,
): Promise<"en" | "pl" | "auto"> {
  try {
    return await resolveLocale(domainId);
  } catch {
    // Locale lookup failures degrade to `auto` rather than blocking
    // the recompile. The LlmRouter applies its own deployment-level
    // default; the worldview compiler doesn't require a specific
    // locale to function.
    return "auto";
  }
}

export interface StartWorldviewCompileWorkerArgs
  extends WorldviewCompileHandlerDeps {
  readonly connection: ConnectionOptions;
  readonly concurrency?: number;
  readonly autorun?: boolean;
}

const DEFAULT_WORLDVIEW_CONCURRENCY = 1;

export function startWorldviewCompileWorker(
  args: StartWorldviewCompileWorkerArgs,
): Worker<WorldviewCompileJob, WorldviewCompileResult> {
  const handler = buildWorldviewCompileHandler(args);
  const workerOpts: WorkerOptions = {
    connection: args.connection,
    concurrency: args.concurrency ?? DEFAULT_WORLDVIEW_CONCURRENCY,
    ...(args.autorun !== undefined ? { autorun: args.autorun } : {}),
  };
  const worker = new Worker<WorldviewCompileJob, WorldviewCompileResult>(
    WORLDVIEW_COMPILE_QUEUE_SLUG,
    handler,
    workerOpts,
  );
  // Best-effort error log so a transport-level failure surfaces in
  // the same channel the admin-API audit log uses for triage.
  worker.on("failed", (job, err) => {
    args.logger.warn("worldview.compile_worker_failed", {
      job_id: job?.id ?? null,
      domain_id: job?.data?.domainId ?? null,
      trigger_type: job?.data?.triggerType ?? null,
      error: safeErrorMessage(err),
    });
  });
  return worker;
}

export { WORLDVIEW_COMPILE_JOB_NAME, WORLDVIEW_COMPILE_QUEUE_SLUG };
