/**
 * PR-Y8 (phase-a appendix #14) — regression test #1 for the W2
 * retry-failed callable wiring gap.
 *
 * Layer under test: `productionServerFactory` → `registerAdminApi`.
 *
 * W2 (PR #131) added `POST /api/admin/source-bindings/:id/retry-failed`
 * which depends on two composition-supplied callables:
 *   - `failedClassifyJobsEnumerator`
 *   - `classifyJobEnqueuer`
 *
 * The route 503s with `error: "classify_queue_unavailable"` when
 * either is undefined. W2's own unit test passes them DIRECTLY into
 * `registerAdminApi` and so didn't catch the outer-layer wiring gap.
 *
 * This test pins that `productionServerFactory` (the production
 * server-factory used by `start.ts:595`) accepts both callables on
 * its args AND forwards them into the `registerAdminApi` call.
 * Mirrors the existing `forgetJobEnqueuer` wiring pattern.
 *
 * A second test file (`retry-failed-wiring-start.test.ts`) covers
 * the layer ABOVE: `StartOptions` → `productionServerFactory`. Split
 * into two files because each layer requires a different mock
 * topology — vi.mock is module-scoped and hoisted, so a single file
 * can't mock both layers simultaneously without one mock cancelling
 * the assertions of the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted spy — captured before module evaluation so the vi.mock
// factory below closes over the live reference. The factory replaces
// the real `registerAdminApi` so we can assert exactly which args
// `productionServerFactory` forwards into it.
const registerAdminApiSpy = vi.hoisted(() =>
  vi.fn(async () => undefined),
);

vi.mock("../../src/admin-api/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/admin-api/index.js")
  >("../../src/admin-api/index.js");
  return {
    ...actual,
    registerAdminApi: registerAdminApiSpy,
  };
});

import { ConsoleLogger } from "@opencoo/shared/logger";

import { productionServerFactory } from "../../src/composition/server-factory.js";
import type { GiteaClient } from "../../src/admin-api/auth.js";
import type { EngineConfig } from "../../src/config.js";
import type { ProbeMap } from "../../src/start.js";
import type { RetryableFailedJob } from "../../src/admin-api/routes/source-bindings.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeConfig(): EngineConfig {
  return {
    databaseUrl: "postgres://x",
    redisUrl: "redis://y",
    port: 8080,
    logLevel: "info",
    nodeEnv: "test",
  };
}

function fakeGitea(): GiteaClient {
  return {
    async whoami(): Promise<never> {
      throw new Error("test gitea — not invoked in this test");
    },
  };
}

function baseArgs(): Parameters<typeof productionServerFactory>[0] {
  const probes: ProbeMap = {
    postgres: async () => ({ ok: true }),
    redis: async () => ({ ok: true }),
  };
  return {
    probes,
    config: fakeConfig(),
    logger: silentLogger(),
    pgPool: {} as unknown as Parameters<
      typeof productionServerFactory
    >[0]["pgPool"],
    giteaClient: fakeGitea(),
    compositionEnv: {
      adminTeamSlug: "opencoo-admins",
      sessionHmacKey: Buffer.from("test-hmac-32-bytes-aaaaaaaaaaaaaa"),
      giteaBaseUrl: "https://gitea.test",
      llmDebugLog: false,
    },
  };
}

describe("PR-Y8 — productionServerFactory → registerAdminApi wiring", () => {
  beforeEach(() => {
    registerAdminApiSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards `failedClassifyJobsEnumerator` + `classifyJobEnqueuer` into registerAdminApi when both are supplied", async () => {
    const enumerate = vi.fn(
      async (): Promise<readonly RetryableFailedJob[]> => [],
    );
    const enqueue = vi.fn(async () => ({ id: "new-1" }));

    await productionServerFactory({
      ...baseArgs(),
      failedClassifyJobsEnumerator: enumerate,
      classifyJobEnqueuer: enqueue,
    });

    expect(registerAdminApiSpy).toHaveBeenCalledTimes(1);
    const args = registerAdminApiSpy.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).toBeDefined();
    // Verbatim identity — not a wrapper. Mirrors how
    // `forgetJobEnqueuer` round-trips through the same chain.
    expect(args["failedClassifyJobsEnumerator"]).toBe(enumerate);
    expect(args["classifyJobEnqueuer"]).toBe(enqueue);
  });

  it("omits both callables from registerAdminApi args when neither is supplied (boot-tolerance preserved)", async () => {
    await productionServerFactory(baseArgs());

    expect(registerAdminApiSpy).toHaveBeenCalledTimes(1);
    const args = registerAdminApiSpy.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).toBeDefined();
    // exactOptionalPropertyTypes — undefined-valued field is not the
    // same as omitted field; the conditional-spread pattern
    // (mirroring `forgetJobEnqueuer`) must keep the field off the
    // call site entirely. That's what lets the route's 503
    // boot-tolerance path engage in composition-incomplete
    // deployments (no Redis, no preflight, etc.).
    expect("failedClassifyJobsEnumerator" in args).toBe(false);
    expect("classifyJobEnqueuer" in args).toBe(false);
  });

  it("forwards independently — passing only the enumerator is allowed (degenerate, surfaces 503)", async () => {
    // The route's composition gate requires BOTH callables; passing
    // only one of them is composition-incomplete (the route still
    // 503s). But the productionServerFactory forwarding must NOT
    // drop a supplied callable just because its sibling is absent
    // — that asymmetry would mask diagnostic-class wiring bugs.
    const enumerate = vi.fn(
      async (): Promise<readonly RetryableFailedJob[]> => [],
    );

    await productionServerFactory({
      ...baseArgs(),
      failedClassifyJobsEnumerator: enumerate,
    });

    expect(registerAdminApiSpy).toHaveBeenCalledTimes(1);
    const args = registerAdminApiSpy.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args["failedClassifyJobsEnumerator"]).toBe(enumerate);
    expect("classifyJobEnqueuer" in args).toBe(false);
  });
});
