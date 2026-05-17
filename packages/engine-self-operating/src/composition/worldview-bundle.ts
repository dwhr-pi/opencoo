/**
 * Worldview composition bundle — PR-W1 (phase-a appendix #13).
 *
 * Constructs every BullMQ handle the worldview compiler subsystem
 * needs at engine boot:
 *
 *   1. `selfop.worldview.compile` Queue (producer-side handle the
 *      admin-API `recompile-worldview` route + the trigger pipeline
 *      enqueue against).
 *   2. The corresponding Worker (consumer of the queue, runs
 *      `compileDomainWorldview` + `wikiWrite`).
 *   3. The 24h safety-net repeat job — at the configured quiet hour
 *      (default `0 3 * * *` UTC) BullMQ fires a synthetic
 *      `safety-net` recompile per enabled non-disabled domain. The
 *      registration uses `OPENCOO_WORLDVIEW_SAFETY_NET_CRON` when
 *      set (mirrors the Z3 scanner cron pattern).
 *
 * The CLI composition root (`packages/cli/src/provision/...`) calls
 * this once at engine boot and threads the returned `queue` handle
 * into `engine-self-operating.start({ worldviewQueue })` so the
 * admin-API recompile route can enqueue against the SAME backlog
 * the Worker reads.
 *
 * The bundle owns lifecycle of every resource it constructs;
 * `close()` is idempotent and best-effort per resource so a slow /
 * misbehaving handle doesn't block sibling teardown.
 */
import {
  Queue,
  Worker,
  type ConnectionOptions,
} from "bullmq";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import type {
  WikiAdapter,
  WikiAuthor,
  WikiWriteDeps,
} from "@opencoo/shared/wiki-write";

import {
  SAFETY_NET_FANOUT_SENTINEL,
  WORLDVIEW_COMPILE_JOB_NAME,
  WORLDVIEW_COMPILE_QUEUE_SLUG,
  startWorldviewCompileWorker,
  type SafetyNetFanoutDomain,
  type WorldviewCompileJob,
  type WorldviewCompileResult,
} from "../workers/worldview-compiler-worker.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** PR-W1 (phase-a appendix #13) — BullMQ jobId for the safety-net
 *  repeat job. Stable across engine restarts so a re-register lands
 *  on the same entry instead of stacking duplicates. */
export const WORLDVIEW_SAFETY_NET_REPEAT_KEY =
  "selfop.worldview.safety-net" as const;

/** PR-W1 (phase-a appendix #13) — default safety-net cadence: 03:00
 *  UTC daily (architecture.md §9.4 — "Every 24 h at quiet hour").
 *  Overridable via `OPENCOO_WORLDVIEW_SAFETY_NET_CRON`. */
export const WORLDVIEW_SAFETY_NET_CRON_DEFAULT = "0 3 * * *" as const;

export interface ComposeWorldviewBundleArgs {
  readonly db: Db;
  readonly logger: Logger;
  readonly redisConnection: ConnectionOptions;
  readonly router: LlmRouter;
  readonly wikiAdapter: WikiAdapter;
  readonly wikiDeps: WikiWriteDeps;
  readonly author: WikiAuthor;
  /** Operator-overridable cron pattern. When undefined, the
   *  composition uses `WORLDVIEW_SAFETY_NET_CRON_DEFAULT`. */
  readonly safetyNetCronPattern?: string;
  /** Per-engine concurrency cap for the worker. v0.1 default is 1
   *  (worldview compiles are Thinker-tier + per-domain mutex). */
  readonly concurrency?: number;
  /** @internal Test seam — substitute the BullMQ Queue factory. */
  readonly queueFactory?: (
    name: string,
    connection: ConnectionOptions,
  ) => Pick<Queue<WorldviewCompileJob>, "add" | "close">;
  /** @internal Test seam — substitute the cron registration. When
   *  undefined the bundle calls `queue.add(...)` with `repeat`. Tests
   *  inject a stub recorder to bypass BullMQ's Lua-scripted repeat
   *  path (which hangs on ioredis-mock — mirrors `registerScannerCronFn`
   *  in engine-ingestion's production-context). */
  readonly registerWorldviewSafetyNetCronFn?: (args: {
    readonly repeatKey: string;
    readonly pattern: string;
  }) => Promise<void>;
  /** @internal Test seam — substitute the worker constructor. Tests
   *  pass `null` to skip Worker construction entirely (the queue +
   *  cron registration still get exercised). */
  readonly startWorkerFn?: typeof startWorldviewCompileWorker | null;
  /** Per-domain locale resolver consumed by the worker handler.
   *  Production wires a pg-backed lookup over `domains.locale`;
   *  tests pass a static map. */
  readonly resolveLocale?: (
    domainId: string,
  ) => Promise<"en" | "pl" | "auto">;
}

