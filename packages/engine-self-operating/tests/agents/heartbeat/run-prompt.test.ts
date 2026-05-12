/**
 * `runHeartbeat` prompt-shape tests (PR-W6, phase-a appendix
 * #14).
 *
 * These tests pin the wiring between `runHeartbeat` and the
 * new system-health gatherer: the gatherer's output reaches
 * the LLM as a spotlighted `system-health://<slug>` envelope,
 * and the envelope carries the same JSON payload the gatherer
 * returned. The classic `heartbeat.test.ts` covers the
 * schema/contract; this file covers the prompt assembly.
 *
 * Strategy: stub `ctx.router.generateObject` via a custom
 * LlmProvider whose `generate` records the full prompt text,
 * then assert the recorded prompt contains the envelope
 * source attribute + the JSON values we seeded.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../../src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../../../src/mcp-tool-client/index.js";
import {
  HEARTBEAT_DEFINITION,
  runHeartbeat,
  type HeartbeatOutput,
} from "../../../src/agents/heartbeat/index.js";
import type {
  GatherSystemHealthArgs,
  SystemHealth,
} from "../../../src/agents/heartbeat/system-health.js";

import {
  freshAgentDb,
  seedAgentInstance,
} from "../../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

/** Capture-and-return LlmProvider — records the prompt text
 *  the router asks it to generate against, then echoes back a
 *  valid HeartbeatOutput so the agent run succeeds. */
function capturingProvider(echo: HeartbeatOutput): {
  readonly provider: LlmProvider;
  readonly captured: { prompt?: string };
} {
  const captured: { prompt?: string } = {};
  const provider: LlmProvider = {
    generate: async (args: { prompt: string }) => {
      captured.prompt = args.prompt;
      return { text: JSON.stringify(echo), tokensIn: 10, tokensOut: 20 };
    },
  };
  return { provider, captured };
}

function makeRouter(
  provider: LlmProvider,
  db: unknown,
): LlmRouter {
  return new LlmRouter({
    db: db as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: {
      paused: () => false,
      pause: () => undefined,
      resume: () => undefined,
    },
    provider,
  });
}

const ECHO_OUTPUT: HeartbeatOutput = {
  version: "v1",
  summary: "Operational backlog rising.",
  alerts: [
    {
      priority: 1,
      title: "Intake backlog",
      body: "2 documents pending classification on drive binding.",
      citations: ["sources/drive-meetings.md"],
    },
  ],
};

describe("runHeartbeat — system-health envelope reaches the LLM prompt", () => {
  it("stubs the gatherer with intake_counts.failed > 0 and asserts the envelope lands", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "heartbeat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(HEARTBEAT_DEFINITION);

    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("wiki://test-domain/index.md", "# index");
    mcp.setResource("worldview://test-domain", "# wv");

    const { provider, captured } = capturingProvider(ECHO_OUTPUT);
    const router = makeRouter(provider, fixture.db);

    // Stub the gatherer with a known-shape payload. The
    // failed-count > 0 is the canary: if the LLM prompt does
    // NOT carry the system-health envelope, the model could
    // never surface this signal to operators on an empty wiki.
    const fakeHealth: SystemHealth = {
      intake_counts: { pending: 2, classified: 0, skipped: 0, failed: 3 },
      intake_failures_recent: [
        {
          binding_name: "drive:meetings",
          error_class: "validation",
          error_text_snippet: "binding.allowed_paths is empty",
        },
      ],
      source_bindings: [
        {
          name: "drive:meetings",
          last_scan_at: "2026-05-11T10:00:00Z",
          hours_since_scan: 48,
          pending_count: 2,
          failed_count: 3,
        },
      ],
      recent_agent_runs: [
        {
          agent_slug: "heartbeat",
          success_count: 1,
          failure_count: 0,
          last_failure_message: null,
        },
      ],
      wiki_stats: {
        page_count: 0,
        worldview_bytes: 17,
        worldview_last_compiled_at: null,
      },
    };
    // Capture the gatherer's args so we can assert the scope
    // + slug threaded through correctly — the heartbeat MUST
    // pass `ctx.instance.scopeDomainIds` to the gatherer, not
    // the broader DB scope.
    const gathererCalls: GatherSystemHealthArgs[] = [];
    const stubGatherer = async (
      args: GatherSystemHealthArgs,
    ): Promise<typeof fakeHealth> => {
      gathererCalls.push(args);
      return fakeHealth;
    };

    const result = await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runHeartbeat(ctx, {
          db: fixture.db as unknown as Parameters<typeof runHeartbeat>[1]["db"],
          mcp,
          domainSlug: "test-domain",
          gatherSystemHealth: stubGatherer,
        }),
    });

    expect(result.status).toBe("success");
    expect(captured.prompt).toBeDefined();
    const prompt = captured.prompt as string;

    // The envelope source attribute proves the spotlight()
    // wrapped the payload. (Spotlight() escapes XML-ish
    // sentinels in the body, so the JSON fields are still
    // present but the angle brackets around the envelope tag
    // are literal `<source_content>` bytes from the wrapper.)
    expect(prompt).toContain(`system-health://test-domain`);
    // The seeded counts and binding name MUST reach the prompt.
    expect(prompt).toContain('"failed": 3');
    expect(prompt).toContain('"pending": 2');
    expect(prompt).toContain("drive:meetings");
    expect(prompt).toContain("binding.allowed_paths is empty");

    // Scope-thread invariant: the gatherer received the
    // instance's `scope_domain_ids`, not an unscoped read.
    expect(gathererCalls).toHaveLength(1);
    expect(gathererCalls[0]?.scopeDomainIds).toEqual([fixture.domainId]);
    expect(gathererCalls[0]?.domainSlug).toBe("test-domain");
  });

  it("empty-wiki fixture: wiki_stats.page_count: 0 reaches the prompt", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "heartbeat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(HEARTBEAT_DEFINITION);

    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("wiki://test-domain/index.md", "# index");
    mcp.setResource(
      "worldview://test-domain",
      "Domain has no compiled pages yet.",
    );

    const { provider, captured } = capturingProvider(ECHO_OUTPUT);
    const router = makeRouter(provider, fixture.db);

    const emptyHealth: SystemHealth = {
      intake_counts: { pending: 0, classified: 0, skipped: 0, failed: 0 },
      intake_failures_recent: [],
      source_bindings: [],
      recent_agent_runs: [],
      wiki_stats: {
        page_count: 0,
        worldview_bytes: 33,
        worldview_last_compiled_at: null,
      },
    };

    await invokeAgent({
      definitions,
      db: fixture.db as unknown as Parameters<typeof invokeAgent>[0]["db"],
      router,
      logger: silentLogger(),
      instanceId,
      trigger: "scheduled",
      inputs: {},
      run: (ctx) =>
        runHeartbeat(ctx, {
          db: fixture.db as unknown as Parameters<typeof runHeartbeat>[1]["db"],
          mcp,
          domainSlug: "test-domain",
          gatherSystemHealth: async () => emptyHealth,
        }),
    });

    expect(captured.prompt).toBeDefined();
    const prompt = captured.prompt as string;
    expect(prompt).toContain(`system-health://test-domain`);
    expect(prompt).toContain('"page_count": 0');
    expect(prompt).toContain('"failed": 0');
  });
});
