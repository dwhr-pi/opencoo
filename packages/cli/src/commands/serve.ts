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
 *  boot — round-2 fix #1). */
export interface ServeStartedEngine {
  close(): Promise<void>;
  /** Round-2 fix #1 — only the self-op engine populates this.
   *  Engine-ingestion's StartedEngine omits the field; the
   *  orchestrator captures the self-op handle and forwards the
   *  bus into the ingestion factory below. */
  readonly sseBus?: ServeSseBus;
}

/** Matches `start({env})` from `@opencoo/engine-self-operating`. */
export type ServeStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
}) => Promise<ServeStartedEngine>;

/** Matches `start({env})` from `@opencoo/engine-ingestion`. The
 *  PR-M2 shape extends with a `stderr` channel so the production
 *  composition root can write fall-back-to-probes-only diagnostic
 *  lines without dragging the orchestrator's logging into this
 *  layer. Round-2 fix #1 adds `sseBus`: when self-op booted
 *  successfully, the orchestrator forwards its bus so ingestion
 *  worker run events publish onto the Activity feed. */
export type ServeIngestionStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
  readonly stderr: { write: (s: string) => boolean };
  readonly sseBus?: ServeSseBus;
}) => Promise<ServeStartedEngine>;

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
  /** @internal Test seam — defaults to the Node `process` emitter. */
  readonly signalSource?: ServeSignalSource | EventEmitter;
  /** @internal Test seam — defaults to `exitOk`. Tests pass a
   *  `vi.fn()` to capture the code without halting the runner. */
  readonly exit?: (code: number) => void;
}

/** @internal Default `startFactory` — dynamic-imports the engine
 *  so the verb's cold-start cost is paid only on boot. */
async function defaultStartFactory(opts: {
  readonly env: Record<string, string | undefined>;
}): Promise<ServeStartedEngine> {
  const mod = await import("@opencoo/engine-self-operating");
  return mod.start({ env: opts.env });
}

/** @internal Default ingestion `startFactory`. PR-M2 (phase-a
 *  appendix #5): attempts to compose a production WorkerContext
 *  (WikiAdapter + LlmRouter + GuardAdapter +
 *  SourceAdapterRegistry from env) and boots
 *  engine-ingestion in `mode: 'workers'`. On composition failure
 *  (missing GITEA_URL / GITEA_PAT / ENCRYPTION_KEY, etc.) falls
 *  back to `mode: 'probes-only'` with a clear stderr line — the
 *  management UI stays up and the operator can fix the env
 *  without restarting the management server.
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
}): Promise<ServeStartedEngine> {
  const mod = await import("@opencoo/engine-ingestion");
  const composition = await import("../provision/production-composition.js");

  // Try to compose the production WorkerContext. On any failure
  // we fall back to probes-only — the operator gets the webhook
  // receiver + management UI, and the failure log line names
  // the missing ingredient.
  //
  // Round-2 fix #1: forward the self-op SseBus into the
  // composition so the WorkerContext.sseBus is the SAME instance
  // the management UI streams from. Without this thread, the
  // PR-M1 sse-bridge has no bus to emit on and ingestion
  // run-lifecycle events never reach the Activity feed.
  type Composed = Awaited<ReturnType<typeof composition.composeProductionFromEnv>>;
  let composed: Composed;
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
    // Fall back to probes-only — webhook receiver up, no Workers.
    return mod.start({ env: opts.env });
  }

  const engine = await mod.start({
    env: opts.env,
    mode: "workers",
    workerContext: composed.workerContext,
    workerConnection: composed.redisConnection,
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
  let selfOpEngine: ServeStartedEngine;
  try {
    selfOpEngine = await startFactory({ env: args.env });
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(`opencoo: failed to start (${describeError(err)})\n`),
    );
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
  let ingestionEngine: ServeStartedEngine | undefined;
  try {
    ingestionEngine = await startIngestionFactory({
      env: args.env,
      stderr: args.stderr,
      ...(selfOpEngine.sseBus !== undefined
        ? { sseBus: selfOpEngine.sseBus }
        : {}),
    });
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.yellow(
        `opencoo: ingestion engine did not boot (${describeError(err)}) — management UI is still up; webhook receiver is unavailable until next restart\n`,
      ),
    );
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
      // Close both engines in parallel — each engine's close()
      // is internally idempotent; closeAll on the workers handle
      // (when present) drains BullMQ within a 30s window.
      const closes: Promise<void>[] = [closeWithLog("self-op", selfOpEngine)];
      if (ingestionEngine !== undefined) {
        closes.push(closeWithLog("ingestion", ingestionEngine));
      }
      closing = Promise.all(closes)
        .then(() => undefined)
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