export interface WorldviewBundle {
  /** Producer-side handle. The orchestrator threads this into
   *  `engine-self-operating.start({ worldviewQueue })` so the
   *  admin-API recompile route's `queue.add(...)` lands on the
   *  same backlog the worker reads. */
  readonly queue: {
    add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  };
  /** Consumer-side handle. Held so the orchestrator can drain it on
   *  SIGTERM. `null` when the test seam disabled worker construction. */
  readonly worker: Worker<WorldviewCompileJob, WorldviewCompileResult> | null;
  /** Idempotent teardown — closes the worker and the producer Queue.
   *  Best-effort per handle. */
  close(): Promise<void>;
}

/** Build the per-process worldview compiler bundle. The caller owns
 *  the lifetime of the underlying Redis connection; this factory
 *  opens BullMQ handles on top of it. */
export async function composeWorldviewBundle(
  args: ComposeWorldviewBundleArgs,
): Promise<WorldviewBundle> {
  const queueFactory =
    args.queueFactory ??
    ((name, connection): Pick<Queue<WorldviewCompileJob>, "add" | "close"> =>
      new Queue<WorldviewCompileJob>(name, {
        connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 1000 },
        },
      }));
  const queue = queueFactory(
    WORLDVIEW_COMPILE_QUEUE_SLUG,
    args.redisConnection,
  );

  // 1. Register the 24h safety-net repeat job. BullMQ stores
  //    repeatables keyed by (queue, name, pattern, tz, jobId);
  //    a stable jobId makes re-registration idempotent across
  //    engine restarts.
  const safetyNetPattern =
    args.safetyNetCronPattern ?? WORLDVIEW_SAFETY_NET_CRON_DEFAULT;
  try {
    if (args.registerWorldviewSafetyNetCronFn !== undefined) {
      await args.registerWorldviewSafetyNetCronFn({
        repeatKey: WORLDVIEW_SAFETY_NET_REPEAT_KEY,
        pattern: safetyNetPattern,
      });
    } else {
      // The safety-net cron tick enqueues with a SENTINEL domain
      // payload — the worker recognises `domainId === ''` and fans
      // out to every enabled non-disabled domain on the live db.
      // We can't pre-enumerate domains here at registration time
      // (cron ticks fire weeks later; the domain list may shift).
      await queue.add(
        WORLDVIEW_COMPILE_JOB_NAME,
        {
          domainId: SAFETY_NET_FANOUT_SENTINEL,
          domainSlug: SAFETY_NET_FANOUT_SENTINEL,
          triggerType: "safety-net",
        },
        {
          jobId: WORLDVIEW_SAFETY_NET_REPEAT_KEY,
          repeat: {
            pattern: safetyNetPattern,
            tz: "UTC",
            immediately: false,
          },
          removeOnComplete: 100,
          removeOnFail: 1000,
        },
      );
    }
  } catch (err) {
    // Best-effort: a failed cron registration must not crash boot.
    // The event-driven trigger pipeline + admin-API recompile route
    // still work; only the periodic backstop is missing. Operator
    // sees this in logs.
    args.logger.warn("worldview.safety_net_cron_register_failed", {
      pattern: safetyNetPattern,
      error: safeErrorMessage(err),
    });
  }

  // Per-domain enumerator the worker invokes on safety-net cron
  // ticks (the cron job lands with sentinel ids; the worker fans
  // out to per-domain jobs against THIS queue). Reads the live
  // `domains` table so a domain added after engine boot still
  // receives a recompile.
  const listSafetyNetDomains = async (): Promise<
    ReadonlyArray<SafetyNetFanoutDomain>
  > => {
    const result = (await args.db.execute(sql`
      SELECT id::text AS id, slug
      FROM domains
      WHERE disabled_at IS NULL
        AND worldview_enabled = true
      ORDER BY slug ASC
    `)) as unknown as { rows: Array<{ id: string; slug: string }> };
    return result.rows.map((r) => ({
      domainId: r.id,
      domainSlug: r.slug,
    }));
  };

  // Per-domain enqueue the safety-net fanout uses. Bound to the
  // SAME queue handle so the per-domain jobs land in the same
  // backlog the worker drains.
  const enqueueSafetyNetFanout = async (
    job: WorldviewCompileJob,
  ): Promise<void> => {
    const jobId = `worldview-safety-net-${job.domainId}-${Date.now()}`;
    await queue.add(WORLDVIEW_COMPILE_JOB_NAME, job, {
      jobId,
      removeOnComplete: 100,
      removeOnFail: 1000,
    });
  };

  // 2. Start the consumer worker (test seam: pass `null` to skip).
  //    Explicit-null check, NOT `??` — `??` would coalesce null to
  //    the default and re-introduce the worker we want to skip.
  const startWorker =
    args.startWorkerFn === null
      ? null
      : args.startWorkerFn ?? startWorldviewCompileWorker;
  let worker: Worker<WorldviewCompileJob, WorldviewCompileResult> | null =
    null;
  if (startWorker !== null) {
    const resolveLocale =
      args.resolveLocale ?? buildPgLocaleResolver(args.db);
    worker = startWorker({
      connection: args.redisConnection,
      router: args.router,
      wikiAdapter: args.wikiAdapter,
      wikiDeps: args.wikiDeps,
      author: args.author,
      logger: args.logger,
      db: args.db,
      resolveLocale,
      listSafetyNetDomains,
      enqueueSafetyNetFanout,
      ...(args.concurrency !== undefined
        ? { concurrency: args.concurrency }
        : {}),
    });
  }

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async (): Promise<void> => {
      if (worker !== null) {
        try {
          await worker.close();
        } catch (err) {
          args.logger.warn("worldview.worker_close_failed", {
            error: safeErrorMessage(err),
          });
        }
      }
      if (typeof queue.close === "function") {
        try {
          await queue.close();
        } catch (err) {
          args.logger.warn("worldview.queue_close_failed", {
            error: safeErrorMessage(err),
          });
        }
      }
    })();
    return closing;
  };

  return {
    queue: { add: queue.add.bind(queue) },
    worker,
    close,
  };
}

/** Build a pg-backed `resolveLocale` callable. Production reads
 *  `domains.locale` per dispatch; the result is small + bounded
 *  per domain so an LRU cache is overkill for v0.1. */
function buildPgLocaleResolver(
  db: Db,
): (domainId: string) => Promise<"en" | "pl" | "auto"> {
  return async (domainId: string): Promise<"en" | "pl" | "auto"> => {
    if (domainId === "" || domainId === SAFETY_NET_FANOUT_SENTINEL) {
      return "auto";
    }
    const result = (await db.execute(sql`
      SELECT locale FROM domains WHERE id = ${domainId}::uuid LIMIT 1
    `)) as unknown as { rows: Array<{ locale: string }> };
    const locale = result.rows[0]?.locale;
    if (locale === "en" || locale === "pl" || locale === "auto") {
      return locale;
    }
    return "auto";
  };
}
