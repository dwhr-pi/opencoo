/**
 * `createProductionAgentRunners` tests (PR-N3, phase-a appendix
 * #6). The registry maps each schedulable definition slug
 * (`heartbeat`, `lint`, `surfacer`) to an `AgentRunner` closure
 * the AgentDispatcher invokes per scheduled job.
 *
 * Load-bearing assertions:
 *   1. The registry resolves runners for `heartbeat`, `lint`, and
 *      `surfacer` (the v0.1 scheduled-class agents).
 *   2. Unknown slugs (`chat`, `builder`, `nope`) return undefined.
 *      Chat + Builder are on-demand and are NEVER in the
 *      scheduled registry per architecture §9.4.
 *   3. Each runner closure, when invoked, calls through to its
 *      backing `runHeartbeat` / `runLint` / `runSurfacer`
 *      function with the production deps (db, mcp, router,
 *      logger) threaded plus the per-call `AgentRunContext`.
 *
 * The closures are invoked with vitest spies on the runner
 * functions; we don't run a real LLM here — that lives in the
 * `*.real-llm.test.ts` files.
 */
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import {
  InMemoryQueuePauser,
  LlmRouter,
  type LlmProvider,
} from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  HEARTBEAT_DEFINITION,
  LINT_DEFINITION,
  SURFACER_DEFINITION,
  InMemoryMcpToolClient,
  type AgentRunContext,
} from "@opencoo/engine-self-operating";

import { createProductionAgentRunners } from "../src/provision/agent-runners.js";
import { tryComposeAgentRunnersFromEnv } from "../src/provision/production-composition.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeProvider(): LlmProvider {
  return {
    generate: async () => ({
      text: '{"version":"v1","summary":"x","alerts":[]}',
      tokensIn: 1,
      tokensOut: 1,
    }),
  };
}

function makeDeps(): Parameters<typeof createProductionAgentRunners>[0] {
  // The registry doesn't actually open Postgres or the LLM router
  // when constructing closures — it only captures references. The
  // runner is invoked later with a synthetic AgentRunContext; the
  // backing run* functions are spied so we never reach a real DB.
  const router = new LlmRouter({
    db: {} as never,
    env: {},
    logger: silentLogger(),
    pauser: new InMemoryQueuePauser(),
    provider: fakeProvider(),
  });
  const mcp = new InMemoryMcpToolClient();
  const definitions = new AgentDefinitionRegistry();
  definitions.register(HEARTBEAT_DEFINITION);
  definitions.register(LINT_DEFINITION);
  definitions.register(SURFACER_DEFINITION);
  return {
    db: {} as never,
    mcp,
    router,
    logger: silentLogger(),
    definitions,
    // Tests use the override path so the closure doesn't try to
    // hit Postgres for slug resolution — production paths leave
    // `domainSlug` undefined and let the closure resolve from
    // `ctx.instance.scopeDomainIds[0]`.
    domainSlug: "test-domain",
    availableTemplateSlugs: ["asana-comment", "drive-watch"],
  };
}

function fakeCtx(slug: string): AgentRunContext {
  return {
    definition: { slug } as unknown as AgentRunContext["definition"],
    instance: {
      id: "00000000-0000-0000-0000-000000000001",
      definitionSlug: slug,
      scopeDomainIds: ["00000000-0000-0000-0000-000000000099"],
      locale: "en",
    } as unknown as AgentRunContext["instance"],
    runId: "00000000-0000-0000-0000-000000000010",
    spotlightedMemory: [],
    router: {} as unknown as AgentRunContext["router"],
    logger: silentLogger(),
    callTool: async (_name, fn) => fn(),
    recordToolCall: () => undefined,
  };
}

