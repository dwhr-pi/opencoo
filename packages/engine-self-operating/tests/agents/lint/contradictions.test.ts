/**
 * `contradictions` detector — the only LLM-backed Lint
 * detector. Uses a MockLlmClient through a real LlmRouter so
 * the request flows through the policy/budget/llm_usage path
 * and the mock controls the JSON response.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import type { DomainId } from "@opencoo/shared/db";

import {
  CONTRADICTIONS_PAGE_CAP,
  detectContradictions,
} from "../../../src/agents/lint/detectors/contradictions.js";
import { freshAgentDb } from "../../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
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

function fakeProvider(payload: unknown): LlmProvider {
  return {
    generate: async () => ({
      text: JSON.stringify(payload),
      tokensIn: 10,
      tokensOut: 20,
    }),
  };
}

describe("detectContradictions — LLM-backed pair analysis", () => {
  it("returns LintFindings for every contradiction the LLM emits", async () => {
    const fixture = await freshAgentDb();
    const router = makeRouter(
      fakeProvider({
        version: "v1",
        contradictions: [
          {
            page_a: "exec/team/eng.md",
            page_b: "exec/team/eng.md",
            claim_a: "we use Python 3.11",
            claim_b: "we use Python 3.10",
            severity: "medium",
            rationale: "the two pages name different runtime versions",
          },
        ],
      }),
      fixture.db,
    );

    const findings = await detectContradictions({
      router,
      db: fixture.db as unknown as Parameters<typeof detectContradictions>[0]["db"],
      domainId: fixture.domainId as DomainId,
      locale: "en",
      pages: [
        { domainSlug: "exec", path: "team/eng.md", body: "Python 3.11" },
        { domainSlug: "exec", path: "ops/runtime.md", body: "Python 3.10" },
      ],
      fetchedAt: new Date(),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("contradictions");
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.detail?.rationale).toMatch(/runtime versions/);
  });

  it("returns [] when the LLM finds nothing", async () => {
    const fixture = await freshAgentDb();
    const router = makeRouter(
      fakeProvider({ version: "v1", contradictions: [] }),
      fixture.db,
    );
    const findings = await detectContradictions({
      router,
      db: fixture.db as unknown as Parameters<typeof detectContradictions>[0]["db"],
      domainId: fixture.domainId as DomainId,
      locale: "en",
      pages: [
        { domainSlug: "exec", path: "a.md", body: "x" },
        { domainSlug: "exec", path: "b.md", body: "y" },
      ],
      fetchedAt: new Date(),
    });
    expect(findings).toEqual([]);
  });

  it("returns [] without calling the LLM when fewer than 2 pages are sampled", async () => {
    const fixture = await freshAgentDb();
    let called = 0;
    const provider: LlmProvider = {
      generate: async () => {
        called++;
        return {
          text: JSON.stringify({ version: "v1", contradictions: [] }),
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    };
    const router = makeRouter(provider, fixture.db);
    const findings = await detectContradictions({
      router,
      db: fixture.db as unknown as Parameters<typeof detectContradictions>[0]["db"],
      domainId: fixture.domainId as DomainId,
      locale: "en",
      pages: [{ domainSlug: "exec", path: "alone.md", body: "x" }],
      fetchedAt: new Date(),
    });
    expect(findings).toEqual([]);
    expect(called).toBe(0);
  });

  it("CONTRADICTIONS_PAGE_CAP is the architectural bound from Q7 — pages, not pairs", () => {
    expect(CONTRADICTIONS_PAGE_CAP).toBe(50);
  });

  it("DLQs as validation when the LLM emits a malformed payload (Zod-strict reject)", async () => {
    const fixture = await freshAgentDb();
    const router = makeRouter(
      fakeProvider({
        version: "v1",
        contradictions: [{ this_field_doesnt_belong: "x" }],
      }),
      fixture.db,
    );
    await expect(
      detectContradictions({
        router,
        db: fixture.db as unknown as Parameters<typeof detectContradictions>[0]["db"],
        domainId: fixture.domainId as DomainId,
        locale: "en",
        pages: [
          { domainSlug: "exec", path: "a.md", body: "x" },
          { domainSlug: "exec", path: "b.md", body: "y" },
        ],
        fetchedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
