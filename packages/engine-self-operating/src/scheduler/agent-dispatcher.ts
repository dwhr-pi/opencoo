/**
 * `AgentDispatcher` — production scheduler for self-op agents
 * (PR-M2, phase-a appendix #5).
 *
 * Responsibilities:
 *   1. On `start()`: read every `agent_instances` row where
 *      `enabled = true AND schedule_cron IS NOT NULL`, validate
 *      each row's cron pattern via `validateCron`, and register a
 *      BullMQ recurring job `selfop.dispatch` per VALID row with
 *      `repeat: { pattern: row.scheduleCron, immediately: false }`
 *      and payload `{ instanceId }`. Rows with invalid patterns
 *      log `scheduler.invalid_cron` and are SKIPPED — the rest
 *      still register cleanly so a single garbage row does not
 *      take the whole scheduler down.
 *
 *   2. Construct a single `selfop.dispatch` Worker whose handler
 *      resolves `{ instanceId }` → loads the agent instance via
 *      `loadInstanceById` → resolves the matching runner from the
 *      injected `AgentRunnerRegistry` → calls `invokeAgent` with
 *      the runner as `args.run`. Errors thrown from the runner
 *      bubble through the harness's terminalisation (which records
 *      a `failed` agent_runs row); the BullMQ handler does NOT
 *      re-throw on harness-recorded failure — the run row IS the
 *      DLQ surface.
 *
 *   3. On `stop()`: pause the worker, then close the worker + the
 *      queue. Idempotent — a second invocation is a no-op.
 *
 * The dispatcher is constructed by the engine boot path (see
 * `start.ts`); the orchestrator wires the same pg pool, Redis
 * connection, and SSE bus the rest of the engine uses.
 *
 * Why a runner registry instead of dispatching agents directly:
 *   `invokeAgent({ run: ... })` requires per-agent runtime deps
 *   (mcp tool client, llm router, db, domain slug) that the
 *   dispatcher cannot synthesise on its own. The orchestrator
 *   knows which agents are wireable in this deployment and
 *   constructs an `AgentRunnerRegistry` mapping each schedulable
 *   `definition_slug` → `(ctx) => Promise<unknown>`. If a
 *   schedulable instance references a slug NOT in the registry,
 *   the dispatcher logs and the BullMQ handler throws — the
 *   harness records a `failed` run for visibility.
 */
import {
  Queue,
  Worker,
  type ConnectionOptions,
  type Job,
} from "bullmq";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { Logger } from "@opencoo/shared/logger";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import { safeErrorMessage } from "@opencoo/shared/scrub";

import type { SseBus } from "../admin-api/sse-bus.js";
import {
  invokeAgent,
  loadInstanceById,
  type AgentDefinitionRegistry,
  type AgentRunContext,
} from "../agent-harness/index.js";
import type {
  OutputChannelBinding,
  OutputChannelRegistry,
} from "../output-channels/index.js";

import { validateCron } from "./cron-validate.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Queue + Worker name. Single-dot prefix per the BullMQ slug
 *  convention (architecture.md §6.5). */
export const DISPATCH_QUEUE_NAME = "selfop.dispatch" as const;

/** Per-agent runtime body. The orchestrator wires one of these per
 *  schedulable `definition_slug`. */
export type AgentRunner = (ctx: AgentRunContext) => Promise<unknown>;

/** Registry of agent runners keyed by `definition_slug`. The
 *  composition root populates this at boot — see
 *  `start.ts:productionDispatcher()`. */
export interface AgentRunnerRegistry {
  get(definitionSlug: string): AgentRunner | undefined;
}

/** Payload of every `selfop.dispatch` job.
 *
 *  PR-R3 (phase-a appendix #10) — `dryRun` is set by the on-demand
 *  dispatch path (`POST /api/admin/agents/:slug/dispatch`) so the
 *  agent body can suppress side effects (e.g. wiki writes,
 *  output-channel deliveries) when the operator wants a sanity
 *  re-run without altering downstream state. Scheduled dispatches
 *  always omit it (treated as `dryRun: false`). */
export interface DispatchJobData {
  readonly instanceId: string;
  readonly dryRun?: boolean;
  /** PR-R3 — populated by the on-demand dispatch path. The audit
   *  trail records who triggered the run; the harness propagates
   *  the flag into `agent_runs.inputs` for downstream visibility. */
  readonly triggeredBy?: "manual" | "scheduled";
}

/** Registered recurring job — stored in-memory by the dispatcher
 *  so the read-only `/api/admin/scheduler` route can list active
 *  schedules without paying a Redis round-trip per request, and
 *  so the dispatcher tests have a deterministic surface to assert
 *  on (BullMQ's `getRepeatableJobs()` against `ioredis-mock`
 *  hangs on the Lua-scripted repeat path). */
export interface RegisteredSchedule {
  readonly instanceId: string;
  readonly definitionSlug: string;
  readonly name: string;
  readonly scheduleCron: string;
}

interface ExecResult<R> {
  readonly rows: R[];
}

