/**
 * `opencoo` (bare, no subcommand) — long-running boot verb
 * (architecture.md §14.5, plan radiant-diffie). Pure orchestration
 * around `start({env})` from BOTH engines:
 *
 *   1. `@opencoo/engine-self-operating` — Fastify admin API + UI
 *      hosting + agent harness.
 *   2. `@opencoo/engine-ingestion` — webhook receiver + BullMQ
 *      Workers (PR-M1, phase-a appendix #5).
 *
 * The two engines run in the SAME Node process and share their
 * pg.Pool / ioredis connection / SseBus / read-only ingestion
 * Queue handle through the orchestrator. The engine modules are
 * dynamic-imported so other CLI verbs that don't need either
 * engine pay zero cold-start cost.
 *
 * No `process.env.*` reads here: the env object threads through
 * to `start()`, which uses `requireWithFile` / `readWithFile` for
 * every var. The `no-feature-env-vars` ESLint rule (THREAT-MODEL
 * §2 invariant 9) is non-negotiable.
 *
 * # What this verb actually wires (PR-M2)
 *
 * `runServe` boots BOTH engines in sequence:
 *
 *   1. `engine-self-operating.start({env})` — the management
 *      server. Failure exits the process with code 2.
 *   2. `engine-ingestion.start({env, mode: 'workers',
 *      workerContext, workerConnection })` — production-mode
 *      ingestion engine. The composition root attempts to build
 *      a real `WorkerContext` (WikiAdapter via Gitea REST,
 *      LlmRouter via Vercel AI SDK, GuardAdapter via the regex
 *      catalog, SourceAdapterRegistry from live `sources_bindings`
 *      rows). On any composition error (missing GITEA_URL,
 *      ENCRYPTION_KEY, etc.) the factory falls back to
 *      `mode: 'probes-only'` with a clear stderr line — the
 *      management UI stays up and the operator can triage.
 *
 * Net effect after PR-M2: a freshly-booted `pnpm opencoo` against
 * a configured deployment dequeues webhook deliveries
 * automatically — webhook → `webhook_events` row → BullMQ scanner
 * job → ingestion_intake row → BullMQ compile job → wiki page
 * commit, all without operator intervention.
 *
 * The boot-tolerance for the ingestion side mirrors
 * engine-self-operating's admin-API gating pattern (env
 * incomplete → log + skip, don't crash the process).
 */
import type { EventEmitter } from "node:events";

import pc from "picocolors";

import { exitOk, exitRuntimeError, isExitSentinel } from "../lib/exit.js";

/** Narrow shape of the SseBus the orchestrator passes between
 *  engines. Defined by structural typing only — the engines'
 *  full SseBus type lives in engine-self-operating; the
 *  orchestrator threads the value as opaque so we don't drag the
 *  full bus surface across the no-cross-engine-import boundary
 *  (production-context.ts already declares the narrow
 *  `IngestionRunEventEmitter` shape).
 *
 *  Round-2 fix: the bus is the SAME instance the self-op engine
 *  built (via `Object.assign(baseEngine, { sseBus })` in
 *  engine-self-operating/start.ts). Threading it into the ingestion
 *  WorkerContext lets every per-job lifecycle event (compile,
 *  scanner, index-rebuild, cleanup) publish onto the Activity feed
 *  the operator already opens via `/api/admin/events`. */
export interface ServeSseBus {
  emitRunEvent(event: {
    readonly runId: string;
    readonly definitionSlug: string;
    readonly status: "running" | "success" | "failed" | "timeout";
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly errorMessage?: string;
  }): void;
}

/** Minimal `StartedEngine` shape consumed by `runServe`.
 *  Both engines satisfy it structurally; engine-self-operating
 *  additionally exposes `sseBus` (the bus it constructed at
 *  boot — round-2 fix #1) and `app` (the listening Fastify the
 *  ingestion engine mounts its webhook route onto — PR-Q6). */
