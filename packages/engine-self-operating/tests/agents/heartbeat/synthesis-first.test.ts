/**
 * PR-Y10 — synthesis-first heartbeat prompt + page drill-down.
 *
 * The 1.1.0 prompt's "Alerty operacyjne" section was the most
 * detailed bullet block in the body, so the LLM followed the
 * operational path even when the wiki had 31 compiled pages.
 * 1.2.0 inverts the balance: three opinionated synthesis
 * sections (On fire / Closing / To close) are the default, and
 * operational health is a single tail-priority sidebar.
 *
 * These tests pin the new behavior at three layers:
 *   1. Prompt shape — the assembled prompt body emphasises the
 *      synthesis sections, not the operational spec.
 *   2. Drill-down wiring — when the worldview names real wiki
 *      paths, the runner reads them via `wiki.read_page` and
 *      spotlights the bodies into the prompt.
 *   3. Scope safety — drill-down only fires for paths that
 *      exist in the page index; paths the worldview mentions
 *      but that don't exist are NOT fetched (no hallucinated
 *      MCP reads).
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import {
  loadPrompt,
  PROMPT_VERSION_MANIFEST,
} from "@opencoo/shared/prompts";

const EN_HEARTBEAT_PROMPT = loadPrompt({
  name: "heartbeat",
  locale: "en",
}).body;
const PL_HEARTBEAT_PROMPT = loadPrompt({
  name: "heartbeat",
  locale: "pl",
}).body;
const HEARTBEAT_PROMPT_VERSION = PROMPT_VERSION_MANIFEST.heartbeat;

import {
  AgentDefinitionRegistry,
  invokeAgent,
} from "../../../src/agent-harness/index.js";
import { InMemoryMcpToolClient } from "../../../src/mcp-tool-client/index.js";
import {
  HEARTBEAT_DEFINITION,
  runHeartbeat,
  selectDrilldownPages,
  extractCandidatePaths,
  HEARTBEAT_DRILLDOWN_HARD_CEILING,
  type HeartbeatOutput,
} from "../../../src/agents/heartbeat/index.js";
import type { SystemHealth } from "../../../src/agents/heartbeat/system-health.js";

import {
  freshAgentDb,
  seedAgentInstance,
} from "../../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

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

function makeRouter(provider: LlmProvider, db: unknown): LlmRouter {
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
  summary: "Allegro Profit Optimizer blocked 5 days.",
  alerts: [
    {
      priority: 1,
      title: "Allegro Profit Optimizer blocked",
      body: "Owner has shipped nothing in 5 days; deadline is tomorrow.",
      citations: ["tasks/allegro-profit-optimizer.md"],
    },
  ],
};

describe("HEARTBEAT_PROMPT_VERSION — synthesis-first restructure (PR-Y10)", () => {
  it("bumps to 1.2.0", () => {
    expect(HEARTBEAT_PROMPT_VERSION).toBe("1.2.0");
  });

  it("EN prompt names the three synthesis sections (On fire / Closing / To close)", () => {
    // Section headings — case-insensitive so future prose
    // tweaks don't break this.
    expect(EN_HEARTBEAT_PROMPT.toLowerCase()).toContain("on fire");
    expect(EN_HEARTBEAT_PROMPT.toLowerCase()).toContain("closing");
    expect(EN_HEARTBEAT_PROMPT.toLowerCase()).toContain("to close");
  });

  it("PL prompt names the three synthesis sections (Co pali / Co się domyka / Do zamknięcia)", () => {
    expect(PL_HEARTBEAT_PROMPT.toLowerCase()).toContain("co pali");
    expect(PL_HEARTBEAT_PROMPT.toLowerCase()).toContain("co się domyka");
    expect(PL_HEARTBEAT_PROMPT.toLowerCase()).toContain("do zamknięcia");
  });

  it("EN prompt instructs the tail-priority operational sidebar at priority 5", () => {
    // The new operational fallback must (a) name priority 5 as
    // the tail slot and (b) gate it on intake_counts.failed > 50
    // when the wiki is populated. The previous 1.1.0 prompt
    // listed five operational sources without a priority gate
    // — that's the bug class this PR fixes.
    expect(EN_HEARTBEAT_PROMPT).toContain("priority 5");
    expect(EN_HEARTBEAT_PROMPT).toMatch(/intake_counts\.failed\s*>\s*50/);
  });

  it("PL prompt instructs the tail-priority operational sidebar at priority 5", () => {
    expect(PL_HEARTBEAT_PROMPT).toContain("priority 5");
    expect(PL_HEARTBEAT_PROMPT).toMatch(/intake_counts\.failed\s*>\s*50/);
  });

  it("EN prompt cites tasks/<asana-id>.md as the canonical task-page citation shape", () => {
    expect(EN_HEARTBEAT_PROMPT).toContain("tasks/<asana-id>.md");
  });

  it("PL prompt cites tasks/<asana-id>.md as the canonical task-page citation shape", () => {
    expect(PL_HEARTBEAT_PROMPT).toContain("tasks/<asana-id>.md");
  });
});

describe("extractCandidatePaths — parser for worldview-referenced wiki paths", () => {
  it("extracts bare path tokens", () => {
    const text = "See projects/q3-launch.md for details.";
    expect(extractCandidatePaths(text)).toEqual(["projects/q3-launch.md"]);
  });

  it("extracts markdown-link URLs", () => {
    const text = "[Q3 launch](projects/q3-launch.md) is blocked.";
    expect(extractCandidatePaths(text)).toEqual(["projects/q3-launch.md"]);
  });

  it("extracts the [wiki:…] href shape used in compiled wiki pages", () => {
    const text = "Per [wiki:strategy/runway.md] we have 4 months.";
    expect(extractCandidatePaths(text)).toEqual(["strategy/runway.md"]);
  });

  it("deduplicates and preserves source order", () => {
    const text = "tasks/123.md and projects/x.md, then tasks/123.md again.";
    expect(extractCandidatePaths(text)).toEqual([
      "tasks/123.md",
      "projects/x.md",
    ]);
  });

  it("does NOT extract paths whose first segment looks like a domain", () => {
    // Stray inline URL fragments must not pollute the candidate list.
    const text = "example.com/foo.md and https://acme.example/bar.md";
    expect(extractCandidatePaths(text)).toEqual([]);
  });

  it("does NOT extract paths embedded in full URIs (wiki://, http://)", () => {
    const text = "See wiki://test-domain/projects/q3.md and http://x.io/y.md";
    // The URI-prefixed forms are excluded by the leading
    // boundary (`(?<![A-Za-z0-9/_:-])`). The trailing token in
    // `wiki://...` is preceded by a `/` so it's filtered.
    expect(extractCandidatePaths(text)).toEqual([]);
  });
});

describe("selectDrilldownPages — index intersection + cap", () => {
  it("intersects candidates with the page index", () => {
    const picked = selectDrilldownPages({
      worldviewBody:
        "tasks/exists.md is blocked. tasks/does-not-exist.md is also mentioned.",
      pageIndex: ["tasks/exists.md", "index.md", "worldview.md"],
    });
    expect(picked).toEqual(["tasks/exists.md"]);
  });

  it("caps at maxPages (default 3)", () => {
    const picked = selectDrilldownPages({
      worldviewBody: "a/a.md b/b.md c/c.md d/d.md e/e.md",
      pageIndex: ["a/a.md", "b/b.md", "c/c.md", "d/d.md", "e/e.md"],
    });
    expect(picked).toEqual(["a/a.md", "b/b.md", "c/c.md"]);
  });

  it("respects an explicit maxPages override", () => {
    const picked = selectDrilldownPages({
      worldviewBody: "a/a.md b/b.md c/c.md",
      pageIndex: ["a/a.md", "b/b.md", "c/c.md"],
      maxPages: 2,
    });
    expect(picked).toEqual(["a/a.md", "b/b.md"]);
  });

  it("clamps maxPages to HEARTBEAT_DRILLDOWN_HARD_CEILING (5)", () => {
    const picked = selectDrilldownPages({
      worldviewBody: "a/a.md b/b.md c/c.md d/d.md e/e.md f/f.md g/g.md",
      pageIndex: [
        "a/a.md",
        "b/b.md",
        "c/c.md",
        "d/d.md",
        "e/e.md",
        "f/f.md",
        "g/g.md",
      ],
      maxPages: 999,
    });
    expect(picked.length).toBeLessThanOrEqual(HEARTBEAT_DRILLDOWN_HARD_CEILING);
    expect(picked).toEqual([
      "a/a.md",
      "b/b.md",
      "c/c.md",
      "d/d.md",
      "e/e.md",
    ]);
  });

  it("returns [] when maxPages is 0", () => {
    expect(
      selectDrilldownPages({
        worldviewBody: "a/a.md",
        pageIndex: ["a/a.md"],
        maxPages: 0,
      }),
    ).toEqual([]);
  });
});

describe("runHeartbeat — synthesis-first prompt assembly (PR-Y10)", () => {
  it("substantive worldview: drilled pages reach the prompt + wiki.read_page is on the ledger", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "heartbeat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(HEARTBEAT_DEFINITION);

    const mcp = new InMemoryMcpToolClient();
    // Page index — three pages exist. The worldview references
    // two of them by path; the runner must fetch ONLY those two.
    mcp.setResource("wiki://test-domain/index.md", "# index");
    mcp.setResource(
      "wiki://test-domain/tasks/allegro-profit-optimizer.md",
      "Owner: Maria. Last commit 5 days ago. Deadline: tomorrow.",
    );
    mcp.setResource(
      "wiki://test-domain/projects/q3-launch.md",
      "Status: blocked on legal review since 2026-05-01.",
    );
    mcp.setResource(
      "wiki://test-domain/strategy/runway.md",
      "We have 8 months at current burn.",
    );
    mcp.setResource(
      "worldview://test-domain",
      [
        "# Domain worldview",
        "## Active stalls",
        "- tasks/allegro-profit-optimizer.md is blocked 5 days.",
        "- projects/q3-launch.md awaits legal review.",
        "## Strategic context",
        "- nonexistent/ghost.md should NOT be drilled into.",
      ].join("\n"),
    );

    const { provider, captured } = capturingProvider(ECHO_OUTPUT);
    const router = makeRouter(provider, fixture.db);

    // Substantive wiki — page_count 5 so the prompt's
    // synthesis branch is the canonical path.
    const fakeHealth: SystemHealth = {
      intake_counts: { pending: 0, classified: 31, skipped: 0, failed: 0 },
      intake_failures_recent: [],
      source_bindings: [],
      recent_agent_runs: [],
      wiki_stats: {
        page_count: 31,
        worldview_bytes: 2110,
        worldview_last_compiled_at: "2026-05-12T06:00:00Z",
      },
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
          gatherSystemHealth: async () => fakeHealth,
        }),
    });

    expect(result.status).toBe("success");
    expect(captured.prompt).toBeDefined();
    const prompt = captured.prompt as string;

    // The drilled-page bodies reach the prompt.
    expect(prompt).toContain("Owner: Maria. Last commit 5 days ago");
    expect(prompt).toContain("Status: blocked on legal review");
    // The hallucinated path was NOT fetched.
    expect(prompt).not.toContain("nonexistent/ghost.md content");

    // Drilled pages get their own spotlight envelopes whose
    // source attributes name the exact wiki path. This is the
    // LLM's cite-able anchor.
    expect(prompt).toContain(
      `wiki://test-domain/tasks/allegro-profit-optimizer.md`,
    );
    expect(prompt).toContain(`wiki://test-domain/projects/q3-launch.md`);

    // The tool ledger records every wiki.read_page call.
    const rows = await fixture.raw.query<{
      tool_calls: Array<{ name: string; args?: unknown }>;
    }>(`SELECT tool_calls FROM agent_runs WHERE id = $1`, [result.runId]);
    const names = (rows.rows[0]?.tool_calls ?? []).map((c) => c.name);
    const readPageCount = names.filter((n) => n === "wiki.read_page").length;
    expect(readPageCount).toBe(2);
    expect(names).toContain("worldview.read");
    expect(names).toContain("index.search");
  });

  it("substantive worldview with no path references: zero drill-down calls (graceful)", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedAgentInstance(fixture, {
      definitionSlug: "heartbeat",
      memory: { type: "none" },
    });
    const definitions = new AgentDefinitionRegistry();
    definitions.register(HEARTBEAT_DEFINITION);

    const mcp = new InMemoryMcpToolClient();
    mcp.setResource("wiki://test-domain/index.md", "# index");
    mcp.setResource("wiki://test-domain/projects/q3.md", "# q3");
    mcp.setResource(
      "worldview://test-domain",
      "All projects are on track. Nothing to drill into.",
    );

    const { provider } = capturingProvider(ECHO_OUTPUT);
    const router = makeRouter(provider, fixture.db);

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
          gatherSystemHealth: async () => ({
            intake_counts: { pending: 0, classified: 1, skipped: 0, failed: 0 },
            intake_failures_recent: [],
            source_bindings: [],
            recent_agent_runs: [],
            wiki_stats: {
              page_count: 5,
              worldview_bytes: 100,
              worldview_last_compiled_at: "2026-05-12T06:00:00Z",
            },
          }),
        }),
    });
    expect(result.status).toBe("success");
    const rows = await fixture.raw.query<{
      tool_calls: Array<{ name: string }>;
    }>(`SELECT tool_calls FROM agent_runs WHERE id = $1`, [result.runId]);
    const names = (rows.rows[0]?.tool_calls ?? []).map((c) => c.name);
    expect(names.filter((n) => n === "wiki.read_page")).toEqual([]);
    // The two baseline reads still fire.
    expect(names).toContain("worldview.read");
    expect(names).toContain("index.search");
  });

  it("substantive worldview prompt names the synthesis sections (synthesis-first signal)", async () => {
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
          gatherSystemHealth: async () => ({
            intake_counts: { pending: 0, classified: 31, skipped: 0, failed: 0 },
            intake_failures_recent: [],
            source_bindings: [],
            recent_agent_runs: [],
            wiki_stats: {
              page_count: 31,
              worldview_bytes: 2110,
              worldview_last_compiled_at: "2026-05-12T06:00:00Z",
            },
          }),
        }),
    });

    const prompt = captured.prompt as string;
    // Synthesis-first: the prompt body names the three buckets.
    // The default instance.locale is `en` per the pglite
    // fixture; the EN body uses the English headings.
    expect(prompt.toLowerCase()).toContain("on fire");
    expect(prompt.toLowerCase()).toContain("closing");
    expect(prompt.toLowerCase()).toContain("to close");
    // And the tail-priority operational fallback rule is
    // explicitly priority 5.
    expect(prompt).toContain("priority 5");
  });
});
