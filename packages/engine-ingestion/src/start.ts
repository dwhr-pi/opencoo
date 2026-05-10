/**
 * Engine-ingestion entrypoint. Thin wrapper over `startEngine`
 * from `@opencoo/shared/engine-scaffold` that wires in production
 * defaults for `pg.Pool` + `ioredis.Redis` and types the registry
 * to ingestion's narrowed `PipelineDefinition` (which carries a
 * `wikiAdapter` on its `PipelineContext`).
 *
 * Production defaults construct real pg.Pool / ioredis Redis;
 * tests inject stubs via `dbFactory` / `redisFactory` /
 * `serverFactory`.
 *
 * BullMQ requirement: when ioredis is used as the BullMQ
 * connection, `maxRetriesPerRequest: null` and
 * `enableReadyCheck: false` must be set — the default factory
 * here applies both.
 */
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";

import {
  buildServer,
  PipelineRegistry,
  startEngine,
  type ProbeMap,
  type StartDb,
  type StartedEngine as BaseStartedEngine,
  type StartOptions as BaseStartOptions,
  type StartRedis,
  type StartServer,
} from "@opencoo/shared/engine-scaffold";

import { loadEngineConfig, type EngineConfig } from "./config.js";
import type { PipelineDefinition } from "./types.js";
import {
  registerWebhookRoute,
  WEBHOOK_BODY_LIMIT_BYTES,
} from "./intake/webhook-receiver.js";
import {
  startIngestionWorkers,
  type IngestionWorkers,
  type WorkerContext,
} from "./workers/index.js";

export type IngestionRegistry = PipelineRegistry<PipelineDefinition>;

/** v0.1 mode flag (PR-M1, phase-a appendix #5).
 *
 *  - `'probes-only'` (default): the engine starts the Fastify
 *     listener with health/ready probes. No BullMQ Workers are
 *     constructed — useful for the plan #82 boot path before
 *     workers existed, plus every pre-PR-M1 test.
 *  - `'workers'`: in addition to probes, all five BullMQ Workers
 *     are booted and bound to the queues the webhook receiver +
 *     scanner enqueue onto. The orchestrator (CLI `serve.ts`)
 *     uses this mode in production.
 */
export type IngestionStartMode = "probes-only" | "workers";

export type StartedEngine = BaseStartedEngine<
  EngineConfig,
  IngestionRegistry
> & {
  /** Present iff `mode === 'workers'`. The orchestrator may
   *  invoke `workers.closeAll()` ahead of `engine.close()` for
   *  finer-grained shutdown ordering. */
  readonly workers?: IngestionWorkers;
};

// Re-exports so callers can construct the typed registry + pass
// it to `start()` from one import.
export { PipelineRegistry } from "@opencoo/shared/engine-scaffold";
export type {
  ProbeMap,
  StartDb,
  StartRedis,
  StartServer,
} from "@opencoo/shared/engine-scaffold";