export interface ServeStartedEngine {
  close(): Promise<void>;
  /** Round-2 fix #1 — only the self-op engine populates this.
   *  Engine-ingestion's StartedEngine omits the field; the
   *  orchestrator captures the self-op handle and forwards the
   *  bus into the ingestion factory below. */
  readonly sseBus?: ServeSseBus;
  /** PR-Q6 (phase-a appendix #9) — only the self-op engine
   *  populates this. Holds the listening FastifyInstance the
   *  scaffold built at boot. The orchestrator threads it into the
   *  ingestion factory as `sharedFastify` so the ingestion engine
   *  mounts `/webhooks/:bindingId` onto the SAME listener instead
   *  of binding a second `:8080` socket (architecture.md §12:
   *  "one process, one port, one container"). The field is typed
   *  `unknown` here so the engine's full FastifyInstance surface
   *  doesn't bleed across the orchestrator's no-cross-engine-import
   *  boundary — engine-ingestion narrows it back at consumption. */
  readonly app?: unknown;
}

/** Matches `start({env})` from `@opencoo/engine-self-operating`.
 *
 *  PR-N3 (phase-a appendix #6) extends the factory's input shape
 *  with optional `agentRunners` + `agentDefinitions`. The
 *  defaultStartFactory composes both via
 *  `tryComposeAgentRunnersBundleFromEnv` and threads them into
 *  `engine-self-operating.start({...})` so the AgentDispatcher
 *  boots with a populated registry. Tests pass their own
 *  factory and never hit the new wiring.
 *
 *  PR-Q6 fix-up (phase-a appendix #9): adds optional
 *  `preListenHooks` + `bodyLimit`. The orchestrator pre-composes
 *  the ingestion WorkerContext, builds a closure that mounts the
 *  webhook receiver onto the supplied Fastify, and threads it here
 *  so the parser + route registration lands BEFORE
 *  `app.listen()` (Fastify rejects `addContentTypeParser` once
 *  ready). `bodyLimit` is `WEBHOOK_BODY_LIMIT_BYTES` (5 MB) so 5-MB
 *  webhook deliveries don't 413 on Fastify's default 1-MB cap.
 *  Test mocks ignore both fields. */
export type ServeStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
  readonly preListenHooks?: ReadonlyArray<
    (app: unknown) => void | Promise<void>
  >;
  readonly bodyLimit?: number;
}) => Promise<ServeStartedEngine>;

/** Matches `start({env})` from `@opencoo/engine-ingestion`. The
 *  PR-M2 shape extends with a `stderr` channel so the production
 *  composition root can write fall-back-to-probes-only diagnostic
 *  lines without dragging the orchestrator's logging into this
 *  layer. Round-2 fix #1 adds `sseBus`: when self-op booted
 *  successfully, the orchestrator forwards its bus so ingestion
 *  worker run events publish onto the Activity feed. PR-Q6 adds
 *  `sharedFastify`: when self-op booted successfully, the
 *  orchestrator forwards its listening Fastify so the ingestion
 *  engine mounts its webhook route onto the SAME listener
 *  (architecture.md §12 — one process, one port).
 *
 *  PR-Q6 fix-up (phase-a appendix #9): adds optional `preflight` so
 *  the orchestrator can pass the pre-composed `WorkerContext` (built
 *  before self-op booted, used to construct the pre-listen mount
 *  hook) to the ingestion factory — avoiding double composition.
 *  Test factories ignore the field. */
export interface ServeIngestionPreflight {
  /** Pre-composed WorkerContext + underlying handles. The default
   *  ingestion factory `mod.start({mode:'workers', workerContext})`
   *  consumes this verbatim instead of re-composing.
   *
   *  Typed `unknown` here so the engine-ingestion's WorkerContext
   *  surface doesn't bleed across the orchestrator's
   *  no-cross-engine-import boundary. The default ingestion factory
   *  narrows back at the call site. */
  readonly composed: unknown;
}

export type ServeIngestionStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
  readonly stderr: { write: (s: string) => boolean };
  readonly sseBus?: ServeSseBus;
  readonly sharedFastify?: unknown;
  readonly preflight?: ServeIngestionPreflight;
}) => Promise<ServeStartedEngine>;