export interface AgentDispatcherOptions {
  readonly db: Db;
  readonly connection: ConnectionOptions;
  readonly definitions: AgentDefinitionRegistry;
  readonly runners: AgentRunnerRegistry;
  readonly logger: Logger;
  /** LlmRouter handed to the agent harness on each dispatch.
   *  Runners that don't make LLM calls ignore `ctx.router`; runners
   *  that do (Heartbeat, Lint, Surfacer) pull it from the
   *  AgentRunContext. Optional in test contexts where no runner
   *  invokes the LLM. */
  readonly router?: LlmRouter;
  /** Optional SSE bus passed through to the agent harness so the
   *  Activity feed reflects scheduled runs as they unfold. */
  readonly sseBus?: SseBus;
  /** PR-Z4 (phase-a appendix #12 G5) — output-channel registry.
   *  When present, `dispatchOne` invokes the post-run delivery hook
   *  after the harness returns `status: 'success'`. For each
   *  `agent_instances.output_channel_ids[]` binding, the registry's
   *  `deliver(...)` is called with the agent's JSON output as
   *  payload. Q10 binding enforcement happens INSIDE
   *  `OutputChannelRegistry.deliver` — the dispatcher just iterates
   *  the bindings; the registry rejects deliveries to slugs not in
   *  the binding set.
   *
   *  Per-delivery failures are logged + emitted to SSE but do NOT
   *  fail the run — the agent_runs row stays `success` because the
   *  agent body completed. A separate `output_channel.deliver`
   *  structured log line carries the per-channel outcome.
   *
   *  When undefined (boot-tolerance, e.g. no OutputAdapter packages
   *  available), the post-run hook is a no-op — the agent still
   *  runs to completion. */
  readonly outputChannels?: OutputChannelRegistry;
  /** When `false`, the BullMQ Worker is constructed but does NOT
   *  start the background pull loop. Tests use `false` so the
   *  dispatch handler can be invoked directly. Defaults to
   *  `true`. */
  readonly autorun?: boolean;
  /** @internal Test seam — overrides the BullMQ `Queue.add(...)` call
   *  used to register a recurring job. Tests inject a stub that
   *  records calls in-memory so assertions don't depend on
   *  ioredis-mock's incomplete Lua-script support for repeatables.
   *  Production passes `undefined`; the dispatcher uses the real
   *  Queue handle. */
  readonly registerScheduleFn?: (
    schedule: RegisteredSchedule,
  ) => Promise<void>;
  /** @internal Test seam — overrides the BullMQ
   *  `Queue.removeRepeatable(...)` call used by `updateSchedule`.
   *  Tests inject a stub so assertions don't depend on the
   *  ioredis-mock repeatable surface; production passes `undefined`
   *  and the dispatcher uses the real Queue handle. */
  readonly removeScheduleFn?: (entry: RegisteredSchedule) => Promise<void>;
  /** PR-Z6 (phase-a appendix #12) — how often the dispatcher
   *  re-enumerates `agent_instances` after the initial `start()`
   *  enumeration. Production defaults to 60_000ms (every 60s) so a
   *  freshly-seeded instance (via `opencoo agents seed`) becomes a
   *  live schedule within a minute without needing
   *  `docker compose restart opencoo`. The cost of one tick is a
   *  single `SELECT id, definition_slug, name, schedule_cron FROM
   *  agent_instances WHERE enabled=true AND schedule_cron IS NOT
   *  NULL` plus a diff against the in-memory `registered` list —
   *  cheap by design.
   *
   *  Tests pass `0` to disable the interval and drive `refresh()`
   *  manually so the assertion window is deterministic. The interval
   *  is armed only when this value is `> 0` AND not `Infinity` —
   *  passing `Infinity` is treated as "disabled" so production code
   *  can still opt out symmetrically with the test path. */
  readonly refreshIntervalMs?: number;
}

/**
 * Construct the dispatcher. The constructor opens the BullMQ Queue
 * + Worker handles eagerly so they're ready before `start()` runs;
 * `start()` only registers recurring jobs.
 */
export class AgentDispatcher {
  private readonly db: Db;
  private readonly definitions: AgentDefinitionRegistry;
  private readonly runners: AgentRunnerRegistry;
  private readonly logger: Logger;
  private readonly router: LlmRouter | undefined;
  private readonly sseBus: SseBus | undefined;
  private readonly outputChannels: OutputChannelRegistry | undefined;
  private readonly queue: Queue<DispatchJobData>;
  private readonly worker: Worker<DispatchJobData>;
  private readonly handler: (job: Job<DispatchJobData>) => Promise<unknown>;
  private readonly registerScheduleFn:
    | ((schedule: RegisteredSchedule) => Promise<void>)
    | undefined;
  private readonly removeScheduleFn:
    | ((entry: RegisteredSchedule) => Promise<void>)
    | undefined;
  private readonly registered: RegisteredSchedule[] = [];
  private readonly refreshIntervalMs: number;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** PR-Z6 — single-flight mutex on `refresh()` ticks. Set on entry,
   *  cleared in `finally`. Concurrent calls (e.g. an early manual
   *  invocation from a test or a slow DB query that lets the next
   *  interval fire) observe `true` and no-op. Boolean rather than a
   *  promise: callers don't need to await the in-flight tick, they
   *  just need to skip a redundant enumeration. */
  private refreshing = false;
  /** PR-Z6 round-2 (Copilot triage) — serialises the two code paths
   *  that mutate `this.registered` AND call BullMQ `add`/`removeRepeatable`:
   *  the periodic `refresh()` tick and the admin-API-driven
   *  `updateSchedule()` call. Without this lock the two can interleave:
   *  e.g. operator clicks Save (updateSchedule starts; removes OLD
   *  cron from BullMQ; mid-flight, refresh tick fires; refresh
   *  observes the still-OLD-cron DB row + reconciles by re-registering
   *  the OLD repeatable; updateSchedule then adds the NEW repeatable
   *  on top → cluster fires the agent on TWO crons until the next
   *  engine boot).
   *
   *  Implemented as a chained promise (await any in-flight lock, then
   *  install your own) so callers serialise FIFO rather than no-op'ing
   *  — both refresh() and updateSchedule() carry real reconciliation
   *  work; the second caller must observe the first's mutations
   *  before computing its own diff. */
  private mutationLock: Promise<void> | null = null;
  private stopping: Promise<void> | undefined;