export interface StartOptions
  extends Omit<
    BaseStartOptions<EngineConfig, IngestionRegistry>,
    "config" | "dbFactory" | "redisFactory"
  > {
  /** Optional override of process.env — keeps `start()` testable
   *  by injecting a stub env without polluting the real one. */
  readonly env?: Record<string, string | undefined>;
  /** Optional override of the EngineConfig — bypasses
   *  `loadEngineConfig(env)` when set, useful for tests that
   *  build a full config without env-var plumbing. */
  readonly config?: EngineConfig;
  /** @internal Test seam — defaults to `new pg.Pool(...)`. */
  readonly dbFactory?: (config: EngineConfig) => StartDb;
  /** @internal Test seam — defaults to `new Redis(...)`. */
  readonly redisFactory?: (config: EngineConfig) => StartRedis;
  /**
   * Engine-ingestion never auto-migrates — engine-self-operating
   * handles migrations at boot via OPENCOO_AUTO_MIGRATE (PR-X1,
   * phase-a follow-up). The orchestrator (CLI `serve.ts`) boots
   * self-op first, so by the time ingestion starts the journal
   * is already current. This flag is preserved for forward
   * compatibility / scripted-deploy parity with self-op's
   * `StartOptions.skipMigrate`; passing it has no effect on
   * ingestion's boot path.
   */
  readonly skipMigrate?: boolean;
  /** Boot mode (PR-M1, phase-a appendix #5). Defaults to
   *  `'probes-only'`. When set to `'workers'`, the engine boots
   *  all five BullMQ Workers AFTER the Fastify listener is up,
   *  using the supplied `workerContext` (which the orchestrator
   *  populates with the shared db/Redis/SseBus). */
  readonly mode?: IngestionStartMode;
  /** Required when `mode === 'workers'`. The orchestrator
   *  constructs this once at boot and threads it down. Holds
   *  the production WikiAdapter, GuardAdapter, LlmRouter, etc.
   *  Optional in `probes-only` mode. */
  readonly workerContext?: WorkerContext;
  /** Required when `mode === 'workers'`. The shared BullMQ
   *  connection — same Redis instance the queues use. Typically
   *  `{ url: config.redisUrl, maxRetriesPerRequest: null,
   *  enableReadyCheck: false }`. */
  readonly workerConnection?: ConnectionOptions;
  /** Phase-a appendix #9 PR-Q6 — shared Fastify mount (PORT
   *  collision fix). When the orchestrator co-boots both engines
   *  in the same process, the self-op engine's listening Fastify
   *  is threaded in here as a SIGNAL that the ingestion engine
   *  must NOT bind its own listener (`EADDRINUSE` on port 8080
   *  otherwise). The webhook receiver's `/webhooks/:bindingId`
   *  route and its raw-body parser are mounted on the self-op
   *  Fastify by the orchestrator's pre-listen hook (`registerWebhookRoute`
   *  via `selfOpStart({preListenHooks})`) BEFORE `app.listen()`,
   *  because Fastify rejects `addContentTypeParser` after the
   *  server is ready. This `start()` therefore only spins up
   *  workers + pg/Redis when `sharedFastify` is set; route
   *  registration is the orchestrator's responsibility.
   *
   *  When set, the engine's internal `app.listen()` becomes a
   *  no-op (the shared listener is already accepting traffic) and
   *  the engine's internal `app.close()` becomes a no-op as well —
   *  the self-op engine OWNS the shared listener and closes it on
   *  SIGTERM. Workers, pg.Pool, and Redis are still drained by the
   *  ingestion engine's own `close()`.
   *
   *  Mutually exclusive with a caller-supplied `serverFactory` —
   *  the orchestrator threads `sharedFastify` directly; tests that
   *  want full control still pass their own `serverFactory`. */
  readonly sharedFastify?: FastifyInstance;
}