/** PR-Q6 fix-up (phase-a appendix #9) — pre-flight composition for
 *  the ingestion engine.
 *
 *  Runs BEFORE either engine boots so the orchestrator can:
 *    1. Compose the `WorkerContext` (pg.Pool + Redis + adapters +
 *       LlmRouter + CredentialStore).
 *    2. Build a closure `(app) => mountWebhookRoute(app, ctx)` that
 *       the orchestrator threads into self-op's
 *       `start({preListenHooks})` so the route + parser register
 *       BEFORE `app.listen()` (Fastify rejects post-listen
 *       `addContentTypeParser` with `FST_ERR_INSTANCE_ALREADY_STARTED`).
 *    3. Hand the same `composed` value to the ingestion factory so
 *       `mode:'workers'` reuses it instead of re-composing.
 *
 *  Returns `null` on composition failure (missing GITEA_PAT /
 *  ENCRYPTION_KEY / etc.). The orchestrator boots self-op WITHOUT
 *  the mount hook (no body-limit override either) and skips ingestion
 *  workers — the management UI stays up so the operator can fix env
 *  without restart.
 *
 *  Test mocks return `null` to bypass real composition. */
export interface ServeIngestionPreflightResult {
  readonly preflight: ServeIngestionPreflight;
  /** Pre-listen hook the orchestrator threads into self-op. Mounts
   *  `/webhooks/:bindingId` + the raw-buffer parser on the supplied
   *  Fastify. Caller MUST run this before `app.listen()`. */
  readonly mountHook: (app: unknown) => void | Promise<void>;
}

export type ServeIngestionPreflightFactory = (opts: {
  readonly env: Record<string, string | undefined>;
  readonly stderr: { write: (s: string) => boolean };
  readonly sseBus?: ServeSseBus;
}) => Promise<ServeIngestionPreflightResult | null>;

/** Subset of `EventEmitter` `runServe` consumes — `process`
 *  satisfies it; tests pass an `EventEmitter` to drive signals. */
