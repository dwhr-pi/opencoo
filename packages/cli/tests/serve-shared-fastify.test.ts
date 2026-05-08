/**
 * PR-Q6 (phase-a appendix #9) — shared Fastify mount.
 *
 * Both engines (`engine-self-operating` and `engine-ingestion`) read
 * `PORT` via `parseEnginePort` and default to 8080. Before this PR
 * the orchestrator booted them sequentially; the second
 * `app.listen()` collided on `:8080` with `EADDRINUSE` and the
 * webhook receiver was unreachable.
 *
 * The fix: a preflight step composes the ingestion `WorkerContext`
 * BEFORE either engine boots; the orchestrator threads the self-op
 * Fastify instance into the ingestion factory as `sharedFastify`,
 * and a pre-listen hook on the self-op engine mounts the ingestion
 * `/webhooks/:bindingId` route (+ encapsulated content-type parser)
 * onto the SHARED app BEFORE `app.listen()` fires — no second
 * listener, no parser collision with `/api/admin/*`. (Earlier
 * iterations of this docstring read "as `serverFactory`"; the
 * actual factory option is `sharedFastify`.)
 *
 * These tests pin three invariants:
 *
 *   1. The orchestrator passes the self-op `app` to the ingestion
 *      factory as `sharedFastify`.
 *   2. `runServe` resolves cleanly (no EADDRINUSE) when the
 *      ingestion engine is co-booted alongside the self-op engine.
 *   3. The close path drains the ingestion engine FIRST (workers +
 *      composition resources) and the self-op engine SECOND (which
 *      owns the shared listener) — the ingestion engine MUST NOT
 *      close the shared listener.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runServe, type ServeArgs } from "../src/commands/serve.js";

class CapturingStream {
  buffer = "";
  write = (s: string): boolean => {
    this.buffer += s;
    return true;
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** A sentinel object the test passes through as the self-op
 *  engine's `app`. The orchestrator should forward it verbatim
 *  to the ingestion factory. Identity comparison verifies the
 *  SAME instance reaches both ends, not a clone. */
function makeSharedFastifySentinel(): { readonly __sentinel: "shared-fastify" } {
  return { __sentinel: "shared-fastify" } as const;
}

describe("runServe — shared Fastify mount (PR-Q6)", () => {
  it("forwards the self-op `app` into the ingestion factory as `sharedFastify`", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sharedApp = makeSharedFastifySentinel();
    const selfOpEngine = {
      app: sharedApp,
      close: vi.fn(async () => undefined),
    };
    const ingestionEngine = { close: vi.fn(async () => undefined) };
    const startFactory = vi.fn(
      async () =>
        selfOpEngine as unknown as Awaited<
          ReturnType<NonNullable<ServeArgs["startFactory"]>>
        >,
    );
    const startIngestionFactory = vi.fn(
      async () =>
        ingestionEngine as unknown as Awaited<
          ReturnType<NonNullable<ServeArgs["startIngestionFactory"]>>
        >,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(startIngestionFactory).toHaveBeenCalledTimes(1);
    const ingestionCall = startIngestionFactory.mock.calls[0]?.[0] as {
      readonly sharedFastify?: typeof sharedApp;
    };
    // Identity comparison — a structural-equal clone would silently
    // route mounted routes to a different Fastify and the webhook
    // receiver would still be unreachable.
    expect(ingestionCall.sharedFastify).toBe(sharedApp);

    signalSource.emit("SIGTERM");
    await serve;
  });

  it("co-boot does not surface EADDRINUSE — both engines reach the close path", async () => {
    // This is the single-listener invariant. The orchestrator must
    // not call `app.listen()` twice on `:8080`. With the shared
    // mount the ingestion factory accepts the listening Fastify and
    // does NOT bind a new listener.
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sharedApp = makeSharedFastifySentinel();
    const selfOpEngine = {
      app: sharedApp,
      close: vi.fn(async () => undefined),
    };
    const ingestionEngine = { close: vi.fn(async () => undefined) };
    const startFactory = vi.fn(
      async () =>
        selfOpEngine as unknown as Awaited<
          ReturnType<NonNullable<ServeArgs["startFactory"]>>
        >,
    );
    const startIngestionFactory = vi.fn(
      async () =>
        ingestionEngine as unknown as Awaited<
          ReturnType<NonNullable<ServeArgs["startIngestionFactory"]>>
        >,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x", PORT: "8080" },
      stdout,
      stderr,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(startFactory).toHaveBeenCalledTimes(1);
    expect(startIngestionFactory).toHaveBeenCalledTimes(1);
    expect(stderr.buffer).not.toContain("ingestion engine did not boot");
    expect(stderr.buffer).not.toContain("EADDRINUSE");

    signalSource.emit("SIGTERM");
    await serve;

    expect(selfOpEngine.close).toHaveBeenCalledTimes(1);
    expect(ingestionEngine.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("close path drains ingestion BEFORE self-op (workers stop before the shared listener)", async () => {
    // Ordering: ingestion's `close()` drains BullMQ workers + the
    // composition's pg.Pool / Redis. Self-op's `close()` drops the
    // Fastify listener. If self-op closes first, an in-flight
    // worker job's UPDATE against the shared pg.Pool throws; the
    // shared listener also goes away from under the
    // /webhooks/:bindingId route mid-request. Workers must stop
    // first.
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sharedApp = makeSharedFastifySentinel();
    const closeOrder: string[] = [];
    const selfOpEngine = {
      app: sharedApp,
      close: vi.fn(async () => {
        // Settle the microtask the ingestion close() handed off to
        // ensure ordering reflects the awaited sequence rather than
        // resolution speed.
        await Promise.resolve();
        closeOrder.push("self-op");
      }),
    };
    const ingestionEngine = {
      close: vi.fn(async () => {
        await Promise.resolve();
        closeOrder.push("ingestion");
      }),
    };
    const startFactory = vi.fn(
      async () =>
        selfOpEngine as unknown as Awaited<
          ReturnType<NonNullable<ServeArgs["startFactory"]>>
        >,
    );
    const startIngestionFactory = vi.fn(
      async () =>
        ingestionEngine as unknown as Awaited<
          ReturnType<NonNullable<ServeArgs["startIngestionFactory"]>>
        >,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    signalSource.emit("SIGTERM");
    await serve;

    expect(closeOrder).toEqual(["ingestion", "self-op"]);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