function defaultDbFactory(config: EngineConfig): StartDb {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

function defaultRedisFactory(config: EngineConfig): StartRedis {
  return new Redis(config.redisUrl, {
    // BullMQ requirement.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/** Register the webhook receiver route on a Fastify instance.
 *  Used by both the engine-owned-listener path (where the engine
 *  builds its own Fastify) and the orchestrator's pre-listen hook
 *  (PR-Q6, phase-a appendix #9 fix-up: the orchestrator passes this
 *  to `engine-self-operating.start({preListenHooks})` so the route +
 *  parser register on the SHARED Fastify before `app.listen()`).
 *
 *  Exported so the CLI orchestrator can compose a closure
 *  `(app) => mountWebhookRoute(app, ctx)` and thread it into self-op's
 *  `start({preListenHooks})` without re-implementing the
 *  `WorkerContext → registerWebhookRoute` adapter inline.
 *
 *  Caller is responsible for ensuring the ctx fields the receiver
 *  consumes (`credentialStore`, `webhookVerifier`,
 *  `webhookScannerQueue`, `webhookDlqQueue`, `enqueue`) are populated.
 *  This invariant matches the boot-validation block in `start()` —
 *  in production those checks fire before `start()` returns the
 *  WorkerContext to the orchestrator. */
export function mountWebhookRoute(
  app: FastifyInstance,
  ctx: WorkerContext,
): void {
  registerWebhookRoute(app, {
    db: ctx.db as unknown as Parameters<typeof registerWebhookRoute>[1]["db"],
    credentialStore: ctx.credentialStore!,
    adapterRegistry: ctx.adapterRegistry,
    verifier: ctx.webhookVerifier!,
    scannerQueue: ctx.webhookScannerQueue!,
    dlqQueue: ctx.webhookDlqQueue!,
    // (PR-N2) The producer-side `ingestion.scanner.classify` queue
    // handle the composition root already opened for the Scanner
    // pipeline. Reusing the same handle for the receiver's
    // direct-intake branch means a single Queue + a single Redis
    // connection serve both producers — webhook deliveries and
    // periodic scans land on the same backlog the Compile worker
    // dequeues from.
    //
    // Round-3 (Copilot #1): no conditional spread here — `ctx.enqueue`
    // is required in mode='workers' and the boot-validation block in
    // start() throws before we ever reach this helper if it's absent.
    scannerClassifyQueue: ctx.enqueue!,
    appLogger: ctx.logger,
  });
}

export async function start(
  options: StartOptions = {},
): Promise<StartedEngine> {
  const config =
    options.config ?? loadEngineConfig(options.env ?? process.env);

  const mode: IngestionStartMode = options.mode ?? "probes-only";

  // Validate workers-mode prerequisites BEFORE constructing the
  // engine. A missing workerContext at this point is a
  // composition-root bug — fail loud at boot, don't lazy-discover
  // it on the first dequeue.
  if (mode === "workers") {
    if (options.workerContext === undefined) {
      throw new Error(
        "engine-ingestion start: mode='workers' requires options.workerContext (orchestrator must construct the WorkerContext and pass it in)",
      );
    }
    if (options.workerConnection === undefined) {
      throw new Error(
        "engine-ingestion start: mode='workers' requires options.workerConnection (shared BullMQ connection)",
      );
    }
  }

  // PR-Q6: `sharedFastify` only makes sense in workers mode (it
  // exists to mount the webhook receiver) and conflicts with a
  // caller-supplied `serverFactory` (the two paths are mutually
  // exclusive — orchestrator threads `sharedFastify`, tests use
  // `serverFactory`). Surfacing both early prevents subtle
  // "routes mounted twice" bugs.
  if (options.sharedFastify !== undefined) {
    if (mode !== "workers") {
      throw new Error(
        "engine-ingestion start: options.sharedFastify requires mode='workers' (the field exists to mount the webhook receiver onto a shared listener)",
      );
    }
    if (options.serverFactory !== undefined) {
      throw new Error(
        "engine-ingestion start: options.sharedFastify and options.serverFactory are mutually exclusive (the orchestrator co-boot path uses sharedFastify; tests use serverFactory)",
      );
    }
  }

  // Round-2 fix (Copilot #56): when mode='workers', validate that
  // the WorkerContext carries the four webhook-receiver
  // dependencies (credentialStore, webhookVerifier,
  // webhookScannerQueue, webhookDlqQueue). Without these, the
  // receiver cannot mount and webhook deliveries would queue in
  // Redis with no dequeue path.
  //
  // Composition-root bugs fail loud at boot, not at first POST —
  // mirroring the workerContext / workerConnection check above.
  //
  // PR-N2 round-2 (S1): `enqueue` is now also required in
  // mode='workers'. Two reasons:
  //   1. The Scanner pipeline (`pipelines/scanner.ts`) needs it as
  //      its producer-side handle for `ingestion.scanner.classify`
  //      — without it `MISSING_ENQUEUE` triggers per-job +
  //      `scanner.enqueue_failed` log spam on every cron tick.
  //   2. The webhook receiver's PR-N2 direct-intake branch needs it
  //      as `scannerClassifyQueue`. If a future composition root
  //      registers an `enrichEvents`-capable adapter without
  //      `enqueue`, Branch B (legacy fallback) silently activates
  //      and webhook deliveries pile in `webhook_events` without
  //      ever advancing to `ingestion_intake` — exactly the
  //      failure mode PR-N1 was written to eliminate. Treating
  //      `enqueue` as required for production removes the silent
  //      fallback and surfaces the misconfiguration at boot.
  if (mode === "workers") {
    const ctx = options.workerContext as WorkerContext;
    const missing: string[] = [];
    if (ctx.credentialStore === undefined) missing.push("credentialStore");
    if (ctx.webhookVerifier === undefined) missing.push("webhookVerifier");
    if (ctx.webhookScannerQueue === undefined) missing.push("webhookScannerQueue");
    if (ctx.webhookDlqQueue === undefined) missing.push("webhookDlqQueue");
    if (ctx.enqueue === undefined) missing.push("enqueue");
    if (missing.length > 0) {
      throw new Error(
        `engine-ingestion start: mode='workers' requires WorkerContext.{${missing.join(",")}} for the webhook receiver mount (composition-root bug)`,
      );
    }
  }

  // Wrap (or build) the serverFactory so the engine's primary
  // Fastify app gets the webhook receiver route registered BEFORE
  // app.listen(). Round-2 fix (Copilot #56): without this mount,
  // `buildWebhookReceiver` was exported but never called in
  // production — `recordWebhook` was dead code on the live
  // pipeline, the runbook's "drop a tagged Asana task → wait 10s
  // → see webhook_events row" was a lie, and the
  // `webhook_receiver.signature_invalid` log added in PR-N1 was
  // unreachable.
  //
  // The wrapper preserves any caller-supplied serverFactory (test
  // seam) — it simply registers the route on whatever
  // FastifyInstance the factory returns. The wrapper only fires
  // in `mode: 'workers'`; probes-only boots with the original
  // (or user-supplied) factory unchanged.
  //
  // PR-Q6 (phase-a appendix #9) fix-up: when `options.sharedFastify`
  // is set, the orchestrator already has a listening Fastify AND
  // has already mounted the webhook receiver onto it via a
  // pre-listen hook on the self-op engine's `start()`. Mounting
  // here would be a double-register (Fastify rejects) AND would
  // run AFTER `app.listen()` (`addContentTypeParser` rejects
  // post-listen). So this branch returns a no-op `StartServer`
  // immediately — workers + pg/Redis still spin up, but the
  // listener and route registration belong to the orchestrator.
  const noopSharedListenerServer: StartServer = {
    listen: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
  };
  const wrappedServerFactory: BaseStartOptions<
    EngineConfig,
    IngestionRegistry
  >["serverFactory"] =
    mode === "workers"
      ? async (probes: ProbeMap): Promise<StartServer> => {
          // Shared-mount path: orchestrator already mounted the
          // route via the self-op pre-listen hook. Return a no-op
          // StartServer so the scaffold's listen/close cycle is a
          // no-op (the shared listener is owned by self-op).
          if (options.sharedFastify !== undefined) {
            return noopSharedListenerServer;
          }
          const innerFactory =
            options.serverFactory ??
            ((p: ProbeMap): StartServer =>
              buildServer({
                probes: p,
                bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
              }) as unknown as StartServer);
          const server = await innerFactory(probes);
          // Register the webhook route + raw-buffer parser onto
          // the engine's Fastify app. addContentTypeParser MUST
          // happen before listen — startEngine calls listen
          // immediately AFTER serverFactory returns, so this
          // ordering is guaranteed by construction.
          //
          // Cast: the StartServer port is intentionally narrow
          // (listen+close); the receiver route registration
          // requires the full FastifyInstance surface. In
          // production the default factory returns a FastifyInstance
          // (engine-scaffold defaultServerFactory casts the same
          // way); in tests the caller-supplied serverFactory is
          // expected to return a Fastify-compatible value when
          // mode='workers'.
          mountWebhookRoute(
            server as unknown as FastifyInstance,
            options.workerContext as WorkerContext,
          );
          return server;
        }
      : options.serverFactory;

  const baseOptions: BaseStartOptions<EngineConfig, IngestionRegistry> = {
    config,
    dbFactory: options.dbFactory ?? defaultDbFactory,
    redisFactory: options.redisFactory ?? defaultRedisFactory,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(wrappedServerFactory !== undefined
      ? { serverFactory: wrappedServerFactory }
      : {}),
    ...(options.probeExtender !== undefined
      ? { probeExtender: options.probeExtender }
      : {}),
  };
  const baseEngine = await startEngine<EngineConfig, IngestionRegistry>(
    baseOptions,
  );

  if (mode === "probes-only") {
    return baseEngine;
  }

  // mode === 'workers' — boot all five Workers and bind them to
  // the shared Redis connection. Validated above.
  const workers = startIngestionWorkers({
    ctx: options.workerContext as WorkerContext,
    connection: options.workerConnection as ConnectionOptions,
  });

  // Wrap close() so SIGTERM drains workers BEFORE the HTTP
  // listener / pg pool / Redis go away. closeAll() is idempotent
  // internally; baseEngine.close() also memoises so double-close
  // here is safe.
  const baseClose = baseEngine.close.bind(baseEngine);
  return {
    ...baseEngine,
    workers,
    async close(): Promise<void> {
      await workers.closeAll();
      await baseClose();
    },
  };
}
