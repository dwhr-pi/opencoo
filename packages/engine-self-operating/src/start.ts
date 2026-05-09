/**
 * Engine-self-operating entrypoint. Thin wrapper over `startEngine`
 * from `@opencoo/shared/engine-scaffold` that wires:
 *   - production-default pg.Pool + ioredis Redis factories,
 *   - a server factory that registers the admin-API (when the
 *     PR 28 env vars are set) AND the Static UI middleware.
 *     Order matters: admin-API → static-UI so the
 *     setNotFoundHandler doesn't catch unknown `/api/admin/*`
 *     paths (verified by `tests/composition/server-factory.test.ts`).
 *
 * BullMQ requirement: when ioredis is used as the BullMQ
 * connection, `maxRetriesPerRequest: null` and
 * `enableReadyCheck: false` must be set — the default factory
 * applies both. (engine-self-operating doesn't ship pipelines
 * in v0.1, but the harness shape stays in lockstep with
 * engine-ingestion so a v0.2 self-op pipeline can land without
 * boot-path churn.)
 *
 * # Production wiring (PR 30)
 *
 * When `ADMIN_TEAM_SLUG` + `SESSION_HMAC_KEY` + `GITEA_BASE_URL`
 * are all set, `start()` constructs a real fetch-based
 * `GiteaClient`, instantiates the admin-API plugin, and
 * registers it BEFORE the static-ui plugin. When any of those
 * env vars are missing, the engine STILL BOOTS — but with the
 * admin-API disabled and a clear `admin_api.disabled` log line
 * pointing the operator at the missing env var. This boot-
 * tolerant behavior matches PR 18's UI_DIST_PATH treatment.
 */
import pg from "pg";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";

import {
  DrizzleCredentialStore,
  loadEncryptionKey,
} from "@opencoo/shared/credential-store";
import { ConsoleLogger, type Logger } from "@opencoo/shared/logger";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import type { DeleteCap } from "@opencoo/shared/wiki-write";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  PipelineRegistry,
  buildEngineQueue,
  buildServer,
  startEngine,
  type ProbeMap,
  type StartDb,
  type StartedEngine as BaseStartedEngine,
  type StartOptions as BaseStartOptions,
  type StartRedis,
  type StartServer,
} from "@opencoo/shared/engine-scaffold";

import type { GiteaClient } from "./admin-api/auth.js";
import type { ForgetJobEnqueueArgs } from "./admin-api/routes/source-bindings.js";
import {
  createSseBus,
  type SseBus,
} from "./admin-api/sse-bus.js";
import { AgentDefinitionRegistry } from "./agent-harness/index.js";
import {
  AgentDispatcher,
  type AgentRunnerRegistry,
} from "./scheduler/agent-dispatcher.js";
import {
  loadAdminApiCompositionEnv,
  type AdminApiCompositionEnv,
} from "./composition/env.js";
import { createGiteaClient } from "./composition/gitea-client.js";
import { productionServerFactory } from "./composition/server-factory.js";
import { loadEngineConfig, type EngineConfig } from "./config.js";
import { registerStaticUi } from "./static-ui.js";

export type SelfOperatingRegistry = PipelineRegistry;
/** Extended StartedEngine — exposes the SSE bus the engine wired
 *  so the orchestrator (CLI `serve.ts`) can thread it into
 *  engine-ingestion's worker boot. The bus carries Activity-feed
 *  events from BOTH engines so the operator sees a single stream.
 *
 *  PR-M2 also exposes the in-process AgentDispatcher (when one was
 *  successfully constructed at boot — failure to compose surfaces
 *  as a logged warning rather than a crash). The orchestrator
 *  drains it on SIGTERM via `engine.scheduler?.stop()`. */
export type StartedEngine = BaseStartedEngine<
  EngineConfig,
  SelfOperatingRegistry
> & {
  /** Always present after a successful `start()`. Either the
   *  caller-supplied `options.sseBus` (PR-M1) or a fresh bus
   *  the engine constructed at boot. */
  readonly sseBus: SseBus;
  /** Present iff the dispatcher was successfully constructed AND
   *  started. Absent when the dispatcher composition failed (logged)
   *  or no `agentRunners` were passed in `StartOptions`. */
  readonly scheduler?: AgentDispatcher;
};