export interface ServeSignalSource {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface ServeArgs {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to dynamic-import of `start`
   *  from `@opencoo/engine-self-operating`. */
  readonly startFactory?: ServeStartFactory;
  /** @internal Test seam — defaults to dynamic-import of `start`
   *  from `@opencoo/engine-ingestion`. PR-M1, phase-a appendix
   *  #5 — co-boot of the ingestion engine in the same process so
   *  webhook events actually get dequeued, classified, compiled,
   *  and persisted to Gitea automatically. */
  readonly startIngestionFactory?: ServeIngestionStartFactory;
  /** @internal Test seam — PR-Q6 fix-up (phase-a appendix #9).
   *  Defaults to the production composer. Test mocks for
   *  `startFactory` / `startIngestionFactory` skip preflight by
   *  default — they don't need it (their fakes don't bind ports
   *  or compose contexts). To exercise the preflight wiring
   *  explicitly, tests pass a stub that returns a synthetic
   *  preflight + mountHook. */
  readonly ingestionPreflightFactory?: ServeIngestionPreflightFactory;
  /** @internal Test seam — defaults to the Node `process` emitter. */
  readonly signalSource?: ServeSignalSource | EventEmitter;
  /** @internal Test seam — defaults to `exitOk`. Tests pass a
   *  `vi.fn()` to capture the code without halting the runner. */
  readonly exit?: (code: number) => void;
}

/** @internal Default `startFactory` — dynamic-imports the engine
 *  so the verb's cold-start cost is paid only on boot.
 *
 *  PR-N3 (phase-a appendix #6): also composes the production
 *  AgentRunnerRegistry via `tryComposeAgentRunnersBundleFromEnv`
 *  and threads it into `start({})` so the AgentDispatcher boots
 *  with populated runner closures. On any composition failure
 *  (missing `MCP_BEARER_TOKEN`, pg.Pool open failure, etc.) the
 *  helper logs `mcp_http.unavailable` and returns null; we then
 *  boot self-op with no runners — the management UI stays alive
 *  and the operator fixes the env without restart.
 *
 *  Resource ownership: when the bundle is composed, its `pgPool`
 *  is drained by the wrapped `close()` below AFTER the engine's
 *  own close runs. */
/** Minimal shape of the bundle the agent-runner composition
 *  produces. Defined here (structurally) so tests can substitute
 *  a fake bundle without dragging the real
 *  `production-composition.ts` import surface. */
interface AgentRunnersBundleLike {
  readonly runners: unknown;
  readonly definitions: unknown;
  readonly router: unknown;
  close(): Promise<void>;
}

/** Engine-start callable shape — narrowed to the fields
 *  `composeStartedEngineWithBundle` actually invokes. */
type EngineStartFn = (opts: {
  readonly env: Record<string, string | undefined>;
  readonly agentRunners?: unknown;
  readonly agentDefinitions?: unknown;
  readonly agentRouter?: unknown;
  readonly preListenHooks?: ReadonlyArray<
    (app: unknown) => void | Promise<void>
  >;
  readonly bodyLimit?: number;
}) => Promise<ServeStartedEngine>;

interface ComposeStartedEngineArgs {
  readonly env: Record<string, string | undefined>;
  readonly bundle: AgentRunnersBundleLike | null;
  readonly start: EngineStartFn;
  readonly preListenHooks?: ReadonlyArray<
    (app: unknown) => void | Promise<void>
  >;
  readonly bodyLimit?: number;
  /** Logger for the round-2 fix #3 boot-failure-close-failed
   *  warn line. */
  readonly logger: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** Round-2 fix #3 on PR #57 (Copilot review): exported helper so
 *  tests can drive the boot-tolerance path without
 *  dynamic-importing the real engine-self-operating package
 *  (which opens Postgres + Fastify + BullMQ at construction
 *  time). The helper:
 *
 *    1. Calls `start(...)` with the bundle's runners/router
 *       threaded through (only when the bundle is non-null).
 *    2. On `start()` rejection: closes the bundle (best-effort,
 *       logs `agent_runners.boot_failure_close_failed` on
 *       close-failure) BEFORE re-throwing the original boot
 *       error.
 *    3. On `start()` success: wraps `engine.close` so the
 *       bundle's pg.Pool drains AFTER the engine's own close on
 *       the SIGTERM path.
 *
 *  Without (2), a bundle's pg.Pool leaks when the engine itself
 *  fails to boot — observable as Postgres connections that
 *  never get released until the OS reaps the process. */
export async function composeStartedEngineWithBundle(
  args: ComposeStartedEngineArgs,
): Promise<ServeStartedEngine> {
  const { env, bundle, start, logger } = args;
  let engine: ServeStartedEngine;
  try {
    engine = await start({
      env,
      // Round-2 fix #1 on PR #57: thread the LlmRouter from the
      // bundle through into the AgentDispatcher. Without
      // `agentRouter`, the dispatcher's per-dispatch context falls
      // back to the empty-object cast at agent-dispatcher.ts:404
      // and the FIRST scheduled Heartbeat / Lint / Surfacer crashes
      // with `TypeError: ctx.router.generateObject is not a function`.
      ...(bundle !== null
        ? {
            agentRunners: bundle.runners,
            agentDefinitions: bundle.definitions,
            agentRouter: bundle.router,
          }
        : {}),
      // PR-Q6 fix-up (phase-a appendix #9): when the orchestrator
      // pre-composed an ingestion preflight, thread its mount hook
      // here so the webhook receiver registers BEFORE app.listen().
      // bodyLimit raises Fastify's default 1-MB cap to 5 MB so a
      // 4-MB webhook delivery doesn't 413 before the receiver's own
      // size guard runs.
      ...(args.preListenHooks !== undefined
        ? { preListenHooks: args.preListenHooks }
        : {}),
      ...(args.bodyLimit !== undefined ? { bodyLimit: args.bodyLimit } : {}),
    });
  } catch (err) {
    if (bundle !== null) {
      // Drain the bundle's pg.Pool BEFORE re-throwing so the
      // process can exit cleanly. Best-effort: a close-failure
      // here gets a separate warn so a stuck pool surfaces with
      // its own log line, then we re-throw the ORIGINAL boot
      // error so the caller (runServe) routes the right cause.
      await bundle.close().catch((closeErr: unknown) => {
        logger.warn("agent_runners.boot_failure_close_failed", {
          error:
            closeErr instanceof Error
              ? closeErr.message
              : String(closeErr),
        });
      });
    }
    throw err;
  }
  if (bundle === null) {
    return engine;
  }
  // Wrap close() so the runner bundle's pg.Pool drains after
  // the engine's own close on the SIGTERM path.
  const baseClose = engine.close.bind(engine);
  return Object.assign(engine, {
    async close(): Promise<void> {
      await baseClose();
      await bundle.close();
    },
  });
}

async function defaultStartFactory(opts: {
  readonly env: Record<string, string | undefined>;
  readonly preListenHooks?: ReadonlyArray<
    (app: unknown) => void | Promise<void>
  >;
  readonly bodyLimit?: number;
}): Promise<ServeStartedEngine> {
  const mod = await import("@opencoo/engine-self-operating");
  const composition = await import(
    "../provision/production-composition.js"
  );
  const sharedLogger = await import("@opencoo/shared/logger");
  // Compose runners before start() so the dispatcher boots
  // populated. Boot-tolerant: bundle === null → empty registry,
  // engine still boots, scheduled jobs no-op (with one failed
  // agent_runs row per dispatch surfacing the misconfig).
  //
  // PR-O3 (phase-a appendix #7): the bundle composition is now
  // async — `tryComposeAgentRunnersFromEnv` performs an outbound
  // MCP call to n8n-mcp at boot to populate the Surfacer template
  // catalog. composeStartedEngineWithBundle already awaits the
  // bundle.
  const bundle = await composition.tryComposeAgentRunnersBundleFromEnv({
    env: opts.env,
  });
  return composeStartedEngineWithBundle({
    env: opts.env,
    bundle,
    start: mod.start as unknown as EngineStartFn,
    logger: new sharedLogger.ConsoleLogger(),
    ...(opts.preListenHooks !== undefined
      ? { preListenHooks: opts.preListenHooks }
      : {}),
    ...(opts.bodyLimit !== undefined ? { bodyLimit: opts.bodyLimit } : {}),
  });
}

/** @internal Shape of the result `composition.composeProductionFromEnv`
 *  returns. Captured in module scope so the preflight + ingestion
 *  factories can refer to it without re-deriving the type. */
type IngestionComposedResult = Awaited<
  ReturnType<
    typeof import("../provision/production-composition.js")["composeProductionFromEnv"]
  >
>;

/** @internal Default ingestion preflight factory.
 *
 *  PR-Q6 (phase-a appendix #9) fix-up: pre-composes the WorkerContext
 *  BEFORE either engine boots, then returns a closure that mounts the
 *  webhook receiver onto a FastifyInstance.  The orchestrator threads
 *  the closure into self-op's `start({preListenHooks})` so the parser +
 *  route registration land BEFORE `app.listen()` (Fastify rejects
 *  post-listen `addContentTypeParser`). The composed `WorkerContext` is
 *  reused by the ingestion factory so we don't re-compose pg.Pool /
 *  Redis / adapters / LlmRouter twice.
 *
 *  Returns `null` on composition failure (missing GITEA_PAT /
 *  ENCRYPTION_KEY / etc.). Caller writes the diagnostic line to stderr
 *  and continues with probes-only ingestion. */
async function defaultIngestionPreflightFactory(opts: {
  readonly env: Record<string, string | undefined>;
  readonly stderr: { write: (s: string) => boolean };
  readonly sseBus?: ServeSseBus;
}): Promise<ServeIngestionPreflightResult | null> {
  const mod = await import("@opencoo/engine-ingestion");
  const composition = await import("../provision/production-composition.js");

  let composed: IngestionComposedResult;
  try {
    composed = await composition.composeProductionFromEnv({
      env: opts.env,
      ...(opts.sseBus !== undefined ? { sseBus: opts.sseBus } : {}),
    });
  } catch (err) {
    opts.stderr.write(
      pc.yellow(
        `opencoo: ingestion workers disabled (${describeError(err)}) — booting probes-only; webhook deliveries will queue in Redis until composition is fixed\n`,
      ),
    );
    return null;
  }

  // The mount hook closes over the composed WorkerContext. The
  // orchestrator runs this against the self-op Fastify before it
  // listens — `mountWebhookRoute` registers the route + raw-buffer
  // parser inside a Fastify plugin scope (so the parser does NOT
  // leak to the admin-API JSON parser at the root context).
  type FastifyInstanceLike = Parameters<typeof mod.mountWebhookRoute>[0];
  const mountHook = (app: unknown): void => {
    mod.mountWebhookRoute(app as FastifyInstanceLike, composed.workerContext);
  };

  return {
    preflight: { composed: composed as unknown },
    mountHook,
  };
}

/** @internal Default ingestion `startFactory`. PR-M2 (phase-a
 *  appendix #5): boots `engine-ingestion` in `mode: 'workers'`
 *  using a pre-composed `WorkerContext` from the preflight (PR-Q6
 *  fix-up, phase-a appendix #9). When no preflight was supplied
 *  (composition failed at preflight time, OR test-injected
 *  factories skipped preflight), falls back to `mode: 'probes-only'`
 *  with a clear stderr line — the management UI stays up.
 *
 *  The composition's pg.Pool + Redis are owned by the
 *  WorkerContext bundle; the engine's own pg/Redis factories are
 *  let alone (the engine's own pg.Pool services its Fastify
 *  health probes). The closer attached to the returned engine
 *  drains the composition resources after the workers stop. */
async function defaultIngestionStartFactory(opts: {
  readonly env: Record<string, string | undefined>;
  readonly stderr: { write: (s: string) => boolean };
  readonly sseBus?: ServeSseBus;
  readonly sharedFastify?: unknown;
  readonly preflight?: ServeIngestionPreflight;
}): Promise<ServeStartedEngine> {
  const mod = await import("@opencoo/engine-ingestion");

  // No preflight → probes-only fallback. The preflight factory
  // already wrote the failure reason to stderr; we just boot the
  // engine without workers so the management UI still has a peer.
  if (opts.preflight === undefined) {
    return mod.start({ env: opts.env });
  }

  const composed = opts.preflight.composed as IngestionComposedResult;

  // PR-Q6 (phase-a appendix #9): when the orchestrator passed the
  // self-op engine's listening Fastify, mount the webhook route +
  // workers onto it instead of binding a second :8080 listener.
  // Type cast: the orchestrator types the field as `unknown` so the
  // FastifyInstance surface doesn't bleed across the orchestrator's
  // no-cross-engine-import boundary; engine-ingestion's
  // `StartOptions.sharedFastify` is typed `FastifyInstance`, so we
  // narrow at the call site.
  type IngestionStartArgs = Parameters<typeof mod.start>[0];
  type SharedFastifyArg = NonNullable<
    NonNullable<IngestionStartArgs>["sharedFastify"]
  >;
  const sharedFastify =
    opts.sharedFastify === undefined
      ? undefined
      : (opts.sharedFastify as SharedFastifyArg);
  const engine = await mod.start({
    env: opts.env,
    mode: "workers",
    workerContext: composed.workerContext,
    workerConnection: composed.redisConnection,
    ...(sharedFastify !== undefined ? { sharedFastify } : {}),
  });

  // Wrap close() so SIGTERM drains the production composition
  // (BullMQ queue handle, pg.Pool, Redis) AFTER the workers stop.
  // The engine's own close() already calls workers.closeAll()
  // before its base shutdown; we only need to layer in the
  // composition's resource cleanup on top.
  const baseClose = engine.close.bind(engine);
  return {
    async close(): Promise<void> {
      await baseClose();
      // closeProducers releases the producer-side
      // ingestion.scanner.classify Queue handle the composition
      // opened. Best-effort.
      await composed.workerContext.closeProducers().catch(() => undefined);
      await Promise.all([
        composed.pgPool.end().catch(() => undefined),
        composed.redis
          .quit()
          .then(() => undefined)
          .catch(() => undefined),
      ]);
    },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Boot the engines and block until SIGTERM/SIGINT.
 *
 *  1. `startFactory({env})` opens engine-self-operating (Fastify
 *     listener + admin API + agent harness). Failures route
 *     through `exit(2)` with the upstream error to stderr.
 *  2. `startIngestionFactory({env})` opens engine-ingestion
 *     alongside. Failures here are LOGGED but don't abort — the
 *     operator still gets the management UI; the ingestion side
 *     re-attempts on next boot. (PR-M1 boot-tolerance: PR-M2
 *     adds production composition that completes the loop.)
 *  3. SIGTERM + SIGINT trigger graceful shutdown of BOTH engines
 *     in parallel: await `engine.close()` on each (ingestion
 *     drains BullMQ workers within the engine's 30s window),
 *     then `exit(0)`. Listeners are symmetrically removed in
 *     the shutdown path so test runs don't leak handlers.
 *  4. The returned promise resolves AFTER shutdown completes;
 *     tests await it to synchronise with the close path.
 */
export async function runServe(args: ServeArgs): Promise<void> {
  const startFactory = args.startFactory ?? defaultStartFactory;
  const startIngestionFactory =
    args.startIngestionFactory ?? defaultIngestionStartFactory;
  // PR-Q6 fix-up (phase-a appendix #9): preflight defaults to the
  // production composer ONLY when the caller did not supply test
  // factories. Tests that inject `startFactory` /
  // `startIngestionFactory` skip preflight by default — their fakes
  // don't bind ports or compose contexts, so the pre-listen-hook
  // dance has nothing to wire. To exercise the preflight wiring
  // explicitly, tests pass their own `ingestionPreflightFactory`.
  const isTestInjection =
    args.startFactory !== undefined ||
    args.startIngestionFactory !== undefined;
  const ingestionPreflightFactory =
    args.ingestionPreflightFactory ??
    (isTestInjection ? null : defaultIngestionPreflightFactory);
  const signalSource = args.signalSource ?? process;
  // Default exit routes 0 through `exitOk` and non-zero through
  // `exitRuntimeError`, matching the bin.ts catch behaviour.
  const exit =
    args.exit ??
    ((code: number): void => {
      if (code === 0) exitOk();
      else exitRuntimeError();
    });

  args.stdout.write(pc.dim("opencoo: starting...\n"));

  // PR-Q6 fix-up (phase-a appendix #9): pre-compose the ingestion
  // WorkerContext + build the webhook-mount hook BEFORE either
  // engine boots. The hook lives inside self-op's
  // `start({preListenHooks})` so the route + parser register
  // BEFORE `app.listen()` (Fastify rejects post-listen
  // `addContentTypeParser` with `FST_ERR_INSTANCE_ALREADY_STARTED`).
  // Returns null on composition failure — caller falls back to
  // probes-only ingestion.
  let preflight: ServeIngestionPreflightResult | null = null;
  if (ingestionPreflightFactory !== null) {
    try {
      preflight = await ingestionPreflightFactory({
        env: args.env,
        stderr: args.stderr,
      });
    } catch (err) {
      if (isExitSentinel(err)) throw err;
      // The preflight factory contract is to never throw — return
      // null on composition failure. A real throw here is a bug in
      // the factory; surface it to stderr and proceed without
      // workers. The management UI will still be reachable.
      args.stderr.write(
        pc.yellow(
          `opencoo: ingestion preflight threw (${describeError(err)}) — booting probes-only\n`,
        ),
      );
      preflight = null;
    }
  }

  // Webhook body limit + pre-listen hooks only thread through when
  // preflight produced a mount hook — otherwise self-op needs the
  // default 1-MB limit (and no hooks).
  //
  // 5 MB is mirrored from `WEBHOOK_BODY_LIMIT_BYTES` in
  // engine-ingestion's `webhook-receiver.ts`. Inlining (not importing)
  // avoids dragging the engine-ingestion module load into the
  // cold-path `opencoo --help` boot — the orchestrator stays the
  // single source of "what bodyLimit does Fastify get for the shared
  // listener", and the constant is an architectural decision (Q13)
  // that doesn't move. If WEBHOOK_BODY_LIMIT_BYTES ever changes,
  // both call sites update — surfaced by the integration test in
  // `engine-ingestion/tests/start-shared-mount-real.test.ts`.
  const SHARED_WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;
  let selfOpEngine: ServeStartedEngine;
  try {
    selfOpEngine = await startFactory({
      env: args.env,
      ...(preflight !== null
        ? {
            preListenHooks: [preflight.mountHook],
            bodyLimit: SHARED_WEBHOOK_BODY_LIMIT,
          }
        : {}),
    });
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(`opencoo: failed to start (${describeError(err)})\n`),
    );
    // Drain the preflight's pg.Pool / Redis / queue handles — the
    // engine never booted so nothing else owns them.
    if (preflight !== null) {
      const composed = preflight.preflight.composed as IngestionComposedResult;
      await composed.workerContext.closeProducers().catch(() => undefined);
      await Promise.all([
        composed.pgPool.end().catch(() => undefined),
        composed.redis
          .quit()
          .then(() => undefined)
          .catch(() => undefined),
      ]);
    }
    return exit(2);
  }

  // Co-boot engine-ingestion. Boot-tolerant — a composition
  // failure (missing GITEA_PAT / ENCRYPTION_KEY / etc.) drops the
  // ingestion engine into `mode: 'probes-only'` instead of
  // crashing the management UI. PR-M2 wires the production
  // WorkerContext that closes the webhook → wiki loop when env
  // is fully populated.
  //
  // Round-2 fix #1: forward the self-op engine's SseBus into the
  // ingestion factory so ingestion's WorkerContext.sseBus is the
  // SAME instance the management UI streams from. Without this
  // thread, ingestion run-lifecycle events (compile, scanner,
  // index-rebuild, cleanup) never reach the Activity feed even
  // though the PR-M1 sse-bridge has all the wiring on the
  // ingestion side.
  //
  // PR-Q6 fix-up: pass the preflight result through so the default
  // ingestion factory reuses the WorkerContext composed at preflight
  // time instead of re-composing pg.Pool / Redis / adapters.
  let ingestionEngine: ServeStartedEngine | undefined;
  try {
    ingestionEngine = await startIngestionFactory({
      env: args.env,
      stderr: args.stderr,
      ...(selfOpEngine.sseBus !== undefined
        ? { sseBus: selfOpEngine.sseBus }
        : {}),
      // PR-Q6 (phase-a appendix #9): forward the self-op engine's
      // listening Fastify so the ingestion engine knows NOT to bind
      // a second `:8080` socket (EADDRINUSE). The route itself was
      // already mounted by the pre-listen hook above.
      ...(selfOpEngine.app !== undefined
        ? { sharedFastify: selfOpEngine.app }
        : {}),
      ...(preflight !== null ? { preflight: preflight.preflight } : {}),
    });
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.yellow(
        `opencoo: ingestion engine did not boot (${describeError(err)}) — management UI is still up; webhook receiver is unavailable until next restart\n`,
      ),
    );
    // If the ingestion factory threw AFTER preflight composed
    // resources, the resources are now orphaned. Drain them best-
    // effort so the process can exit cleanly on later SIGTERM.
    if (preflight !== null) {
      const composed = preflight.preflight.composed as IngestionComposedResult;
      await composed.workerContext.closeProducers().catch(() => undefined);
      await Promise.all([
        composed.pgPool.end().catch(() => undefined),
        composed.redis
          .quit()
          .then(() => undefined)
          .catch(() => undefined),
      ]);
    }
    ingestionEngine = undefined;
  }

  args.stdout.write(pc.green("opencoo: started\n"));

  /** Close one engine, logging (but swallowing) any close error so
   *  the sibling engine still gets to drain. */
  const closeWithLog = (
    label: string,
    engine: ServeStartedEngine,
  ): Promise<void> =>
    engine.close().catch((err: unknown) => {
      args.stderr.write(
        pc.red(`opencoo: ${label} shutdown error (${describeError(err)})\n`),
      );
    });

  return new Promise<void>((resolve) => {
    // Memoise the OUTER dispatch — engine.close() is itself
    // idempotent (engine-scaffold start.ts:186-199), but two
    // SIGTERMs in <1ms must not write the "shutting down" line,
    // call exit(0), or resolve() twice.
    let closing: Promise<void> | undefined;
    const shutdown = (signal: "SIGTERM" | "SIGINT"): void => {
      if (closing !== undefined) return;
      args.stdout.write(
        pc.dim(`opencoo: ${signal} received, shutting down\n`),
      );
      signalSource.removeListener("SIGTERM", onSigterm);
      signalSource.removeListener("SIGINT", onSigint);
      // PR-Q6 (phase-a appendix #9): close in series, ingestion
      // FIRST. Two reasons:
      //   1. The ingestion engine drains its BullMQ workers + the
      //      composition's pg.Pool / Redis. If the self-op engine
      //      closes first, the SHARED Fastify listener disappears
      //      mid-request from any in-flight `/webhooks/:bindingId`
      //      POST and an in-flight worker job's UPDATE against the
      //      shared pg.Pool throws.
      //   2. Engine-ingestion's `close()` is a no-op on the shared
      //      listener (the self-op engine OWNS the listener).
      //      Self-op's `close()` then drops the listener cleanly.
      // Each engine's close() is internally idempotent; closeAll on
      // the workers handle (when present) drains BullMQ within a
      // 30s window.
      closing = (async (): Promise<void> => {
        if (ingestionEngine !== undefined) {
          await closeWithLog("ingestion", ingestionEngine);
        }
        await closeWithLog("self-op", selfOpEngine);
      })()
        .finally(() => {
          exit(0);
          resolve();
        });
    };
    const onSigterm = (): void => shutdown("SIGTERM");
    const onSigint = (): void => shutdown("SIGINT");
    signalSource.on("SIGTERM", onSigterm);
    signalSource.on("SIGINT", onSigint);
  });
}