describe("createProductionAgentRunners — registry resolution", () => {
  it("returns runners for the three scheduled-class agents (Surfacer included when availableTemplateSlugs is non-empty)", () => {
    const registry = createProductionAgentRunners(makeDeps());
    expect(registry.get("heartbeat")).toBeTypeOf("function");
    expect(registry.get("lint")).toBeTypeOf("function");
    expect(registry.get("surfacer")).toBeTypeOf("function");
  });

  it("returns undefined for on-demand agents (chat, builder)", () => {
    // Chat + Builder are intentionally NOT in the scheduled
    // registry — they're invoked on-demand from the admin API,
    // not the cron scheduler.
    const registry = createProductionAgentRunners(makeDeps());
    expect(registry.get("chat")).toBeUndefined();
    expect(registry.get("builder")).toBeUndefined();
  });

  it("returns undefined for an unknown slug", () => {
    const registry = createProductionAgentRunners(makeDeps());
    expect(registry.get("does-not-exist")).toBeUndefined();
    expect(registry.get("")).toBeUndefined();
  });

  // Round-2 fix #2 on PR #57: when `surfacerEnabled === false`
  // (orchestrator's signal that the template catalog is empty),
  // Surfacer must be OMITTED from the registry. Otherwise
  // scheduled Surfacer runs against an empty
  // `availableTemplateSlugs` and `runSurfacer` silently rejects
  // every candidate the LLM proposes — invisible failure.
  it("OMITS Surfacer when surfacerEnabled === false (round-2 fix #2)", () => {
    const registry = createProductionAgentRunners({
      ...makeDeps(),
      surfacerEnabled: false,
    });
    expect(registry.get("heartbeat")).toBeTypeOf("function");
    expect(registry.get("lint")).toBeTypeOf("function");
    expect(registry.get("surfacer")).toBeUndefined();
  });

  it("registers Surfacer when surfacerEnabled === true (default)", () => {
    const registry = createProductionAgentRunners({
      ...makeDeps(),
      surfacerEnabled: true,
    });
    expect(registry.get("surfacer")).toBeTypeOf("function");
  });
});

describe("createProductionAgentRunners — runner closures dispatch through", () => {
  it("the heartbeat runner invokes runHeartbeat with the production deps", async () => {
    // Spy via dynamic import + vi.spyOn so we can substitute
    // without replacing the production module wholesale.
    const heartbeatModule = await import(
      "@opencoo/engine-self-operating"
    );
    const spy = vi
      .spyOn(heartbeatModule, "runHeartbeat")
      .mockResolvedValue({
        version: "v1",
        summary: "spied",
        alerts: [],
      } as Awaited<ReturnType<typeof heartbeatModule.runHeartbeat>>);

    const deps = makeDeps();
    const registry = createProductionAgentRunners(deps);
    const runner = registry.get("heartbeat");
    expect(runner).toBeTypeOf("function");
    await runner!(fakeCtx("heartbeat"));

    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs?.[1]?.mcp).toBe(deps.mcp);
    // PR-Q2 (phase-a appendix #9): the registry wraps `deps.db`
    // (raw `pg.Pool`) into a Drizzle handle ONCE at construction
    // time and threads the wrapped handle into every runner. The
    // contract is "runner receives a `db` exposing
    // `.execute(sql\`...\`)`", not "runner receives the raw
    // pool" — passing the raw pool was the bug that broke
    // `opencoo agents fire heartbeat` on first dispatch.
    expect(typeof (callArgs?.[1]?.db as { execute?: unknown })?.execute).toBe(
      "function",
    );
    expect(callArgs?.[1]?.domainSlug).toBe("test-domain");

    spy.mockRestore();
  });

  it("the lint runner invokes runLint with the production deps + the definitions registry", async () => {
    const lintModule = await import("@opencoo/engine-self-operating");
    const spy = vi.spyOn(lintModule, "runLint").mockResolvedValue({
      version: "v1",
      findings: [],
    } as Awaited<ReturnType<typeof lintModule.runLint>>);

    const deps = makeDeps();
    const registry = createProductionAgentRunners(deps);
    const runner = registry.get("lint");
    await runner!(fakeCtx("lint"));

    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs?.[1]?.mcp).toBe(deps.mcp);
    // PR-Q2 (phase-a appendix #9): runners receive the wrapped
    // Drizzle handle, not the raw pool. See the heartbeat
    // sibling test for the rationale.
    expect(typeof (callArgs?.[1]?.db as { execute?: unknown })?.execute).toBe(
      "function",
    );
    expect(callArgs?.[1]?.definitions).toBe(deps.definitions);
    expect(callArgs?.[1]?.domainSlug).toBe("test-domain");

    spy.mockRestore();
  });

  it("the surfacer runner invokes runSurfacer with the production deps + availableTemplateSlugs", async () => {
    const surfacerModule = await import("@opencoo/engine-self-operating");
    const spy = vi
      .spyOn(surfacerModule, "runSurfacer")
      .mockResolvedValue({
        version: "v1",
        candidates: [],
        insertedCandidateIds: [],
      } as Awaited<ReturnType<typeof surfacerModule.runSurfacer>>);

    const deps = makeDeps();
    const registry = createProductionAgentRunners(deps);
    const runner = registry.get("surfacer");
    await runner!(fakeCtx("surfacer"));

    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs?.[1]?.mcp).toBe(deps.mcp);
    // PR-Q2 (phase-a appendix #9): runners receive the wrapped
    // Drizzle handle, not the raw pool. See the heartbeat
    // sibling test for the rationale.
    expect(typeof (callArgs?.[1]?.db as { execute?: unknown })?.execute).toBe(
      "function",
    );
    expect(callArgs?.[1]?.domainSlug).toBe("test-domain");
    expect(callArgs?.[1]?.availableTemplateSlugs).toEqual([
      "asana-comment",
      "drive-watch",
    ]);

    spy.mockRestore();
  });
});