export { PipelineRegistry } from "@opencoo/shared/engine-scaffold";
export type {
  ProbeMap,
  StartDb,
  StartRedis,
  StartServer,
} from "@opencoo/shared/engine-scaffold";

export interface StartOptions
  extends Omit<
    BaseStartOptions<EngineConfig, SelfOperatingRegistry>,
    "config" | "dbFactory" | "redisFactory" | "serverFactory"
  > {
  /** Optional override of process.env. */
  readonly env?: Record<string, string | undefined>;
  /** Optional pre-built EngineConfig — bypasses loadEngineConfig. */
  readonly config?: EngineConfig;
  /** Optional logger override; defaults to a ConsoleLogger writing
   *  to process.stdout. */
  readonly logger?: Logger;
  /** @internal Test seam — defaults to pg.Pool. */
  readonly dbFactory?: (config: EngineConfig) => StartDb;
  /** @internal Test seam — defaults to ioredis Redis. */
  readonly redisFactory?: (config: EngineConfig) => StartRedis;
  /** @internal Test seam — receives the probe map and the resolved
   *  config so the server factory can wire the static UI from the
   *  config's uiDistPath. Defaults to a Fastify app via buildServer
   *  with the static UI registered (PLUS admin-API in production
   *  when the env vars are set). */
  readonly serverFactory?: (
    probes: ProbeMap,
    config: EngineConfig,
    logger: Logger,
  ) => Promise<StartServer> | StartServer;
  /** @internal Test seam — defaults to `createGiteaClient`. Used
   *  by composition tests to substitute a mock client without
   *  the env-var dance. */
  readonly giteaClientFactory?: (baseUrl: string) => GiteaClient;
  /**
   * v0.1 NO-OP forward-compat flag (PR 30 / plan #135 decision Q4).
   * Engines do NOT auto-migrate at boot — the operator runs
   * `opencoo migrate` explicitly. Reserved for v0.2.
   */
  readonly skipMigrate?: boolean;
  /** Optional SSE bus override (PR-M1, phase-a appendix #5). When
   *  the orchestrator is co-booting engine-ingestion in the same
   *  process, both engines share ONE bus so the Activity feed
   *  shows events from both. When undefined, `start()` constructs
   *  a fresh bus. */
  readonly sseBus?: SseBus;
  /** Optional read-only `ingestion.scanner` BullMQ Queue handle
   *  (PR-M1, phase-a appendix #5). When the orchestrator opens
   *  the queue ONCE and shares it with engine-ingestion (so the
   *  scanner enqueues onto the same Redis stream the admin
   *  pipelines endpoint reads from), it can pass the handle
   *  here to avoid `start()` opening a duplicate. When
   *  undefined, the production wiring path constructs its own
   *  read-only handle the way pre-PR-M1 code did. */
  readonly ingestionQueue?: Parameters<
    typeof productionServerFactory
  >[0]["ingestionQueue"];
  /** Phase-a appendix #5 PR-M2 — agent runner registry. The
   *  orchestrator wires one runner per schedulable definition slug
   *  (Heartbeat / Lint / Surfacer in v0.1). When provided, `start()`
   *  constructs the AgentDispatcher and starts it after the Fastify
   *  listener is up. Absent or empty registry → dispatcher is NOT
   *  constructed (no scheduled agents fire); the read-only
   *  `/api/admin/scheduler` route still registers and returns an
   *  empty list. */
  readonly agentRunners?: AgentRunnerRegistry;
  /** Phase-a appendix #5 PR-M2 — agent definition registry. Required
   *  alongside `agentRunners` for the dispatcher to validate that
   *  every dispatched instance's `definition_slug` resolves to a
   *  known definition before invoking the runner. When undefined,
   *  the dispatcher synthesises an empty registry — runners that
   *  don't depend on definition lookups still work. */
  readonly agentDefinitions?: AgentDefinitionRegistry;
  /** Phase-a appendix #6 PR-N3 round-2 — production LlmRouter
   *  threaded into `AgentDispatcher`. Without this, the dispatcher
   *  falls back to the `({} as unknown) as LlmRouter` empty-object
   *  cast (agent-dispatcher.ts:404) and the FIRST scheduled
   *  Heartbeat / Lint / Surfacer dispatch crashes with
   *  `TypeError: ctx.router.generateObject is not a function`.
   *  The orchestrator (`packages/cli/src/commands/serve.ts`) builds
   *  the router inside `tryComposeAgentRunnersBundleFromEnv` and
   *  passes the SAME instance here AND into the runner closures,
   *  so per-domain `llm_policy` enforcement matches the ingestion
   *  side. */
  readonly agentRouter?: LlmRouter;
  /** PR-Q6 (phase-a appendix #9) fix-up — pre-listen hooks.
   *
   *  Each hook runs against the resolved Fastify instance AFTER
   *  `serverFactory` returns (admin-API + static-UI registered) but
   *  BEFORE `app.listen()` is called. Used by the orchestrator
   *  (`packages/cli/src/commands/serve.ts`) to mount the
   *  engine-ingestion webhook receiver on the SHARED Fastify before
   *  the listener is up — `addContentTypeParser` rejects post-listen
   *  registrations with `FST_ERR_INSTANCE_ALREADY_STARTED`, so the
   *  mount has to land here, not inside engine-ingestion's `start()`
   *  which runs after self-op's listen already returned.
   *
   *  Hooks run sequentially in array order. Any throw here propagates
   *  through `start()` — the engine-scaffold's resource-safety teardown
   *  closes the Fastify + drains pg.Pool/Redis before re-throwing. */
  readonly preListenHooks?: ReadonlyArray<
    (app: FastifyInstance) => void | Promise<void>
  >;
  /** PR-Q6 (phase-a appendix #9) fix-up — Fastify request body limit.
   *
   *  Threaded into `buildServer` for the static-UI-only fallback
   *  factory and the production server factory. The orchestrator sets
   *  this to `WEBHOOK_BODY_LIMIT_BYTES` (5 MB) when co-booting
   *  engine-ingestion in workers mode, so a 4-MB webhook delivery
   *  doesn't hit Fastify's default 1-MB cap and 413 before the
   *  receiver's own size guard runs. */
  readonly bodyLimit?: number;
  /** PR-W1 (phase-a appendix #11) — delete-cap probe + reserve for
   *  the source-forget impact preview (PR-R7).
   *
   *  Threaded through `productionServerFactory` →
   *  `registerAdminApi` so the
   *  `POST /api/admin/source-bindings/:id/forget` route reads the
   *  SAME `InMemoryDeleteCap` instance the ingestion compiler workers
   *  reserve against. The orchestrator constructs the cap once at
   *  composition root (`cli/provision/production-composition.ts`)
   *  and threads it both here AND into the ingestion preflight's
   *  `composeProductionWorkerContext` — single-process v0.1 shape
   *  per architecture §16.
   *
   *  When undefined the route returns 503 (composition-incomplete);
   *  the rest of the admin API is unaffected. */
  readonly deleteCap?: DeleteCap;
  /** PR-W1 (phase-a appendix #11) — composition-supplied enqueuer
   *  for the actual source-forget action (PR-R7). The route plans
   *  the impact + reserves the cap; this callable turns the plan
   *  into BullMQ recompile + delete jobs (built via
   *  `createForgetJobEnqueuer` from `@opencoo/shared/forget`).
   *
   *  When undefined the route returns 503. */
  readonly forgetJobEnqueuer?: (args: ForgetJobEnqueueArgs) => Promise<void>;
}