  constructor(options: AgentDispatcherOptions) {
    this.db = options.db;
    this.definitions = options.definitions;
    this.runners = options.runners;
    this.logger = options.logger;
    this.router = options.router;
    this.sseBus = options.sseBus;
    this.outputChannels = options.outputChannels;
    this.registerScheduleFn = options.registerScheduleFn;
    this.removeScheduleFn = options.removeScheduleFn;
    this.refreshIntervalMs =
      options.refreshIntervalMs !== undefined
        ? options.refreshIntervalMs
        : 60_000;

    this.queue = new Queue<DispatchJobData>(DISPATCH_QUEUE_NAME, {
      connection: options.connection,
    });

    this.handler = (job) => this.dispatchOne(job);

    const workerOpts =
      options.autorun !== undefined
        ? {
            connection: options.connection,
            autorun: options.autorun,
          }
        : { connection: options.connection };
    this.worker = new Worker<DispatchJobData>(
      DISPATCH_QUEUE_NAME,
      this.handler,
      workerOpts,
    );
  }

  /**
   * Read every enabled instance with a schedule_cron, validate the
   * cron pattern, and register a recurring job per VALID row.
   * Invalid rows log `scheduler.invalid_cron` and are skipped.
   *
   * After the initial enumeration, arms a 60-second `setInterval`
   * (PR-Z6, phase-a appendix #12) so freshly-seeded `agent_instances`
   * rows become live schedules without an engine restart. The
   * interval is cleared in `stop()`. Tests pass
   * `refreshIntervalMs: 0` to disable the timer and drive `refresh()`
   * manually.
   */
  async start(): Promise<void> {
    const desired = await this.fetchDesiredSchedules();

    let registered = 0;
    let skipped = 0;
    for (const entry of desired.entries) {
      const v = validateCron(entry.scheduleCron);
      if (!v.valid) {
        this.logger.error("scheduler.invalid_cron", {
          instance_id: entry.instanceId,
          definition_slug: entry.definitionSlug,
          cron: entry.scheduleCron,
          error: v.error ?? "unknown",
        });
        skipped += 1;
        continue;
      }
      try {
        await this.registerOne(entry);
      } catch (err) {
        // A failed registration on one row must not block the
        // rest. Log + skip; the operator can re-trigger by
        // bouncing the engine after fixing the upstream Redis
        // issue.
        this.logger.error("scheduler.register_failed", {
          instance_id: entry.instanceId,
          definition_slug: entry.definitionSlug,
          cron: entry.scheduleCron,
          error: err instanceof Error ? err.message : String(err),
        });
        skipped += 1;
        continue;
      }
      this.registered.push(entry);
      registered += 1;
    }

    this.logger.info("scheduler.started", {
      registered,
      skipped,
      total: desired.totalRows,
    });

    // PR-Z6 (phase-a appendix #12) — arm the periodic refresh after
    // the initial enumeration so the boot path is always serial
    // (registered rows appear before the first tick) and the
    // interval is only created when explicitly enabled. `0`
    // (or any non-positive / non-finite value) means "disabled" so
    // tests can drive `refresh()` manually.
    //
    // PR-Z6 round-2 (Copilot triage) — start/stop race guard: if
    // `stop()` was called while `fetchDesiredSchedules()` / the
    // registration loop above was awaiting, `this.stopping` is now
    // set. Arming the interval here would leak a timer past shutdown
    // because `stop()` already ran its `clearInterval` branch before
    // this code path got to assign `this.refreshTimer`. Bail loudly
    // so the leak is surfaced in logs rather than as a process that
    // refuses to exit.
    if (this.stopping !== undefined) {
      this.logger.warn("scheduler.start_aborted_during_stop");
      return;
    }
    if (
      this.refreshTimer === undefined &&
      Number.isFinite(this.refreshIntervalMs) &&
      this.refreshIntervalMs > 0
    ) {
      this.refreshTimer = setInterval(() => {
        // Errors in `refresh()` are swallowed so a transient DB
        // hiccup doesn't crash the dispatcher's event loop tick.
        // The method itself logs `scheduler.refresh_failed`.
        void this.refresh().catch(() => undefined);
      }, this.refreshIntervalMs);
      // Allow the host process to exit while this timer is armed
      // (matches BullMQ's own internal timers).
      this.refreshTimer.unref?.();
    }
  }

