/**
 * Per-domain worldview compiler tests (PR 22 / plan #106).
 *
 * Mirror of compile-company.test.ts retry path but for the
 * per-domain compiler. The sovereignty constraint doesn't apply
 * here (a per-domain compile reads pages within ITS OWN domain;
 * the LLM-policy boundary already bounds the data path), so the
 * test focuses on the token-cap retry + Zod-strict shape.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import type { DomainId, DomainSlug } from "@opencoo/shared/db";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";

import {
  WORLDVIEW_BODY_MAX_BYTES,
  WorldviewOverflowError,
  compileDomainWorldview,
} from "../../../src/pipelines/worldview/index.js";

import { freshAgentDb } from "../../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeProvider(responses: ReadonlyArray<unknown>): LlmProvider {
  let i = 0;
  return {
    generate: async () => {
      const r = responses[i] ?? responses[responses.length - 1];
      i++;
      return {
        text: typeof r === "string" ? r : JSON.stringify(r),
        tokensIn: 5,
        tokensOut: 5,
      };
    },
  };
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

describe("compileDomainWorldview — token-cap retry + happy path", () => {
  it("happy path: reads pages, returns body, retried=false", async () => {
    const fixture = await freshAgentDb();
    const wiki = new InMemoryWikiAdapter();
    wiki.inject(
      "test-domain" as DomainSlug,
      "team/eng.md",
      "# eng team",
    );
    wiki.inject(
      "test-domain" as DomainSlug,
      "projects/q3.md",
      "# q3",
    );
    const router = makeRouter(
      fakeProvider([{ version: "v1", body: "# domain worldview body." }]),
      fixture.db,
    );

    const result = await compileDomainWorldview({
      router,
      wikiAdapter: wiki,
      db: fixture.db as unknown as Parameters<typeof compileDomainWorldview>[0]["db"],
      domainId: fixture.domainId as DomainId,
      domainSlug: "test-domain" as DomainSlug,
      locale: "en",
      pagePaths: ["team/eng.md", "projects/q3.md"],
    });

    expect(result.body).toContain("worldview body");
    expect(result.retried).toBe(false);
    expect(result.bodyBytes).toBeGreaterThan(0);
    expect(result.bodyBytes).toBeLessThan(WORLDVIEW_BODY_MAX_BYTES);
  });

  it("retries with 'compress further' suffix on first overflow", async () => {
    const fixture = await freshAgentDb();
    const wiki = new InMemoryWikiAdapter();
    wiki.inject("test-domain" as DomainSlug, "p.md", "# p");
    const oversized = "x".repeat(WORLDVIEW_BODY_MAX_BYTES + 50);
    const router = makeRouter(
      fakeProvider([
        { version: "v1", body: oversized },
        { version: "v1", body: "# compressed worldview" },
      ]),
      fixture.db,
    );

    const result = await compileDomainWorldview({
      router,
      wikiAdapter: wiki,
      db: fixture.db as unknown as Parameters<typeof compileDomainWorldview>[0]["db"],
      domainId: fixture.domainId as DomainId,
      domainSlug: "test-domain" as DomainSlug,
      locale: "en",
      pagePaths: ["p.md"],
    });
    expect(result.retried).toBe(true);
    expect(result.body).toContain("compressed");
  });

  it("throws WorldviewOverflowError when both attempts overflow", async () => {
    const fixture = await freshAgentDb();
    const wiki = new InMemoryWikiAdapter();
    wiki.inject("test-domain" as DomainSlug, "p.md", "# p");
    const oversized = "x".repeat(WORLDVIEW_BODY_MAX_BYTES + 50);
    const router = makeRouter(
      fakeProvider([
        { version: "v1", body: oversized },
        { version: "v1", body: oversized },
      ]),
      fixture.db,
    );
    await expect(
      compileDomainWorldview({
        router,
        wikiAdapter: wiki,
        db: fixture.db as unknown as Parameters<typeof compileDomainWorldview>[0]["db"],
        domainId: fixture.domainId as DomainId,
        domainSlug: "test-domain" as DomainSlug,
        locale: "en",
        pagePaths: ["p.md"],
      }),
    ).rejects.toBeInstanceOf(WorldviewOverflowError);
  });

  it("skips pages that returned null (deleted between list + read)", async () => {
    const fixture = await freshAgentDb();
    const wiki = new InMemoryWikiAdapter();
    // Only seed one of two requested paths.
    wiki.inject("test-domain" as DomainSlug, "exists.md", "# exists");
    const router = makeRouter(
      fakeProvider([{ version: "v1", body: "# wv from one page" }]),
      fixture.db,
    );

    const result = await compileDomainWorldview({
      router,
      wikiAdapter: wiki,
      db: fixture.db as unknown as Parameters<typeof compileDomainWorldview>[0]["db"],
      domainId: fixture.domainId as DomainId,
      domainSlug: "test-domain" as DomainSlug,
      locale: "en",
      // 'gone.md' doesn't exist — readPage returns null; we
      // skip silently (the orchestrator chose the path list at
      // an earlier step; a page can disappear in between).
      pagePaths: ["exists.md", "gone.md"],
    });
    expect(result.body).toContain("wv from one page");
  });
});