function defaultDbFactory(config: EngineConfig): StartDb {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

function defaultRedisFactory(config: EngineConfig): StartRedis {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * Static-UI-only server factory. Used when:
 *   - the operator hasn't set the admin-API env vars (boot-
 *     tolerant fallback),
 *   - tests inject this directly via `options.serverFactory`.
 */
async function staticUiOnlyServerFactory(
  probes: ProbeMap,
  config: EngineConfig,
  logger: Logger,
  bodyLimit?: number,
): Promise<StartServer> {
  const app: FastifyInstance = buildServer({
    probes,
    ...(bodyLimit !== undefined ? { bodyLimit } : {}),
  });
  await registerStaticUi(app, {
    ...(config.uiDistPath !== undefined ? { uiDistPath: config.uiDistPath } : {}),
    logger,
  });
  return app as unknown as FastifyInstance & StartServer;
}

/** Try to load the admin-API env. Returns `null` (and logs)
 *  when any required var is missing — boot continues with the
 *  static-UI-only factory. */
function tryLoadAdminApiEnv(
  env: Record<string, string | undefined>,
  logger: Logger,
): AdminApiCompositionEnv | null {
  try {
    return loadAdminApiCompositionEnv(env);
  } catch (err) {
    logger.warn("admin_api.disabled", {
      reason:
        "ADMIN_TEAM_SLUG / SESSION_HMAC_KEY / GITEA_BASE_URL not all set; admin API will not register",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Try to construct the DrizzleCredentialStore the binding-create
 *  handler uses. Returns `null` (and logs) when ENCRYPTION_KEY is
 *  missing or invalid — the admin API still boots, but POST
 *  /api/admin/source-bindings will surface a 500. */
function tryBuildCredentialStore(
  pgPool: pg.Pool,
  env: Record<string, string | undefined>,
  logger: Logger,
): import("@opencoo/shared/credential-store").CredentialStore | null {
  try {
    return new DrizzleCredentialStore({
      db: drizzle(pgPool) as unknown as ConstructorParameters<
        typeof DrizzleCredentialStore
      >[0]["db"],
      key: loadEncryptionKey(env as NodeJS.ProcessEnv),
      logger,
    });
  } catch (err) {
    logger.warn("admin_api.binding_create_disabled", {
      reason:
        "ENCRYPTION_KEY missing or invalid — POST /api/admin/source-bindings will surface 500",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

type IngestionQueueRef = NonNullable<
  Parameters<typeof productionServerFactory>[0]["ingestionQueue"]
>;

/** Resolve the read-only `ingestion.scanner` BullMQ Queue handle
 *  GET /api/admin/pipelines reads stats from. Prefer the caller-
 *  supplied handle (orchestrator co-boot path); fall back to
 *  constructing a fresh one. Returns `undefined` if construction
 *  fails — the endpoint surfaces zeroed stats instead of erroring. */
function resolveIngestionQueue(
  supplied: IngestionQueueRef | undefined,
  redisUrl: string,
  logger: Logger,
): IngestionQueueRef | undefined {
  if (supplied !== undefined) return supplied;
  try {
    return buildEngineQueue("ingestion", "scanner", {
      connection: {
        url: redisUrl,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      },
    }) as unknown as IngestionQueueRef;
  } catch (err) {
    logger.warn("admin_api.pipelines_queue_disabled", {
      reason:
        "Failed to construct ingestion.scanner queue handle — GET /api/admin/pipelines will return zeroed stats",
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export async function start(
  options: StartOptions = {},
): Promise<StartedEngine> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadEngineConfig(env);
  const logger = options.logger ?? new ConsoleLogger();

  // Pre-construct the pg.Pool here so we can pass it to BOTH
  // the scaffold's dbFactory (which returns the pool to the
  // engine harness) AND the production serverFactory (which
  // hands the pool to the admin-API + audit-log writers).
  // Reusing the SAME pool matters: a second pool would double
  // the connection count and run a parallel auth handshake.
  const dbFactoryFromOptions = options.dbFactory;
  const pgPool: pg.Pool | null =
    dbFactoryFromOptions === undefined
      ? new pg.Pool({ connectionString: config.databaseUrl })
      : null;
  const dbFactory: (c: EngineConfig) => StartDb =
    dbFactoryFromOptions ?? ((): StartDb => pgPool as unknown as StartDb);

  const compositionEnv = tryLoadAdminApiEnv(env, logger);
  const giteaClientFactory =
    options.giteaClientFactory ??
    ((baseUrl: string): GiteaClient => createGiteaClient({ baseUrl }));

  // PR-M1, phase-a appendix #5 — resolve the SSE bus ONCE at
  // boot. When the orchestrator co-boots engine-ingestion in the
  // same process, it constructs the bus and passes it down so
  // both engines emit through the same channel.
  const sseBus: SseBus = options.sseBus ?? createSseBus();

  // PR-M2, phase-a appendix #5 — construct the AgentDispatcher
  // EARLY so the production server factory can wire it as the
  // SchedulerSource for `GET /api/admin/scheduler`. The dispatcher
  // is only useful when the orchestrator passed `agentRunners` AND
  // we have a real pg pool + Redis URL — otherwise it has nothing
  // to dispatch and would just open BullMQ connections for nothing.
  // start()ing the dispatcher itself is deferred until AFTER the
  // base engine boots (we want the Fastify listener up before any
  // scheduled job could fire).
  let dispatcher: AgentDispatcher | undefined;
  if (options.agentRunners !== undefined && pgPool !== null) {
    try {
      const definitions =
        options.agentDefinitions ?? new AgentDefinitionRegistry();
      dispatcher = new AgentDispatcher({
        db: drizzle(pgPool) as unknown as ConstructorParameters<
          typeof AgentDispatcher
        >[0]["db"],
        connection: {
          url: config.redisUrl,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
        definitions,
        runners: options.agentRunners,
        logger,
        sseBus,
        // Round-2 fix #1 (Copilot review on PR #57): thread the
        // production LlmRouter so the dispatch context's
        // `ctx.router` is the real instance, not the
        // `({} as unknown) as LlmRouter` empty-object cast.
        // Without this, the FIRST scheduled Heartbeat/Lint/
        // Surfacer dispatch crashes with `TypeError:
        // ctx.router.generateObject is not a function` and the
        // run loops on BullMQ retries until DLQ. Conditional
        // spread keeps the field absent when not provided so
        // exactOptionalPropertyTypes doesn't flag undefined.
        ...(options.agentRouter !== undefined
          ? { router: options.agentRouter }
          : {}),
      });
    } catch (err) {
      logger.error("scheduler.compose_failed", {
        reason:
          "AgentDispatcher constructor threw — Redis connection or BullMQ wiring failure",
        // Round-3 fix #4: scrub + cap. THREAT-MODEL §3.6
        // invariant 11. Redis / BullMQ failures can carry
        // connection strings or auth tokens.
        error: safeErrorMessage(err),
      });
      dispatcher = undefined;
    }
  }

  // Pick the serverFactory:
  //   - test-supplied override → use it,
  //   - production wiring (env complete + pool present) →
  //     productionServerFactory,
  //   - otherwise → staticUiOnlyServerFactory (boot-tolerant).
  //
  // PR-Q6 (phase-a appendix #9) fix-up: the resolved factory is
  // wrapped to run `options.preListenHooks` after the factory
  // returns its FastifyInstance and BEFORE engine-scaffold calls
  // `app.listen()`. The orchestrator threads its webhook-mount
  // closure through here so the parser + route registration lands
  // before Fastify's ready() locks the routing tree. `bodyLimit`
  // is threaded into `buildServer` for both the static-UI fallback
  // and production paths so 5-MB webhook deliveries don't 413 on
  // Fastify's default 1-MB cap.
  const userServerFactory = options.serverFactory;
  const bodyLimit = options.bodyLimit;
  const preListenHooks = options.preListenHooks ?? [];
  const baseServerFactory = (
    probes: ProbeMap,
  ): Promise<StartServer> | StartServer => {
    if (userServerFactory !== undefined) {
      return userServerFactory(probes, config, logger);
    }
    if (compositionEnv === null || pgPool === null) {
      return staticUiOnlyServerFactory(probes, config, logger, bodyLimit);
    }
    const credentialStore = tryBuildCredentialStore(pgPool, env, logger);
    const ingestionQueue = resolveIngestionQueue(
      options.ingestionQueue,
      config.redisUrl,
      logger,
    );
    return productionServerFactory({
      probes,
      config,
      logger,
      pgPool,
      giteaClient: giteaClientFactory(compositionEnv.giteaBaseUrl),
      compositionEnv,
      sseBus,
      ...(credentialStore !== null ? { credentialStore } : {}),
      ...(ingestionQueue !== undefined ? { ingestionQueue } : {}),
      ...(dispatcher !== undefined ? { schedulerSource: dispatcher } : {}),
      // PR-R3 (phase-a appendix #10) — on-demand dispatch enqueue.
      // Bind to the dispatcher instance so the admin-API route can
      // call `enqueueOneShot({ instanceId, dryRun })` against the
      // SAME BullMQ queue the cron path uses.
      ...(dispatcher !== undefined
        ? { dispatchAgentJob: dispatcher.enqueueOneShot.bind(dispatcher) }
        : {}),
      // PR-R6 (phase-a appendix #10) — cadence-editor BullMQ swap.
      // Bind to the same dispatcher instance so a UI cadence
      // change flips the SAME repeatable index `start()` populated
      // at boot.
      ...(dispatcher !== undefined
        ? { updateSchedule: dispatcher.updateSchedule.bind(dispatcher) }
        : {}),
      // PR-W1 (phase-a appendix #11) — wire the forget route's
      // composition deps. The orchestrator (CLI serve.ts) builds
      // both at composition root and threads them through
      // `StartOptions`; productionServerFactory hands them to
      // `registerAdminApi` so the `POST .../forget` route stops
      // returning 503.
      ...(options.deleteCap !== undefined
        ? { deleteCap: options.deleteCap }
        : {}),
      ...(options.forgetJobEnqueuer !== undefined
        ? { forgetJobEnqueuer: options.forgetJobEnqueuer }
        : {}),
      ...(bodyLimit !== undefined ? { bodyLimit } : {}),
    });
  };
  const serverFactory = (
    probes: ProbeMap,
  ): Promise<StartServer> => {
    // Resolve the underlying factory, then run pre-listen hooks
    // against the resolved Fastify before returning to the scaffold
    // (which immediately calls listen()).
    return Promise.resolve(baseServerFactory(probes)).then(async (server) => {
      if (preListenHooks.length > 0) {
        const app = server as unknown as FastifyInstance;
        for (const hook of preListenHooks) {
          await hook(app);
        }
      }
      return server;
    });
  };

  const baseOptions: BaseStartOptions<EngineConfig, SelfOperatingRegistry> = {
    config,
    dbFactory,
    redisFactory: options.redisFactory ?? defaultRedisFactory,
    serverFactory,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.probeExtender !== undefined
      ? { probeExtender: options.probeExtender }
      : {}),
  };
  const baseEngine = await startEngine<EngineConfig, SelfOperatingRegistry>(
    baseOptions,
  );
  // Start the dispatcher AFTER the Fastify listener is up. A
  // failure to start does NOT crash the engine — operator can
  // still use the management UI and trigger agents manually
  // (CLI / MCP). The dispatcher's own log line names the failure;
  // we tag the engine field as `undefined` so the orchestrator's
  // SIGTERM hook knows there's nothing to drain.
  let attachedDispatcher: AgentDispatcher | undefined = dispatcher;
  if (attachedDispatcher !== undefined) {
    try {
      await attachedDispatcher.start();
    } catch (err) {
      logger.error("scheduler.start_failed", {
        reason:
          "AgentDispatcher.start() threw — no recurring jobs registered",
        // Round-3 fix #4: scrub + cap. THREAT-MODEL §3.6
        // invariant 11.
        error: safeErrorMessage(err),
      });
      // Best-effort cleanup of the partially-started dispatcher
      // so we don't leak the BullMQ Worker / Queue handles.
      await attachedDispatcher.stop().catch(() => undefined);
      attachedDispatcher = undefined;
    }
  }

  // Attach the bus + scheduler to the returned engine so the
  // orchestrator can thread the bus into engine-ingestion AND
  // drain the scheduler on SIGTERM.
  const baseClose = baseEngine.close.bind(baseEngine);
  const engine: StartedEngine = Object.assign(baseEngine, {
    sseBus,
    ...(attachedDispatcher !== undefined ? { scheduler: attachedDispatcher } : {}),
    async close(): Promise<void> {
      // Drain dispatcher BEFORE the base engine closes pg + Redis
      // — if pg goes away first, the harness's terminalize-run
      // UPDATE inside the dispatcher's in-flight job throws.
      if (attachedDispatcher !== undefined) {
        await attachedDispatcher.stop().catch((err: unknown) => {
          logger.warn("scheduler.stop_failed", {
            // Round-3 fix #4: scrub + cap. THREAT-MODEL §3.6
            // invariant 11.
            error: safeErrorMessage(err),
          });
        });
      }
      await baseClose();
    },
  });
  return engine;
}

// Re-export the default factories for tests that want to
// reference them by identity.
export { defaultDbFactory, defaultRedisFactory, staticUiOnlyServerFactory };