  /**
   * PR-Z6 (phase-a appendix #12) — re-enumerate `agent_instances`,
   * diff against the in-memory `registered` list, and reconcile:
   * register newly-enabled rows, deregister rows that disappeared
   * or flipped to `enabled=false`. Invalid-cron rows are logged
   * once per call and skipped.
   *
   * Single-flight: if a previous refresh tick is still in-flight,
   * the second call observes `this.refreshing === true` and no-ops
   * (refresh is idempotent; running it twice back-to-back has no
   * useful effect).
   *
   * PR-Z6 round-2 (Copilot triage) — additionally serialises against
   * the admin-API `updateSchedule()` path via `mutationLock`. Without
   * this lock the two paths can interleave on `this.registered` and
   * the BullMQ `add`/`removeRepeatable` calls — e.g. a refresh tick
   * fires mid-flight of an updateSchedule rollback and reconciles to
   * a now-stale view of the DB row before the rollback finishes
   * unwinding. The single-flight boolean ABOVE handles
   * refresh-vs-refresh; the lock here handles refresh-vs-updateSchedule.
   *
   * Cron-pattern CHANGES on an existing instance are handled by the
   * admin-API `updateSchedule` path; this refresh treats a same-
   * instance row with a changed cron as a delete-then-add to keep
   * the diff simple (the admin path is the operator-driven happy
   * path; the refresh is the "operator ran `agents seed` directly
   * against the DB" fallback).
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    if (this.stopping !== undefined) return;
    this.refreshing = true;
    // PR-Z6 round-2 — acquire the cross-method mutation lock BEFORE
    // any DB read or registered-list mutation. Any in-flight
    // updateSchedule() finishes first; subsequent refresh callers
    // already short-circuited above on `this.refreshing`.
    const priorLock = this.mutationLock;
    let releaseLock!: () => void;
    this.mutationLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    try {
      if (priorLock !== null) await priorLock;
      // Re-check stop AFTER the lock — a long-held lock could mean
      // stop() was called while we waited; bailing here keeps the
      // shutdown-ordering contract intact.
      if (this.stopping !== undefined) return;
      let desired: { readonly entries: RegisteredSchedule[]; readonly totalRows: number };
      try {
        desired = await this.fetchDesiredSchedules();
      } catch (err) {
        this.logger.error("scheduler.refresh_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const desiredById = new Map<string, RegisteredSchedule>();
      for (const entry of desired.entries) {
        desiredById.set(entry.instanceId, entry);
      }
      const registeredById = new Map<string, RegisteredSchedule>();
      for (const entry of this.registered) {
        registeredById.set(entry.instanceId, entry);
      }

      // Removals: in `registered` but not in `desired` (row gone or
      // flipped to enabled=false / schedule_cron NULL). Also treats
      // a same-id row whose `scheduleCron` changed since boot as a
      // remove (the matching add below re-registers with the NEW
      // cron).
      let removed = 0;
      for (const entry of [...this.registered]) {
        const next = desiredById.get(entry.instanceId);
        const cronChanged =
          next !== undefined && next.scheduleCron !== entry.scheduleCron;
        if (next === undefined || cronChanged) {
          try {
            await this.removeOne(entry);
            const idx = this.registered.findIndex(
              (s) => s.instanceId === entry.instanceId,
            );
            if (idx !== -1) this.registered.splice(idx, 1);
            registeredById.delete(entry.instanceId);
            removed += 1;
          } catch (err) {
            this.logger.error("scheduler.deregister_failed", {
              instance_id: entry.instanceId,
              definition_slug: entry.definitionSlug,
              cron: entry.scheduleCron,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Additions: in `desired` but not in `registered`. Validates
      // the cron pattern up-front so the dispatcher's
      // "invalid-cron-doesn't-take-the-whole-scheduler-down"
      // invariant from `start()` extends to the refresh path.
      let added = 0;
      for (const entry of desired.entries) {
        if (registeredById.has(entry.instanceId)) continue;
        const v = validateCron(entry.scheduleCron);
        if (!v.valid) {
          this.logger.error("scheduler.invalid_cron", {
            instance_id: entry.instanceId,
            definition_slug: entry.definitionSlug,
            cron: entry.scheduleCron,
            error: v.error ?? "unknown",
          });
          continue;
        }
        try {
          await this.registerOne(entry);
          this.registered.push(entry);
          registeredById.set(entry.instanceId, entry);
          added += 1;
        } catch (err) {
          this.logger.error("scheduler.register_failed", {
            instance_id: entry.instanceId,
            definition_slug: entry.definitionSlug,
            cron: entry.scheduleCron,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      this.logger.info("scheduler.refreshed", {
        registered: this.registered.length,
        added,
        removed,
      });
    } finally {
      this.refreshing = false;
      // PR-Z6 round-2 — release the cross-method lock. A follow-up
      // caller may already have chained on top of `this.mutationLock`
      // before this line runs; their pending promise stays in the
      // field and serves the next waiter correctly. Once every
      // caller drains, the last release leaves a settled promise in
      // the slot — harmless, awaits on it resolve synchronously.
      releaseLock();
    }
  }

  /** PR-Z6 — single `SELECT` that powers both `start()` and
   *  `refresh()`. Same WHERE clause as the original `start()`
   *  enumeration so the two code paths see the same row set;
   *  refactored into one helper to keep the contract in lockstep. */
  private async fetchDesiredSchedules(): Promise<{
    readonly entries: RegisteredSchedule[];
    readonly totalRows: number;
  }> {
    const result = (await this.db.execute(sql`
      SELECT id::text             AS id,
             definition_slug      AS definition_slug,
             name                 AS name,
             schedule_cron        AS schedule_cron
      FROM agent_instances
      WHERE enabled = true
        AND schedule_cron IS NOT NULL
      ORDER BY created_at
    `)) as unknown as ExecResult<{
      id: string;
      definition_slug: string;
      name: string;
      schedule_cron: string;
    }>;
    const entries: RegisteredSchedule[] = result.rows.map((row) => ({
      instanceId: row.id,
      definitionSlug: row.definition_slug,
      name: row.name,
      scheduleCron: row.schedule_cron,
    }));
    return { entries, totalRows: result.rows.length };
  }

  /**
   * Snapshot of every recurring job currently registered with this
   * dispatcher. The `/api/admin/scheduler` route reads from here
   * (cheap in-memory list) rather than round-tripping to Redis.
   */
  listSchedules(): readonly RegisteredSchedule[] {
    return [...this.registered];
  }