describe("tryComposeAgentRunnersFromEnv — boot-tolerance (PR-N3)", () => {
  it("returns null + logs `mcp_http.unavailable` when MCP_BEARER_TOKEN is unset", async () => {
    const records: Array<{ level: string; message: string; data?: unknown }> = [];
    const logger = {
      debug: (m: string, d?: unknown) => records.push({ level: "debug", message: m, data: d }),
      info: (m: string, d?: unknown) => records.push({ level: "info", message: m, data: d }),
      warn: (m: string, d?: unknown) => records.push({ level: "warn", message: m, data: d }),
      error: (m: string, d?: unknown) => records.push({ level: "error", message: m, data: d }),
    } as unknown as Parameters<typeof tryComposeAgentRunnersFromEnv>[0]["logger"];
    const result = await tryComposeAgentRunnersFromEnv({
      env: {}, // no MCP_BEARER_TOKEN
      router: {} as never,
      pgPool: {} as never,
      logger,
    });
    expect(result).toBeNull();
    const warn = records.find((r) => r.message === "mcp_http.unavailable");
    expect(warn).toBeDefined();
  });

  it("returns a populated registry when MCP_BEARER_TOKEN is set + availableTemplateSlugs override (caller-supplied path)", async () => {
    // Caller-supplied `availableTemplateSlugs` wins outright, so
    // the function never reaches the n8n-mcp call. This pins the
    // legacy override path for unit-test consumers.
    const records: Array<{ level: string; message: string; data?: unknown }> = [];
    const logger = {
      debug: (m: string, d?: unknown) => records.push({ level: "debug", message: m, data: d }),
      info: (m: string, d?: unknown) => records.push({ level: "info", message: m, data: d }),
      warn: (m: string, d?: unknown) => records.push({ level: "warn", message: m, data: d }),
      error: (m: string, d?: unknown) => records.push({ level: "error", message: m, data: d }),
    } as unknown as Parameters<typeof tryComposeAgentRunnersFromEnv>[0]["logger"];
    const result = await tryComposeAgentRunnersFromEnv({
      env: { MCP_BEARER_TOKEN: "valid-token-1234567890" },
      router: {} as never,
      pgPool: {} as never,
      logger,
      // Empty override → Surfacer is OMITTED (round-2 fix #2 of PR-N3)
      availableTemplateSlugs: [],
    });
    expect(result).not.toBeNull();
    expect(result?.runners.get("heartbeat")).toBeTypeOf("function");
    expect(result?.runners.get("lint")).toBeTypeOf("function");
    // Round-2 fix #2 on PR #57: empty template catalog →
    // Surfacer is omitted (not silently misconfigured).
    expect(result?.runners.get("surfacer")).toBeUndefined();
    expect(result?.runners.get("chat")).toBeUndefined();
    // The 3 definitions are still REGISTERED in the
    // AgentDefinitionRegistry (the dispatcher uses them for
    // automation_drift detection); only the RUNNER closure for
    // surfacer is omitted.
    expect(result?.definitions.list().length).toBe(3);
    // The orchestrator emitted a clear warn line so the
    // operator can see why Surfacer doesn't fire on cron.
    const warn = records.find(
      (r) =>
        r.level === "warn" &&
        r.message === "surfacer.template_catalog_empty",
    );
    expect(warn).toBeDefined();
  });

  it("registers Surfacer when MCP_BEARER_TOKEN is set AND availableTemplateSlugs is non-empty", async () => {
    const result = await tryComposeAgentRunnersFromEnv({
      env: { MCP_BEARER_TOKEN: "valid-token-1234567890" },
      router: {} as never,
      pgPool: {} as never,
      logger: silentLogger(),
      availableTemplateSlugs: ["asana-comment", "drive-watch"],
    });
    expect(result).not.toBeNull();
    expect(result?.runners.get("surfacer")).toBeTypeOf("function");
  });

  it("exposes the LlmRouter on the bundle so the orchestrator can thread it into AgentDispatcher (round-2 fix #1 on PR #57)", async () => {
    // tryComposeAgentRunnersBundleFromEnv constructs both a
    // pg.Pool AND an LlmRouter, then captures both in the
    // returned bundle. The orchestrator reads `bundle.router`
    // and threads it into `engine-self-operating.start({
    // agentRouter })` so the AgentDispatcher's per-dispatch
    // ctx.router is the SAME instance the runner closures
    // captured. Without identity sharing, the dispatcher falls
    // back to its `({} as unknown) as LlmRouter` empty-object
    // cast and the first scheduled agent dispatch crashes.
    const composition = await import(
      "../src/provision/production-composition.js"
    );
    const bundle = await composition.tryComposeAgentRunnersBundleFromEnv({
      env: {
        DATABASE_URL: "postgres://test:test@127.0.0.1:65535/none",
        MCP_BEARER_TOKEN: "static-bearer-do-not-leak",
      },
      logger: silentLogger(),
    });
    expect(bundle).not.toBeNull();
    // The bundle MUST expose a router that has the LlmRouter
    // surface — the dispatcher relies on `generateObject`.
    expect(bundle?.router).toBeDefined();
    expect(typeof bundle?.router.generateObject).toBe("function");
    expect(typeof bundle?.router.generateText).toBe("function");
    await bundle?.close();
  });

  it("never logs the bearer token (THREAT-MODEL §3.6 #11)", async () => {
    const TOKEN = "super-secret-token-do-not-leak-1234567890";
    const records: Array<{ level: string; message: string; data?: unknown }> = [];
    const logger = {
      debug: (m: string, d?: unknown) => records.push({ level: "debug", message: m, data: d }),
      info: (m: string, d?: unknown) => records.push({ level: "info", message: m, data: d }),
      warn: (m: string, d?: unknown) => records.push({ level: "warn", message: m, data: d }),
      error: (m: string, d?: unknown) => records.push({ level: "error", message: m, data: d }),
    } as unknown as Parameters<typeof tryComposeAgentRunnersFromEnv>[0]["logger"];
    const result = await tryComposeAgentRunnersFromEnv({
      env: { MCP_BEARER_TOKEN: TOKEN },
      router: {} as never,
      pgPool: {} as never,
      logger,
    });
    expect(result).not.toBeNull();
    for (const r of records) {
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });
});

// PR-O3 (phase-a appendix #7) — Surfacer activation via n8n-mcp.
// Three new tests pin the wiring contract between
// production-composition.ts and the
// `listAvailableTemplateSlugs` adapter helper.
describe("tryComposeAgentRunnersFromEnv — n8n-mcp template catalog (PR-O3)", () => {
  it("registers Surfacer when n8n-mcp returns a non-empty template catalog", async () => {
    // Inject a stub McpToolCallClient via the test seam so we
    // don't have to spin up a real n8n-mcp process.
    const stub = {
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              categories: [
                { category: "ai_automation" },
                { category: "webhook_processing" },
                { category: "data_sync" },
              ],
            }),
          },
        ],
      }),
    };
    const result = await tryComposeAgentRunnersFromEnv({
      env: { MCP_BEARER_TOKEN: "valid-token-1234567890" },
      router: {} as never,
      pgPool: {} as never,
      logger: silentLogger(),
      n8nMcpClient: stub,
    });
    expect(result).not.toBeNull();
    expect(result?.runners.get("heartbeat")).toBeTypeOf("function");
    expect(result?.runners.get("lint")).toBeTypeOf("function");
    expect(result?.runners.get("surfacer")).toBeTypeOf("function");
  });

  it("falls back to the vendored builderSkills baseline + emits `n8n_mcp.unavailable` warn when N8N_MCP env vars are unset", async () => {
    // No `n8nMcpClient` test seam, no N8N_MCP_BASE_URL or
    // N8N_MCP_BEARER_TOKEN — exercises the env-derivation path
    // with the operator NOT having set the n8n-mcp env vars.
    const records: Array<{ level: string; message: string; data?: unknown }> = [];
    const logger = {
      debug: (m: string, d?: unknown) => records.push({ level: "debug", message: m, data: d }),
      info: (m: string, d?: unknown) => records.push({ level: "info", message: m, data: d }),
      warn: (m: string, d?: unknown) => records.push({ level: "warn", message: m, data: d }),
      error: (m: string, d?: unknown) => records.push({ level: "error", message: m, data: d }),
    } as unknown as Parameters<typeof tryComposeAgentRunnersFromEnv>[0]["logger"];
    const result = await tryComposeAgentRunnersFromEnv({
      env: {
        MCP_BEARER_TOKEN: "valid-token-1234567890",
        // N8N_MCP_BASE_URL + N8N_MCP_BEARER_TOKEN intentionally
        // absent.
      },
      router: {} as never,
      pgPool: {} as never,
      logger,
    });
    expect(result).not.toBeNull();
    // Vendored fallback yields a non-empty list → Surfacer is
    // registered (closing the round-2 fix #2 omission for the
    // realistic operator deployment).
    expect(result?.runners.get("surfacer")).toBeTypeOf("function");
    // Operator sees a clear warn telling them why Surfacer is
    // running on the vendored baseline.
    const warn = records.find(
      (r) => r.level === "warn" && r.message === "n8n_mcp.unavailable",
    );
    expect(warn).toBeDefined();
    // The follow-up `surfacer.template_catalog_n8n_mcp_*` warns
    // are NOT emitted here because n8n_mcp.unavailable runs
    // BEFORE the listAvailableTemplateSlugs call (the client is
    // null so the function returns the fallback verbatim with
    // no further log noise).
  });

  it("falls back to the vendored builderSkills baseline + emits `surfacer.template_catalog_n8n_mcp_unreachable` warn when n8n-mcp throws", async () => {
    const records: Array<{ level: string; message: string; data?: unknown }> = [];
    const logger = {
      debug: (m: string, d?: unknown) => records.push({ level: "debug", message: m, data: d }),
      info: (m: string, d?: unknown) => records.push({ level: "info", message: m, data: d }),
      warn: (m: string, d?: unknown) => records.push({ level: "warn", message: m, data: d }),
      error: (m: string, d?: unknown) => records.push({ level: "error", message: m, data: d }),
    } as unknown as Parameters<typeof tryComposeAgentRunnersFromEnv>[0]["logger"];
    const stub = {
      callTool: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:5678");
      },
    };
    const result = await tryComposeAgentRunnersFromEnv({
      env: { MCP_BEARER_TOKEN: "valid-token-1234567890" },
      router: {} as never,
      pgPool: {} as never,
      logger,
      n8nMcpClient: stub,
    });
    expect(result).not.toBeNull();
    // Fallback to vendored builderSkills → Surfacer registered.
    expect(result?.runners.get("surfacer")).toBeTypeOf("function");
    const warn = records.find(
      (r) =>
        r.level === "warn" &&
        r.message === "surfacer.template_catalog_n8n_mcp_unreachable",
    );
    expect(warn).toBeDefined();
  });
});
