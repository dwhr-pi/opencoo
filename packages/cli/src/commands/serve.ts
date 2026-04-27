/**
 * `opencoo` (bare, no subcommand) — long-running boot verb
 * (architecture.md §14.5, plan radiant-diffie). Pure orchestration
 * around `start({env})` from `@opencoo/engine-self-operating`,
 * which opens the pg.Pool + ioredis + Fastify listener and binds
 * the host port. The engine module is dynamic-imported so other
 * verbs that don't need it pay zero cold-start cost.
 *
 * No `process.env.*` reads here: the env object threads through to
 * `start()`, which uses `requireWithFile` / `readWithFile` for
 * every var. The `no-feature-env-vars` ESLint rule (THREAT-MODEL
 * §2 invariant 9) is non-negotiable.
 */
import type { EventEmitter } from "node:events";

import pc from "picocolors";

import { exitOk, exitRuntimeError, isExitSentinel } from "../lib/exit.js";

/** Minimal `StartedEngine` shape consumed by `runServe`.
 *  `@opencoo/engine-self-operating` satisfies it structurally. */
export interface ServeStartedEngine {
  close(): Promise<void>;
}

/** Matches `start({env})` from `@opencoo/engine-self-operating`. */
export type ServeStartFactory = (opts: {
  readonly env: Record<string, string | undefined>;
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Boot the engine and block until SIGTERM/SIGINT.
 *
 *  1. `startFactory({env})` opens pg.Pool + ioredis + Fastify
 *     listener. Failures write the upstream `Error.message` to
 *     stderr (env-loader errors carry variable names but never
 *     values per `composition/env.ts`) and route through `exit(2)`,
 *     which defaults to `exitRuntimeError`.
 *  2. SIGTERM + SIGINT trigger graceful shutdown: await
 *     `engine.close()` then `exit(0)`. Listeners are symmetrically
 *     removed in the shutdown path so test runs don't leak
 *     handlers.
 *  3. The returned promise resolves AFTER shutdown completes; tests
 *     await it to synchronise with the close path.
 */
export async function runServe(args: ServeArgs): Promise<void> {
  const startFactory = args.startFactory ?? defaultStartFactory;
  const signalSource = args.signalSource ?? process;
  // Default exit routes 0 through `exitOk` and non-zero through
  // `exitRuntimeError`, matching the bin.ts catch behaviour. Tests
  // pass a `vi.fn()` to capture both paths uniformly.
  const exit =
    args.exit ??
    ((code: number): void => {
      if (code === 0) exitOk();
      else exitRuntimeError();
    });

  args.stdout.write(pc.dim("opencoo: starting...\n"));
  let engine: ServeStartedEngine;
  try {
    engine = await startFactory({ env: args.env });
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(pc.red(`opencoo: failed to start (${describeError(err)})\n`));
    return exit(2);
  }
  args.stdout.write(pc.green("opencoo: started\n"));

  return new Promise<void>((resolve) => {
    // Memoise the OUTER dispatch — engine.close() is itself
    // idempotent (engine-scaffold start.ts:186-199), but two
    // SIGTERMs in <1ms must not write the "shutting down" line,
    // call exit(0), or resolve() twice.
    let closing: Promise<void> | undefined;
    const shutdown = (signal: "SIGTERM" | "SIGINT"): void => {
      if (closing !== undefined) return;
      args.stdout.write(pc.dim(`opencoo: ${signal} received, shutting down\n`));
      signalSource.removeListener("SIGTERM", onSigterm);
      signalSource.removeListener("SIGINT", onSigint);
      closing = engine
        .close()
        .catch((err: unknown) => {
          args.stderr.write(pc.red(`opencoo: shutdown error (${describeError(err)})\n`));
        })
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
