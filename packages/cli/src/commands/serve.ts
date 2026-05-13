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
 *  Test mocks ignore both fields.
 *
 *  PR-W1 (phase-a appendix #11): adds optional `deleteCap` +
 *  `forgetJobEnqueuer` so the source-forget admin route stops
 *  returning 503 in production. Both originate from the ingestion
 *  preflight composition (so the cap instance is shared with the
 *  compiler workers — single-process v0.1 shape). Test mocks
 *  ignore both fields. */
export type ServeStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
  readonly preListenHooks?: ReadonlyArray<
    (app: unknown) => void | Promise<void>
  >;
  readonly bodyLimit?: number;
  /** PR-W1 (phase-a appendix #11) — `deleteCap` instance from the
   *  ingestion preflight, threaded into self-op so the admin-API
   *  forget route reads the SAME budget the compiler workers
   *  reserve against. Typed `unknown` so the orchestrator stays on
   *  the no-cross-engine-import side; the default factory narrows
   *  back to `DeleteCap` at the engine boundary. */
  readonly deleteCap?: unknown;
  /** PR-W1 (phase-a appendix #11) — composition-built forget
   *  enqueuer from the ingestion preflight. Same typed-unknown
   *  treatment as `deleteCap`. */
  readonly forgetJobEnqueuer?: unknown;
  /** PR-Z4 (phase-a appendix #12 G5) — output-channel registry
   *  from the ingestion preflight. Same typed-unknown treatment
   *  as `deleteCap` — orchestrator stays on the
   *  no-cross-engine-import side; the default factory narrows
   *  back to `OutputChannelRegistry` at the engine boundary. */
  readonly outputChannels?: unknown;
  /** PR-Z4 — output-adapter descriptor map. Threaded into the
   *  admin-API Outputs-tab CRUD routes so the schema-driven form
   *  rendering works. Same typed-unknown treatment as
   *  `outputChannels`. */
  readonly outputChannelDescriptors?: unknown;
  /** PR-Z3 (phase-a appendix #12) — composition-built scanner Queue
   *  handle (the SAME `ingestion.scanner` Queue the workers consume).
   *  Threaded into self-op so the admin-API source-bindings POST
   *  handler can enqueue a post-create initial scan (closes G6) AND
   *  the `:id/scan-now` route can enqueue an on-demand scan
   *  (closes G8). Typed `unknown` to keep this layer on the
   *  no-cross-engine-import side; the engine narrows back at
   *  consumption. */
  readonly scannerQueue?: unknown;
  /** PR-W1 (phase-a appendix #13) — composition-built worldview-
   *  compile queue handle. Threaded into self-op so the admin-API
   *  `POST /api/admin/domains/:slug/recompile-worldview` route can
   *  enqueue against the SAME backlog the worldview-compile worker
   *  reads. Typed `unknown` for the no-cross-engine-import boundary. */
  readonly worldviewQueue?: unknown;
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
  /** PR-W1 (phase-a appendix #11) — the composition-built
   *  `InMemoryDeleteCap` instance the workers reserve against. The
   *  orchestrator forwards this verbatim into self-op's `start()`
   *  so the admin-API forget route reads the SAME budget. Typed
   *  `unknown` to keep this layer on the no-cross-engine-import
   *  side; the engine narrows back to `DeleteCap` at consumption.
   *  Optional for backward-compat with test factories that don't
   *  bother synthesising a cap (the orchestrator omits the field
   *  on the start call when undefined). */
  readonly deleteCap?: unknown;
  /** PR-W1 (phase-a appendix #11) — composition-built forget
   *  enqueuer. Same typed-unknown treatment as `deleteCap`. */
  readonly forgetJobEnqueuer?: unknown;
  /** PR-Z4 (phase-a appendix #12 G5) — composition-built
   *  OutputChannelRegistry the orchestrator forwards verbatim into
   *  self-op's `start({outputChannels})`. Typed `unknown` so the
   *  engine-self-operating surface doesn't bleed across the
   *  no-cross-engine-import boundary; the engine narrows back to
   *  `OutputChannelRegistry` at consumption. Optional for
   *  backward-compat with test factories that don't synthesise
   *  one. */
  readonly outputChannels?: unknown;
  /** PR-Z4 — composition-built descriptor map. Threaded into the
   *  admin-API Outputs-tab CRUD routes so the schema-driven form
   *  rendering works. Same typed-unknown treatment as
   *  `outputChannels`. */
  readonly outputChannelDescriptors?: unknown;
  /** PR-Z3 (phase-a appendix #12) — composition-built scanner Queue
   *  handle (BullMQ Queue on `ingestion.scanner`). The orchestrator
   *  threads this through to self-op via `start({scannerQueue})` so
   *  the admin-API source-bindings POST handler + `:id/scan-now`
   *  route can enqueue scans on the SAME queue the workers
   *  dequeue from. */
  readonly scannerQueue?: unknown;
  /** PR-W2 (phase-a appendix #14) — composition-built read-only
   *  enumerator over the `ingestion.scanner.classify` failed-set,
   *  filtered by payload bindingId (+ optional intakeId). Threaded
   *  into self-op via `start({failedClassifyJobsEnumerator})` so the
   *  `POST /api/admin/source-bindings/:id/retry-failed` route can
   *  list failed jobs without learning about BullMQ.
   *
   *  Typed `unknown` to keep this layer on the no-cross-engine-import
   *  side; the engine narrows back at consumption. Optional for
   *  backward-compat with test factories that don't synthesise it. */
  readonly failedClassifyJobsEnumerator?: unknown;
  /** PR-W2 (phase-a appendix #14) — companion enqueuer the retry
   *  route hands the original payloads to. Threaded into self-op via
   *  `start({classifyJobEnqueuer})`. Same typed-unknown treatment. */
  readonly classifyJobEnqueuer?: unknown;
  /** PR-W1 (phase-a appendix #13) — composition-built worldview-
   *  compile bundle. Carries the producer queue + worker + safety-net
   *  cron. The orchestrator threads `bundle.queue` into self-op via
   *  `start({worldviewQueue})` and awaits `bundle.close()` on SIGTERM
   *  AFTER the engine's own close runs. Optional for backward-compat
   *  with test factories that don't synthesise the bundle. */
  readonly worldviewBundle?: {
    readonly queue: {
      add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
    };
    close(): Promise<void>;
  };
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
  /** PR-W1 (phase-a appendix #11) — passed verbatim into
   *  `engine-self-operating.start({deleteCap})`. Typed `unknown`
   *  to keep this layer on the no-cross-engine-import side. */
  readonly deleteCap?: unknown;
  readonly forgetJobEnqueuer?: unknown;
  readonly outputChannels?: unknown;
  readonly outputChannelDescriptors?: unknown;
  /** PR-Z3 (phase-a appendix #12) — passed verbatim into
   *  `engine-self-operating.start({ingestionQueue})` so the admin-API
   *  POST source-bindings handler + `:id/scan-now` route can enqueue
   *  scans against the workers' queue. */
  readonly ingestionQueue?: unknown;
  /** PR-W2 (phase-a appendix #14) — passed verbatim into self-op so
   *  the retry-failed admin-API route can enumerate failed classify
   *  jobs and re-enqueue them. */
  readonly failedClassifyJobsEnumerator?: unknown;
  readonly classifyJobEnqueuer?: unknown;
  /** PR-W1 (phase-a appendix #13) — passed verbatim into
   *  `engine-self-operating.start({worldviewQueue})` so the admin-API
   *  recompile-worldview route can enqueue against the same backlog
   *  the worker reads. */
  readonly worldviewQueue?: unknown;
}) => Promise<ServeStartedEngine>;

