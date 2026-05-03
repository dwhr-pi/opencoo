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
   * v0.1 NO-OP forward-compat flag (PR 30 / plan #135 decision Q4).
   *
   * Engines do NOT auto-migrate at boot in v0.1 — the operator
   * runs `opencoo migrate` explicitly per the runbook. This
   * flag is reserved for v0.2 if auto-migrate is added: setting
   * it to `true` will skip the v0.2 auto-migrate step. Today,
   * passing it has no effect — the field exists so the CLI's
   * `--skip-migrate` flag wiring (PR 30 `start` command, when
   * added in a future PR) doesn't fail to type-check.
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

  // Round-2 fix (Copilot #56): when mode='workers', validate that
  // the WorkerContext carries the four webhook-receiver
  // dependencies (credentialStore, webhookVerifier,
  // webhookScannerQueue, webhookDlqQueue). Without these, the
  // receiver cannot mount and webhook deliveries would queue in
  // Redis with no dequeue path.
  //
  // Composition-root bugs fail loud at boot, not at first POST —
  // mirroring the workerContext / workerConnection check above.
  if (mode === "workers") {
    const ctx = options.workerContext as WorkerContext;
    const missing: string[] = [];
    if (ctx.credentialStore === undefined) missing.push("credentialStore");
    if (ctx.webhookVerifier === undefined) missing.push("webhookVerifier");
    if (ctx.webhookScannerQueue === undefined) missing.push("webhookScannerQueue");
    if (ctx.webhookDlqQueue === undefined) missing.push("webhookDlqQueue");
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
  const wrappedServerFactory: BaseStartOptions<
    EngineConfig,
    IngestionRegistry
  >["serverFactory"] =
    mode === "workers"
      ? async (probes: ProbeMap): Promise<StartServer> => {
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
          const ctx = options.workerContext as WorkerContext;
          registerWebhookRoute(server as unknown as FastifyInstance, {
            db: ctx.db as unknown as Parameters<typeof registerWebhookRoute>[1]["db"],
            credentialStore: ctx.credentialStore!,
            adapterRegistry: ctx.adapterRegistry,
            verifier: ctx.webhookVerifier!,
            scannerQueue: ctx.webhookScannerQueue!,
            dlqQueue: ctx.webhookDlqQueue!,
            appLogger: ctx.logger,
          });
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
