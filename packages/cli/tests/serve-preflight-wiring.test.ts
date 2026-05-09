/**
 * PR-Q6 fix-up (phase-a appendix #9) — preflight wiring for the
 * shared-Fastify-mount orchestration.
 *
 * The reviewer flagged on PR #72 that the first-pass shared-mount
 * path called `mountWebhookRoute(sharedFastify, ctx)` from inside
 * engine-ingestion's `start()`, which runs AFTER self-op's
 * `app.listen()` — Fastify rejects post-listen
 * `addContentTypeParser` with `FST_ERR_INSTANCE_ALREADY_STARTED`.
 *
 * The fix routes the mount through a pre-listen hook on self-op's
 * `start()`. This requires the orchestrator to compose the
 * ingestion's `WorkerContext` BEFORE self-op boots so the hook
 * closure has the context it needs.
 *
 * These tests pin the preflight wiring contract:
 *
 *   1. `runServe` calls `ingestionPreflightFactory` BEFORE
 *      `startFactory`.
 *   2. The preflight's `mountHook` is threaded into `startFactory`
 *      as `preListenHooks`, and `bodyLimit` is set so 5 MB webhook
 *      deliveries don't 413 on Fastify's default 1 MB cap.
 *   3. The preflight's `composed` value is forwarded verbatim to
 *      `startIngestionFactory` so it doesn't re-compose pg.Pool /
 *      Redis / adapters.
 *   4. When the preflight returns null (composition failed), the
 *      orchestrator boots self-op WITHOUT the hook + body-limit
 *      override, and the ingestion factory is invoked WITHOUT a
 *      `preflight` field — falls back to probes-only.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  runServe,
  type ServeArgs,
  type ServeIngestionPreflightResult,
} from "../src/commands/serve.js";

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

describe("runServe — ingestion preflight wiring (PR-Q6 fix-up)", () => {
  it("calls preflight FIRST, then forwards mountHook + bodyLimit to startFactory", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sharedApp = { __sentinel: "shared" };
    const selfOpEngine = { app: sharedApp, close: vi.fn(async () => undefined) };
    const ingestionEngine = { close: vi.fn(async () => undefined) };

    const callOrder: string[] = [];

    const mountHook = vi.fn();
    const composedSentinel = { __sentinel: "composed" };
    const preflightResult: ServeIngestionPreflightResult = {
      preflight: { composed: composedSentinel },
      mountHook,
    };

    const ingestionPreflightFactory = vi.fn(async () => {
      callOrder.push("preflight");
      return preflightResult;
    });
    const startFactory = vi.fn(async () => {
      callOrder.push("startFactory");
      return selfOpEngine as unknown as Awaited<
        ReturnType<NonNullable<ServeArgs["startFactory"]>>
      >;
    });
    const startIngestionFactory = vi.fn(async () => {
      callOrder.push("startIngestionFactory");
      return ingestionEngine as unknown as Awaited<
        ReturnType<NonNullable<ServeArgs["startIngestionFactory"]>>
      >;
    });
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      ingestionPreflightFactory,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    // Preflight ran BEFORE startFactory (the orchestrator can't
    // build the mount hook without first composing the
    // WorkerContext).
    expect(callOrder).toEqual([
      "preflight",
      "startFactory",
      "startIngestionFactory",
    ]);

    // startFactory received the mountHook + a bodyLimit. The
    // bodyLimit MUST be at least 5 MB — that's the receiver's own
    // cap and Fastify's default of 1 MB would 413 a 4 MB delivery
    // before the receiver's own size guard runs.
    const startCall = startFactory.mock.calls[0]?.[0] as {
      readonly preListenHooks?: ReadonlyArray<unknown>;
      readonly bodyLimit?: number;
    };
    expect(startCall.preListenHooks).toBeDefined();
    expect(startCall.preListenHooks).toHaveLength(1);
    expect(startCall.preListenHooks?.[0]).toBe(mountHook);
    expect(startCall.bodyLimit).toBeGreaterThanOrEqual(5 * 1024 * 1024);

    // startIngestionFactory received the preflight verbatim —
    // identity comparison so a structural-clone (which would
    // double-compose pg.Pool/Redis) regresses loudly.
    const ingestionCall = startIngestionFactory.mock.calls[0]?.[0] as {
      readonly preflight?: { readonly composed: unknown };
    };
    expect(ingestionCall.preflight).toBeDefined();
    expect(ingestionCall.preflight?.composed).toBe(composedSentinel);

    signalSource.emit("SIGTERM");
    await serve;
  });

  it("preflight returning null → no preListenHooks + no bodyLimit + no preflight field on ingestion factory", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sharedApp = { __sentinel: "shared" };
    const selfOpEngine = { app: sharedApp, close: vi.fn(async () => undefined) };
    const ingestionEngine = { close: vi.fn(async () => undefined) };

    const ingestionPreflightFactory = vi.fn(async () => null);
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
      ingestionPreflightFactory,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    // No preflight → self-op boots with the default bodyLimit
    // (Fastify's 1 MB) and no pre-listen hooks. This is the
    // probes-only fallback.
    const startCall = startFactory.mock.calls[0]?.[0] as {
      readonly preListenHooks?: ReadonlyArray<unknown>;
      readonly bodyLimit?: number;
    };
    expect(startCall.preListenHooks).toBeUndefined();
    expect(startCall.bodyLimit).toBeUndefined();

    // No preflight → no `preflight` field on ingestion factory
    // input. The factory's null branch boots probes-only.
    const ingestionCall = startIngestionFactory.mock.calls[0]?.[0] as {
      readonly preflight?: unknown;
    };
    expect(ingestionCall.preflight).toBeUndefined();

    signalSource.emit("SIGTERM");
    await serve;
  });

  it("PR-W1: forwards preflight.deleteCap + preflight.forgetJobEnqueuer to startFactory", async () => {
    // Wave-end Chrome QA on 2026-05-09 caught that
    // `POST /api/admin/source-bindings/:id/forget` returned 503
    // `composition_incomplete` in production because the
    // orchestrator never threaded the cap + enqueuer from the
    // preflight composition into self-op's `start({})`. This test
    // pins the forwarding so a future regression breaks the
    // typecheck OR the test before it reaches a deployment.
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sharedApp = { __sentinel: "shared" };
    const selfOpEngine = { app: sharedApp, close: vi.fn(async () => undefined) };
    const ingestionEngine = { close: vi.fn(async () => undefined) };

    const mountHook = vi.fn();
    const composedSentinel = { __sentinel: "composed" };
    const deleteCapSentinel = { __sentinel: "deleteCap" };
    const forgetJobEnqueuerSentinel = vi.fn(async () => undefined);
    const preflightResult: ServeIngestionPreflightResult = {
      preflight: { composed: composedSentinel },
      mountHook,
      deleteCap: deleteCapSentinel,
      forgetJobEnqueuer: forgetJobEnqueuerSentinel,
    };

    const ingestionPreflightFactory = vi.fn(async () => preflightResult);
    const startFactory = vi.fn(async () => {
      return selfOpEngine as unknown as Awaited<
        ReturnType<NonNullable<ServeArgs["startFactory"]>>
      >;
    });
    const startIngestionFactory = vi.fn(async () => {
      return ingestionEngine as unknown as Awaited<
        ReturnType<NonNullable<ServeArgs["startIngestionFactory"]>>
      >;
    });
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      ingestionPreflightFactory,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    // Identity comparison — a structural-clone (or a stale
    // empty-object cap) would silently let a forget exceed the
    // per-domain daily limit.
    const startCall = startFactory.mock.calls[0]?.[0] as {
      readonly deleteCap?: unknown;
      readonly forgetJobEnqueuer?: unknown;
    };
    expect(startCall.deleteCap).toBe(deleteCapSentinel);
    expect(startCall.forgetJobEnqueuer).toBe(forgetJobEnqueuerSentinel);

    signalSource.emit("SIGTERM");
    await serve;
  });

  it("PR-W1: preflight returning null → no deleteCap + no forgetJobEnqueuer on startFactory", async () => {
    // Boot-tolerance: when preflight returns null (composition
    // failed — missing GITEA_PAT / ENCRYPTION_KEY / etc.) the
    // orchestrator MUST NOT pass undefined into the start factory's
    // `deleteCap`/`forgetJobEnqueuer` fields under
    // `exactOptionalPropertyTypes`. Conditional spread keeps the
    // fields absent so the engine boots without the wiring and the
    // route's 503 composition-incomplete branch surfaces (matching
    // the rest of the admin API's boot-tolerance pattern).
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sharedApp = { __sentinel: "shared" };
    const selfOpEngine = { app: sharedApp, close: vi.fn(async () => undefined) };
    const ingestionEngine = { close: vi.fn(async () => undefined) };

    const ingestionPreflightFactory = vi.fn(async () => null);
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
      ingestionPreflightFactory,
      startFactory,
      startIngestionFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    const startCall = startFactory.mock.calls[0]?.[0] as {
      readonly deleteCap?: unknown;
      readonly forgetJobEnqueuer?: unknown;
    };
    expect(startCall.deleteCap).toBeUndefined();
    expect(startCall.forgetJobEnqueuer).toBeUndefined();

    signalSource.emit("SIGTERM");
    await serve;
  });
});