  /**
   * PR-R3 (phase-a appendix #10) — enqueue ONE-SHOT dispatch.
   * Used by `POST /api/admin/agents/:slug/dispatch` to fire an
   * agent on demand from the management UI without waiting for the
   * cron tick.
   *
   * `enqueueOneShot` ALWAYS sets `triggeredBy: 'manual'` — this
   * method is the on-demand dispatch path, so the manual provenance
   * is hardwired here rather than parameterised. Scheduled fires
   * use the cron-driven `Queue.add(...)` call inside `registerOne`
   * (see `start()` / `registerOne`), which omits `triggeredBy` →
   * the dispatch handler reads that absence as `scheduled` and sets
   * `agent_runs.inputs.dispatchedBy = 'scheduler'`. A future caller
   * MUST NOT use `enqueueOneShot` for a scheduled fire — it would
   * mis-attribute the run as operator-initiated in the audit
   * trail and the Activity feed.
   *
   * The job lands on the SAME `selfop.dispatch` queue scheduled
   * dispatches use, so the same Worker handler (`dispatchOne`) +
   * agent harness terminalisation path apply. The handler treats
   * `dryRun` and `triggeredBy` as opaque metadata to propagate into
   * `agent_runs.inputs` — the resulting `runId` is generated INSIDE
   * the harness on `startRun`, so this method returns the BullMQ
   * `jobId` (used by the route as a request trace id; the actual
   * run id is observed via the SSE feed).
   *
   * No `repeat` option → BullMQ runs the job once and removes it.
   * No `jobId` deduplication → operator can fire repeatedly (the
   * route enforces a token-bucket rate-limit per (agent × user ×
   * domain) so a runaway click doesn't fork-bomb the queue).
   */
  async enqueueOneShot(args: {
    readonly instanceId: string;
    readonly dryRun?: boolean;
  }): Promise<{ readonly jobId: string }> {
    if (typeof args.instanceId !== "string" || args.instanceId.length === 0) {
      throw new Error(
        "AgentDispatcher.enqueueOneShot: instanceId must be a non-empty string",
      );
    }
    const job = await this.queue.add(
      "dispatch",
      {
        instanceId: args.instanceId,
        dryRun: args.dryRun ?? false,
        triggeredBy: "manual",
      },
      {
        // No jobId → BullMQ assigns a fresh sequential id; no
        // dedupe so back-to-back operator clicks each fire (the
        // route rate-limits separately).
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    const jobId = job.id;
    if (typeof jobId !== "string" || jobId.length === 0) {
      // BullMQ assigns a string id by default; this branch guards
      // against a future API change that would surface as a silent
      // empty-string in the audit trail.
      throw new Error(
        "AgentDispatcher.enqueueOneShot: BullMQ Queue.add returned no job id",
      );
    }
    return { jobId };
  }

  /**
   * PR-R6 (phase-a appendix #10) — change the cron pattern for every
   * already-registered repeatable whose `instanceId` matches one of
   * the supplied entries. The admin-API route passes the full set
   * of (instanceId, oldCron, newCron) triples for every instance
   * scoped to the agent slug; this method walks them in order,
   * removes the old repeatable, registers a fresh one with the new
   * pattern, and (on success of ALL entries) updates the in-memory
   * `registered` list so the subsequent `listSchedules()` call
   * reflects the change.
   *
   * Atomicity model: BullMQ has no native transaction over a
   * remove-then-add of a repeatable, so `updateSchedule` is best-
   * effort across the cluster. The route wraps the DB UPDATE +
   * audit-row INSERT + this call inside one db.transaction; a
   * throw here unwinds BOTH so the operator's DB state and audit
   * trail match what the dispatcher actually committed.
   *
   * Multi-instance roll-forward (PR-R6 round-2): when the loop
   * processes 2+ entries and a LATER entry throws, the EARLIER
   * entries that already swapped successfully would be left at
   * the NEW cron in BullMQ while the DB transaction unwinds back
   * to the OLD cron — splitting the cluster's view of the schedule
   * until the next engine boot reconciles from DB. This method
   * tracks the set of successfully-swapped entries; on a throw it
   * rolls EVERY successful swap back to its OLD cron BEFORE
   * re-throwing. Rollback failures are logged but don't suppress
   * the original error — the route's tx still unwinds; the next
   * engine boot's `start()` re-registers from DB and reconciles.
   *
   * The in-memory `registered` mutation runs AFTER all swaps
   * succeeded so a partial failure can't leave the list in a
   * mixed (some new, some old) state.
   *
   * On success, the `registered` array's matching entries are
   * mutated in place to carry the NEW `scheduleCron`; entries not
   * present in the input set are left untouched.
   */
  async updateSchedule(args: {
    readonly entries: ReadonlyArray<{
      readonly instanceId: string;
      readonly definitionSlug: string;
      readonly name: string;
      readonly oldCron: string;
      readonly newCron: string;
    }>;
  }): Promise<void> {
    if (args.entries.length === 0) return;
    // PR-Z6 round-2 (Copilot triage) — acquire the cross-method
    // mutation lock so refresh() ticks don't interleave with the
    // remove/add swap loop below. Without this, a periodic refresh
    // could reconcile mid-flight (e.g. seeing the still-OLD-cron DB
    // row right after we removed the OLD-cron repeatable but before
    // we added the NEW one) and re-register a stale BullMQ
    // repeatable on top of the partially-completed swap. The lock
    // is chained FIFO: any in-flight refresh finishes its
    // reconciliation pass before we begin mutating.
    const priorLock = this.mutationLock;
    let releaseLock!: () => void;
    this.mutationLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    if (priorLock !== null) await priorLock;
    try {
      // Pair every input entry with its old/new RegisteredSchedule
      // shapes up-front so the swap loop only references what it
      // needs and the rollback path doesn't have to re-derive the
      // shapes from the caller's input shape.
      interface Plan {
        readonly oldRegistered: RegisteredSchedule;
        readonly newRegistered: RegisteredSchedule;
        readonly noop: boolean;
      }
      const plans: Plan[] = args.entries.map((entry) => {
        const common = {
          instanceId: entry.instanceId,
          definitionSlug: entry.definitionSlug,
          name: entry.name,
        };
        return {
          oldRegistered: { ...common, scheduleCron: entry.oldCron },
          newRegistered: { ...common, scheduleCron: entry.newCron },
          noop: entry.oldCron === entry.newCron,
        };
      });

      // Successfully swapped entries (BullMQ now carries NEW cron).
      // On a later throw we walk this set in REVERSE and roll each
      // back to OLD cron before re-throwing.
      const swapped: Plan[] = [];

      try {
        for (const plan of plans) {
          // Skip the no-op case so a redundant PUT (operator clicks
          // Save without changing the picker) doesn't churn the
          // BullMQ repeatable index unnecessarily.
          if (plan.noop) continue;
          await this.removeOne(plan.oldRegistered);
          await this.registerOne(plan.newRegistered);
          swapped.push(plan);
        }
      } catch (err) {
        // Multi-instance rollback: every entry that ALREADY swapped
        // to NEW cron earlier in the same call needs to come back
        // to OLD cron. Walk in reverse order (mirror of the swap
        // walk) so the cluster state moves through the same
        // sequence the swap took, just in the opposite direction.
        // A failure inside the rollback is logged and the loop
        // continues — the operator's DB tx still unwinds, and the
        // next engine boot reconciles from `agent_instances` rows.
        for (const plan of swapped.slice().reverse()) {
          try {
            await this.removeOne(plan.newRegistered);
            await this.registerOne(plan.oldRegistered);
          } catch (rollbackErr) {
            this.logger.error("scheduler.update_rollback_failed", {
              instance_id: plan.oldRegistered.instanceId,
              error:
                rollbackErr instanceof Error
                  ? rollbackErr.message
                  : String(rollbackErr),
            });
          }
        }
        // The FAILING entry: registerOne may have thrown after
        // removeOne succeeded, so the old pattern is no longer in
        // BullMQ for this instance. Try to re-register the OLD
        // pattern so we don't leave the instance with NO cron entry
        // registered. Best-effort — a failure here is logged and we
        // still re-throw the original error so the route's DB tx
        // unwinds.
        const failing = plans[swapped.length];
        if (failing !== undefined && !failing.noop) {
          try {
            await this.registerOne(failing.oldRegistered);
          } catch (rollbackErr) {
            this.logger.error("scheduler.update_rollback_failed", {
              instance_id: failing.oldRegistered.instanceId,
              error:
                rollbackErr instanceof Error
                  ? rollbackErr.message
                  : String(rollbackErr),
            });
          }
        }
        throw err;
      }

      // All swaps succeeded — mutate the in-memory registered list.
      // Doing this AFTER the swap loop (rather than per-entry) means
      // a partial failure can't leave `registered` in a mixed
      // (some new, some old) state: the throw above bubbles out
      // before this point and the in-memory list still reflects the
      // pre-call (= post-rollback) cron pattern.
      for (const plan of plans) {
        if (plan.noop) continue;
        // Index by instanceId rather than position so we stay safe
        // if start() ever changes ordering.
        const idx = this.registered.findIndex(
          (s) => s.instanceId === plan.newRegistered.instanceId,
        );
        if (idx === -1) {
          // Instance wasn't in the registered list (e.g. it was
          // skipped at boot due to invalid cron). Push the new
          // entry so listSchedules() picks it up; the route only
          // calls updateSchedule for instances it just verified
          // exist + are enabled, so this is the recovery path for
          // a previously-invalid cron getting fixed via the UI.
          this.registered.push(plan.newRegistered);
        } else {
          this.registered[idx] = plan.newRegistered;
        }
      }
    } finally {
      // PR-Z6 round-2 — release the cross-method lock so any waiting
      // refresh() can proceed. The release is always safe to call —
      // a throw from the swap loop already triggered rollback above;
      // a successful path falls through here cleanly.
      releaseLock();
    }
  }

  /** Internal: invoke the test-supplied registration stub if set,
   *  else call BullMQ's real `Queue.add(...)` with `repeat`. */
  private async registerOne(entry: RegisteredSchedule): Promise<void> {
    if (this.registerScheduleFn !== undefined) {
      await this.registerScheduleFn(entry);
      return;
    }
    // BullMQ deduplicates by repeat-key (built from name + pattern
    // + jobId). Using `instance_id` as `jobId` makes a re-
    // registration on engine restart land on the same repeatable;
    // the `immediately: false` flag prevents a boot-time burst.
    //
    // Round-3 fix #1: pin `tz: 'UTC'`. BullMQ's repeat parser
    // defaults to the host's local timezone (cron-parser
    // `ParserOptions.tz` is undefined → resolves to local). Without
    // this, schedules drift on non-UTC hosts (developer Macs,
    // bare-metal Linux deploys) — `0 8 * * 1-5` would fire at 8am
    // wall-clock instead of 8am UTC. Containerized prod is usually
    // UTC, but pinning here guarantees the same behavior across
    // every deployment shape AND keeps `nextFireAt` from
    // `cron-parser.parseExpression(..., { tz: 'UTC' })` aligned
    // with what BullMQ actually scheduled.
    await this.queue.add(
      "dispatch",
      { instanceId: entry.instanceId },
      {
        jobId: entry.instanceId,
        repeat: { pattern: entry.scheduleCron, tz: "UTC", immediately: false },
      },
    );
  }

  /** Internal (PR-R6): tear down a previously-registered repeatable
   *  before `updateSchedule` re-adds it with the new pattern. Uses
   *  the test-supplied stub if set, else calls BullMQ's real
   *  `removeRepeatable(...)`. The repeat options MUST match the
   *  shape `registerOne` used at boot (`tz: 'UTC'`, `immediately:
   *  false`) so the repeat-key BullMQ computes resolves to the same
   *  entry — a mismatch here silently leaves the OLD repeatable in
   *  Redis while the NEW one is added on top, double-firing the
   *  agent. */
  private async removeOne(entry: RegisteredSchedule): Promise<void> {
    if (this.removeScheduleFn !== undefined) {
      await this.removeScheduleFn(entry);
      return;
    }
    await this.queue.removeRepeatable(
      "dispatch",
      {
        pattern: entry.scheduleCron,
        tz: "UTC",
        immediately: false,
      },
      entry.instanceId,
    );
  }

  /**
   * Pause + close the worker + queue. Idempotent — a second call
   * shares the in-flight close promise.
   */
  async stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    // PR-Z6 round-2 (Copilot triage) — set `this.stopping` BEFORE any
    // other shutdown work. The flag is the cross-method shutdown
    // signal: `start()` checks it before arming the periodic timer
    // (so a `stop()` that races a slow `start()` doesn't leak a
    // setInterval handle that nothing will ever clear), and
    // `refresh()` checks it before mutating any state. Both checks
    // are racy with the OLD ordering (timer cleared first, flag set
    // later) — the new ordering installs the signal first so every
    // other code path observes "we are stopping" before this method
    // does any cleanup work.
    let resolveStopping!: () => void;
    let rejectStopping!: (err: unknown) => void;
    this.stopping = new Promise<void>((resolve, reject) => {
      resolveStopping = resolve;
      rejectStopping = reject;
    });
    // Now safe to tear down: any concurrent `start()` will bail on
    // the new flag check; any concurrent `refresh()` short-circuits.
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    void (async (): Promise<void> => {
      try {
        // Pause first so no new jobs start while we drain.
        await this.worker.pause(true).catch(() => undefined);
        // Close worker + queue in parallel; both are idempotent
        // internally.
        await Promise.all([
          this.worker.close().catch((err: unknown) => {
            this.logger.warn("scheduler.worker_close_failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }),
          this.queue.close().catch((err: unknown) => {
            this.logger.warn("scheduler.queue_close_failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }),
        ]);
        resolveStopping();
      } catch (err) {
        // Anything thrown after the pause/close catches above must
        // still terminate the promise so awaiters don't hang. The
        // per-step catches already log; this is a belt-and-suspenders
        // path for an unexpected throw.
        rejectStopping(err);
      }
    })();
    return this.stopping;
  }

  /**
   * Dispatch one job: resolve the instance, find the definition +
   * runner, hand off to the harness. Errors from the runner are
   * captured by the harness as `failed` agent_runs rows; this
   * method only re-throws when:
   *   - `instanceId` doesn't resolve (definition or instance row
   *     missing), or
   *   - no runner is registered for the instance's definition_slug.
   * Both are configuration bugs and warrant BullMQ retry / DLQ.
   */
  private async dispatchOne(
    job: Job<DispatchJobData>,
  ): Promise<unknown> {
    const { instanceId } = job.data;
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new Error(
        `selfop.dispatch: job ${job.id ?? "(no id)"} missing instanceId`,
      );
    }
    const instance = await loadInstanceById(this.db, instanceId);
    const runner = this.runners.get(instance.definitionSlug);
    if (runner === undefined) {
      // Round-2 fix #4 — WHY this throw exists and what it does NOT do.
      //
      // The throw guards against an orchestrator config bug: a
      // schedulable instance row exists in the DB whose
      // `definition_slug` doesn't have a corresponding entry in the
      // injected `AgentRunnerRegistry`. In v0.1 this never fires
      // because production code passes no `agentRunners` at all
      // (the dispatcher boots with an empty registry); when a
      // follow-up wires Heartbeat / Lint / Surfacer runner closures
      // a missing slug becomes possible and we want loud failure
      // rather than silent no-op.
      //
      // What this branch does NOT do today: write a `failed`
      // agent_runs row before throwing. The harness's run recorder
      // (startRun -> completeRun) requires the resolved
      // AgentDefinition + the runner closure; we don't have either
      // when the registry lookup misses. As a result BullMQ retries
      // until the per-job attempt cap hits and the job lands on the
      // DLQ — the operator sees N failed-job entries instead of one
      // visible `failed` agent_runs row tied to the instance.
      //
      // Follow-up (v0.2 / phase-b, when HttpMcpToolClient lands and
      // production runners are wired): either (a) record a
      // synthetic `failed` agent_runs row before the throw so the
      // Activity feed surfaces the misconfiguration with one entry,
      // or (b) pin BullMQ retry to `attempts: 1` for this code
      // path so the operator sees one DLQ entry instead of N. Both
      // require a definition lookup that survives the registry
      // miss, plus a `completeRun` shape that accepts a synthetic
      // tool-call ledger. Tracked under "agent-harness needs a
      // schedule-time validation pass" — out of scope for PR-M2.
      throw new Error(
        `selfop.dispatch: no runner registered for definition_slug '${instance.definitionSlug}' (instance ${instanceId})`,
      );
    }
    const definition = this.definitions.get(instance.definitionSlug);
    if (definition === undefined) {
      // The harness would also error on this — surface it here
      // with a friendlier message before paying the run-recorder
      // INSERT cost.
      throw new Error(
        `selfop.dispatch: instance ${instanceId} references unknown agent definition '${instance.definitionSlug}'`,
      );
    }
    // The harness handles per-run terminalisation (success /
    // failed) and SSE emission. A throw FROM the runner is
    // recorded as a failed run; the harness returns normally so
    // BullMQ doesn't retry the dispatch (the run row is the DLQ
    // surface). This matches the pre-existing
    // `agent-harness/recorder.ts` carve-out.
    // The harness requires a router for `AgentRunContext.router`;
    // runners that don't invoke the LLM ignore it. Tests that
    // never reach a router call may pass `router: undefined` to
    // the dispatcher constructor — we cast through `unknown` here
    // (the harness's typing requires the field; runtime-wise an
    // unused router is fine).
    const router = (this.router ?? ({} as unknown)) as LlmRouter;
    // PR-R3 — distinguish on-demand from cron dispatches in
    // `agent_runs.inputs` so the operator can later tell a "Run
    // now" click apart from the cron tick. The `agent_trigger`
    // enum has no `manual` variant in v0.1, so on-demand
    // dispatches reuse `http` (the request entered via the
    // admin-API) and the `inputs.dispatchedBy` field carries the
    // operator/scheduler distinction.
    const isManual = job.data.triggeredBy === "manual";
    const inputs: Record<string, unknown> = isManual
      ? { dispatchedBy: "operator", dryRun: job.data.dryRun ?? false }
      : { dispatchedBy: "scheduler" };
    const result = await invokeAgent({
      definitions: this.definitions,
      db: this.db,
      router,
      logger: this.logger,
      instanceId,
      trigger: isManual ? "http" : "scheduled",
      inputs,
      run: runner,
      ...(this.sseBus !== undefined ? { sseBus: this.sseBus } : {}),
    });

    // PR-Z4 (phase-a appendix #12 G5) — post-run delivery hook.
    // Per architecture §9.4 + THREAT-MODEL §3.5 Q10: the agent's
    // JSON output is delivered post-LLM (out-of-band) to the
    // operator-bound output channels. The LLM does NOT have an
    // `output_channel_deliver` tool — delivery is the engine's
    // responsibility, gated by the per-instance binding closed set.
    //
    // PR-R3 (on-demand dispatch) — when the operator triggered the
    // run with `dryRun: true`, we skip delivery so the operator
    // can sanity-re-run without producing side effects.
    //
    // Failures here are LOGGED but DO NOT fail the run — the agent
    // body completed; the audit row stays `success`. The structured
    // log line `output_channel.deliver` carries the per-channel
    // outcome for the operator to inspect.
    if (
      result.status === "success" &&
      job.data.dryRun !== true &&
      this.outputChannels !== undefined &&
      instance.outputChannelIds.length > 0
    ) {
      await this.dispatchDeliveries({
        runId: result.runId,
        definitionSlug: instance.definitionSlug,
        instanceId: instance.id,
        bindings: instance.outputChannelIds.map(
          (b): OutputChannelBinding => ({
            adapter_slug: b.adapter_slug,
            config: b.config,
          }),
        ),
        payload: result.output,
      });
    }

    return result;
  }

  /** PR-Z4 — iterate every binding on the instance and call
   *  `OutputChannelRegistry.deliver(...)` per binding. Per-binding
   *  delivery failures are structured-logged via the
   *  `output_channel.deliver` log line (status=failed, scrubbed
   *  error) but DO NOT throw out of `dispatchOne` — the agent body
   *  already terminalised on success, and one failed channel is
   *  non-fatal for the run. We deliberately do NOT mutate the
   *  `agent_runs.status` row on a delivery failure: the agent body
   *  succeeded; delivery is an out-of-band concern (Q10) so its
   *  failure mode must not flip the run terminal status.
   *
   *  (Future: SSE-emit delivery failures to the Activity feed so
   *  the operator surfaces them without tailing JSON logs. Filed
   *  as a v0.2 polish — for v0.1 the structured log is the audit
   *  surface and the JSON-log harvester groups by
   *  `(run_id, adapter_slug)` to derive delivery health.)
   *
   *  The registry's `deliver` cross-checks `delivery.adapterSlug`
   *  against the binding set BEFORE calling the adapter — Q10
   *  binding enforcement. We pass every binding's `adapter_slug`
   *  as the delivery target verbatim, so the closed-set check is
   *  trivially satisfied for the iteration loop. The real check
   *  guards against a future code path that proposes a delivery
   *  whose slug doesn't match any binding (e.g. an agent body
   *  returning a routing hint). */
  private async dispatchDeliveries(args: {
    readonly runId: string;
    readonly definitionSlug: string;
    readonly instanceId: string;
    readonly bindings: readonly OutputChannelBinding[];
    readonly payload: unknown;
  }): Promise<void> {
    const registry = this.outputChannels;
    if (registry === undefined) return;
    for (const binding of args.bindings) {
      try {
        await registry.deliver({
          bindings: args.bindings,
          delivery: {
            adapterSlug: binding.adapter_slug,
            payload: args.payload,
            // PR-W2 (phase-a appendix #13) — thread the agent's
            // definition slug through to the bridge so the
            // per-(agent, adapter) transformer dispatch can pick
            // the right merge closure. The dispatcher already has
            // this in scope (`instance.definitionSlug`); the bridge
            // forwards it into `MergePayload`'s args.
            agentSlug: args.definitionSlug,
          },
        });
        this.logger.info("output_channel.deliver", {
          run_id: args.runId,
          definition_slug: args.definitionSlug,
          instance_id: args.instanceId,
          adapter_slug: binding.adapter_slug,
          status: "success",
        });
      } catch (err) {
        // Per-binding failure: log; do NOT throw — the run already
        // terminalised on success and the next channel may still
        // succeed. The structured log line `output_channel.deliver`
        // is the audit surface (the JSON log harvester groups by
        // `(run_id, adapter_slug)` to derive delivery health). We
        // deliberately do NOT mutate the agent_runs row on a
        // delivery failure: the agent body succeeded; delivery is
        // an out-of-band concern (Q10) so its failure mode must
        // not flip the run terminal status.
        const errorMessage = safeErrorMessage(err);
        this.logger.warn("output_channel.deliver", {
          run_id: args.runId,
          definition_slug: args.definitionSlug,
          instance_id: args.instanceId,
          adapter_slug: binding.adapter_slug,
          status: "failed",
          error: errorMessage,
        });
      }
    }
  }

  // ── Test seams ─────────────────────────────────────────────────
  //
  // These accessors are exposed for the contract tests so they can
  // (a) inspect the registered repeatable jobs, (b) invoke the
  // dispatch handler directly without the BullMQ pull loop, and
  // (c) spy on close() to verify graceful shutdown ordering. The
  // production code path never calls them.

  /** @internal Test seam — returns the underlying Queue. */
  queueForTest(): Queue<DispatchJobData> {
    return this.queue;
  }

  /** @internal Test seam — returns the underlying Worker. */
  workerForTest(): Worker<DispatchJobData> {
    return this.worker;
  }

  /** @internal Test seam — returns the dispatch handler so tests
   *  can synthesise a fake Job and invoke it directly. */
  dispatchHandlerForTest(): (job: Job<DispatchJobData>) => Promise<unknown> {
    return this.handler;
  }
}
