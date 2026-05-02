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

import type { SseBus } from "../admin-api/sse-bus.js";
import {
  invokeAgent,
  loadInstanceById,
  type AgentDefinitionRegistry,
  type AgentRunContext,
} from "../agent-harness/index.js";

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

/** Payload of every `selfop.dispatch` job. */
export interface DispatchJobData {
  readonly instanceId: string;
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
  private readonly queue: Queue<DispatchJobData>;
  private readonly worker: Worker<DispatchJobData>;
  private readonly handler: (job: Job<DispatchJobData>) => Promise<unknown>;
  private readonly registerScheduleFn:
    | ((schedule: RegisteredSchedule) => Promise<void>)
    | undefined;
  private readonly registered: RegisteredSchedule[] = [];
  private stopping: Promise<void> | undefined;

  constructor(options: AgentDispatcherOptions) {
    this.db = options.db;
    this.definitions = options.definitions;
    this.runners = options.runners;
    this.logger = options.logger;
    this.router = options.router;
    this.sseBus = options.sseBus;
    this.registerScheduleFn = options.registerScheduleFn;

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
   */
  async start(): Promise<void> {
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

    let registered = 0;
    let skipped = 0;
    for (const row of result.rows) {
      const entry: RegisteredSchedule = {
        instanceId: row.id,
        definitionSlug: row.definition_slug,
        name: row.name,
        scheduleCron: row.schedule_cron,
      };
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
      total: result.rows.length,
    });
  }

  /**
   * Snapshot of every recurring job currently registered with this
   * dispatcher. The `/api/admin/scheduler` route reads from here
   * (cheap in-memory list) rather than round-tripping to Redis.
   */
  listSchedules(): readonly RegisteredSchedule[] {
    return [...this.registered];
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

  /**
   * Pause + close the worker + queue. Idempotent — a second call
   * shares the in-flight close promise.
   */
  async stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopping = (async (): Promise<void> => {
      try {
        // Pause first so no new jobs start while we drain.
        await this.worker.pause(true).catch(() => undefined);
      } finally {
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
    const result = await invokeAgent({
      definitions: this.definitions,
      db: this.db,
      router,
      logger: this.logger,
      instanceId,
      trigger: "scheduled",
      inputs: { dispatchedBy: "scheduler" },
      run: runner,
      ...(this.sseBus !== undefined ? { sseBus: this.sseBus } : {}),
    });
    return result;
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