interface ComposeStartedEngineArgs {
  readonly env: Record<string, string | undefined>;
  readonly bundle: AgentRunnersBundleLike | null;
  readonly start: EngineStartFn;
  readonly preListenHooks?: ReadonlyArray<
    (app: unknown) => void | Promise<void>
  >;
  readonly bodyLimit?: number;
  /** PR-W1 (phase-a appendix #11) — forwarded verbatim into
   *  `engine-self-operating.start({deleteCap, forgetJobEnqueuer})`
   *  so the source-forget admin route stops 503'ing in production. */
  readonly deleteCap?: unknown;
  readonly forgetJobEnqueuer?: unknown;
  /** PR-Z4 (phase-a appendix #12 G5) — forwarded verbatim into
   *  `engine-self-operating.start({outputChannels})` so the
   *  AgentDispatcher's post-run delivery hook reaches the
   *  operator-bound channels. */
  readonly outputChannels?: unknown;
  /** PR-Z4 — descriptor map for the admin-API Outputs-tab CRUD
   *  routes. */
  readonly outputChannelDescriptors?: unknown;
  /** PR-Z3 (phase-a appendix #12) — forwarded verbatim into
   *  `engine-self-operating.start({ingestionQueue})` so the
   *  admin-API source-bindings POST + `:id/scan-now` routes can
   *  enqueue against the workers' queue. */
  readonly scannerQueue?: unknown;
  /** PR-W2 (phase-a appendix #14) — forwarded verbatim into self-op
   *  so the retry-failed admin-API route stops returning 503.
   *  Same typed-unknown pattern as the other queue handles. */
  readonly failedClassifyJobsEnumerator?: unknown;
  readonly classifyJobEnqueuer?: unknown;
  /** PR-W1 (phase-a appendix #13) — forwarded verbatim into
   *  `engine-self-operating.start({worldviewQueue})` so the
   *  admin-API recompile-worldview route stops returning 503. */
  readonly worldviewQueue?: unknown;
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
      // PR-W1 (phase-a appendix #11) — wire the source-forget
      // admin-route deps. When the orchestrator pre-composed an
      // ingestion preflight, `args.deleteCap` is the SAME instance
      // the workers' `wikiWrite` reservations target (single-process
      // v0.1) and `args.forgetJobEnqueuer` is the BullMQ-backed
      // callable that turns the route's plan into recompile + delete
      // jobs. When preflight returned null, both are undefined and
      // the route returns 503 — same boot-tolerance pattern as the
      // rest of the admin API.
      ...(args.deleteCap !== undefined ? { deleteCap: args.deleteCap } : {}),
      ...(args.forgetJobEnqueuer !== undefined
        ? { forgetJobEnqueuer: args.forgetJobEnqueuer }
        : {}),
      // PR-Z4 (phase-a appendix #12 G5) — forward the composition's
      // OutputChannelRegistry. When preflight returned null,
      // `args.outputChannels` is undefined and the dispatcher's
      // post-run delivery hook is a no-op (boot-tolerance).
      ...(args.outputChannels !== undefined
        ? { outputChannels: args.outputChannels }
        : {}),
      ...(args.outputChannelDescriptors !== undefined
        ? { outputChannelDescriptors: args.outputChannelDescriptors }
        : {}),
      // PR-Z3 (phase-a appendix #12) — wire the writable
      // `ingestion.scanner` queue handle from the preflight into
      // self-op. The admin-API's source-bindings POST handler uses
      // it to fire an initial scan immediately after a binding is
      // created (closes G6); the new `:id/scan-now` endpoint uses
      // it to fire on-demand scans (closes G8). When preflight
      // returned null, `args.scannerQueue` is undefined and both
      // surfaces no-op (POST returns 201 normally; scan-now → 503).
      ...(args.scannerQueue !== undefined
        ? { ingestionQueue: args.scannerQueue }
        : {}),
      // PR-W2 (phase-a appendix #14) — wire the retry-failed
      // surface. Both callables close over the SAME
      // `ingestion.scanner.classify` Queue the worker context's
      // `enqueue` writes onto. When preflight returned null, both
      // are undefined and `POST /api/admin/source-bindings/:id/retry-failed`
      // returns 503 (boot-tolerance).
      ...(args.failedClassifyJobsEnumerator !== undefined
        ? { failedClassifyJobsEnumerator: args.failedClassifyJobsEnumerator }
        : {}),
      ...(args.classifyJobEnqueuer !== undefined
        ? { classifyJobEnqueuer: args.classifyJobEnqueuer }
        : {}),
      // PR-W1 (phase-a appendix #13) — wire the worldview-compile
      // queue handle. When preflight returned null, the bundle is
      // undefined and the admin-API recompile-worldview route
      // returns 503 (boot-tolerance).
      ...(args.worldviewQueue !== undefined
        ? { worldviewQueue: args.worldviewQueue }
        : {}),
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
  readonly deleteCap?: unknown;
  readonly forgetJobEnqueuer?: unknown;
  readonly outputChannels?: unknown;
  readonly outputChannelDescriptors?: unknown;
  /** PR-Z3 (phase-a appendix #12) — scanner Queue handle threaded
   *  through to self-op for the source-bindings POST + scan-now
   *  routes. */
  readonly scannerQueue?: unknown;
  /** PR-W2 (phase-a appendix #14) — retry-failed callables threaded
   *  through to self-op for the retry-failed admin route. */
  readonly failedClassifyJobsEnumerator?: unknown;
  readonly classifyJobEnqueuer?: unknown;
  /** PR-W1 (phase-a appendix #13) — worldview-compile queue handle
   *  threaded through to self-op for the recompile-worldview route. */
  readonly worldviewQueue?: unknown;
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
    // PR-W1 (phase-a appendix #11) — forward the preflight-built
    // deleteCap + forgetJobEnqueuer into the engine so the admin
    // API's source-forget route stops 503'ing.
    ...(opts.deleteCap !== undefined ? { deleteCap: opts.deleteCap } : {}),
    ...(opts.forgetJobEnqueuer !== undefined
      ? { forgetJobEnqueuer: opts.forgetJobEnqueuer }
      : {}),
    // PR-Z4 (phase-a appendix #12 G5) — forward the preflight-built
    // OutputChannelRegistry into the engine so post-run delivery
    // reaches operator-bound channels (heartbeat → Asana, etc.).
    ...(opts.outputChannels !== undefined
      ? { outputChannels: opts.outputChannels }
      : {}),
    ...(opts.outputChannelDescriptors !== undefined
      ? { outputChannelDescriptors: opts.outputChannelDescriptors }
      : {}),
    // PR-Z3 (phase-a appendix #12) — forward the preflight-built
    // scanner queue handle into the engine so the admin-API
    // source-bindings POST + `:id/scan-now` routes can enqueue
    // against the SAME queue the workers dequeue from.
    ...(opts.scannerQueue !== undefined
      ? { scannerQueue: opts.scannerQueue }
      : {}),
    // PR-W2 (phase-a appendix #14) — forward the preflight-built
    // retry-failed callables into the engine so the admin-API
    // retry-failed route can enumerate + re-enqueue failed classify
    // jobs.
    ...(opts.failedClassifyJobsEnumerator !== undefined
      ? { failedClassifyJobsEnumerator: opts.failedClassifyJobsEnumerator }
      : {}),
    ...(opts.classifyJobEnqueuer !== undefined
      ? { classifyJobEnqueuer: opts.classifyJobEnqueuer }
      : {}),
    // PR-W1 (phase-a appendix #13) — forward the preflight-built
    // worldview-compile queue handle into the engine so the admin-API
    // recompile-worldview route can enqueue against the SAME queue
    // the worldview worker reads.
    ...(opts.worldviewQueue !== undefined
      ? { worldviewQueue: opts.worldviewQueue }
      : {}),
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
    // PR-W1 (phase-a appendix #11) — surface the composition's
    // `deleteCap` + `forgetJobEnqueuer` so the orchestrator can
    // forward them into self-op's `start({})`. Without these, the
    // admin-API source-forget route returns 503 in production
    // (the bug the wave-end Chrome QA caught: clicking "Forget
    // source" → "Nie udało się załadować wpływu").
    deleteCap: composed.deleteCap as unknown,
    forgetJobEnqueuer: composed.forgetJobEnqueuer as unknown,
    // PR-Z4 (phase-a appendix #12 G5) — surface the composition's
    // OutputChannelRegistry so the orchestrator can forward it
    // into self-op's `start({outputChannels})`. Without this thread,
    // post-run delivery is a no-op even though the registry,
    // `output-asana`, and the channel CRUD all exist (the bug G5
    // captures: the daily-report-to-Asana path is 90% built but
    // not wired).
    outputChannels: composed.outputChannels as unknown,
    outputChannelDescriptors: composed.outputChannelDescriptors as unknown,
    // PR-Z3 (phase-a appendix #12) — surface the composition's
    // `ingestion.scanner` Queue handle so the orchestrator can
    // forward it into self-op's `start({scannerQueue})`. Without
    // this, the source-bindings POST handler's initial-scan
    // enqueue silently no-ops (binding still creates, just no
    // immediate scan) and `:id/scan-now` returns 503.
    scannerQueue: composed.scannerQueue as unknown,
    // PR-W2 (phase-a appendix #14) — surface the composition's
    // retry-failed callables so the orchestrator can forward them
    // into self-op's `start({failedClassifyJobsEnumerator,
    // classifyJobEnqueuer})`. Without these the admin-API
    // retry-failed route returns 503.
    failedClassifyJobsEnumerator:
      composed.failedClassifyJobsEnumerator as unknown,
    classifyJobEnqueuer: composed.classifyJobEnqueuer as unknown,
    // PR-W1 (phase-a appendix #13) — surface the composition's
    // worldview compile bundle (producer queue + worker + safety-net
    // cron) so the orchestrator can forward `bundle.queue` into
    // self-op's `start({worldviewQueue})` AND drain the worker on
    // SIGTERM. Without this the admin-API recompile-worldview
    // endpoint returns 503 + the daily safety-net cron never
    // registers.
    worldviewBundle: composed.worldviewBundle,
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
      // Drain producer-side queues + pg.Pool + Redis the
      // composition opened. The engine's own close() already
      // ran workers.closeAll(); we only layer composition-owned
      // handles on top.
      await drainComposedResources(composed);
    },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** @internal Drain every resource the ingestion preflight composition
 *  owns, in shutdown order: producer-side queues first (so in-flight
 *  enqueues complete), then pg.Pool + Redis in parallel. Best-effort
 *  on every step — a single close failure must not prevent the
 *  remaining handles from draining. Used by every cleanup site
 *  in this file (engine close wrap, startFactory failure, ingestion
 *  factory failure) so the orchestration of "what does the
 *  composition own" lives in one place.
 *
 *  PR-W1 (phase-a appendix #11) added `closeForgetQueues` to the
 *  composition; centralising avoids fan-out across cleanup sites
 *  whenever the composition grows another producer-side handle. */
async function drainComposedResources(
  composed: IngestionComposedResult,
): Promise<void> {
  // closeProducers releases the ingestion.scanner.classify Queue
  // handle; closeForgetQueues releases wiki.recompile + wiki.delete;
  // worldviewBundle.close releases the worldview worker + queue.
  await composed.workerContext.closeProducers().catch(() => undefined);
  await composed.closeForgetQueues().catch(() => undefined);
  await composed.worldviewBundle.close().catch(() => undefined);
  await Promise.all([
    composed.pgPool.end().catch(() => undefined),
    composed.redis
      .quit()
      .then(() => undefined)
      .catch(() => undefined),
  ]);
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
      // PR-W1 (phase-a appendix #11) — forward the preflight's
      // forget deps (deleteCap + enqueuer) so the source-forget
      // admin route stops 503'ing in production. When preflight
      // returned null, both fields stay omitted and the route's
      // composition-incomplete branch surfaces (matching the rest
      // of the admin API's boot-tolerance pattern). Conditional
      // spread keeps undefined fields out of the call site to
      // satisfy `exactOptionalPropertyTypes`.
      ...(preflight?.deleteCap !== undefined
        ? { deleteCap: preflight.deleteCap }
        : {}),
      ...(preflight?.forgetJobEnqueuer !== undefined
        ? { forgetJobEnqueuer: preflight.forgetJobEnqueuer }
        : {}),
      // PR-Z4 (phase-a appendix #12 G5) — forward the preflight's
      // OutputChannelRegistry so the AgentDispatcher's post-run
      // delivery hook reaches operator-bound channels. Mirrors the
      // deleteCap / forgetJobEnqueuer pattern above: when preflight
      // returned null, the field stays omitted and the dispatcher's
      // delivery hook is a no-op (boot-tolerance).
      ...(preflight?.outputChannels !== undefined
        ? { outputChannels: preflight.outputChannels }
        : {}),
      ...(preflight?.outputChannelDescriptors !== undefined
        ? { outputChannelDescriptors: preflight.outputChannelDescriptors }
        : {}),
      // PR-Z3 (phase-a appendix #12) — forward the preflight's
      // scanner Queue handle so the source-bindings POST + scan-now
      // routes can enqueue against the SAME queue the workers
      // dequeue from. When preflight returned null, the field stays
      // omitted and the route surfaces 503 (composition-incomplete).
      ...(preflight?.scannerQueue !== undefined
        ? { scannerQueue: preflight.scannerQueue }
        : {}),
      // PR-W2 (phase-a appendix #14) — forward the preflight's
      // retry-failed callables so the admin-API retry-failed route
      // can enumerate + re-enqueue failed classify jobs. Same
      // boot-tolerance pattern: when preflight returned null, both
      // fields stay omitted and the route returns 503.
      ...(preflight?.failedClassifyJobsEnumerator !== undefined
        ? { failedClassifyJobsEnumerator: preflight.failedClassifyJobsEnumerator }
        : {}),
      ...(preflight?.classifyJobEnqueuer !== undefined
        ? { classifyJobEnqueuer: preflight.classifyJobEnqueuer }
        : {}),
      // PR-W1 (phase-a appendix #13) — forward the preflight's
      // worldview-compile queue handle so the admin-API
      // recompile-worldview route can enqueue. Mirrors the
      // scannerQueue pattern above.
      ...(preflight?.worldviewBundle !== undefined
        ? { worldviewQueue: preflight.worldviewBundle.queue }
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
      await drainComposedResources(
        preflight.preflight.composed as IngestionComposedResult,
      );
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
      await drainComposedResources(
        preflight.preflight.composed as IngestionComposedResult,
      );
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
