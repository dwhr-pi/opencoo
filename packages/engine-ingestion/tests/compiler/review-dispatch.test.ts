/**
 * Compiler `reviewDispatch` hook (PR 17 / plan #77 extension 5).
 *
 * The hook fires AFTER the wikiWrite commit lands and AFTER
 * page_citations are recorded — never before, and never inline.
 * It runs only when:
 *   - a commit actually happened (skip-write returns null sha →
 *     no dispatch), AND
 *   - the domain row's review_role is non-null (D4: routing key
 *     lives on the domain, not the binding).
 *
 * Atomicity per Q7 must remain intact: exactly one wikiWrite per
 * compile run. The dispatch is a separate post-commit side
 * effect that does NOT issue another wiki write.
 */
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  compile,
  type ReviewDispatchEvent,
} from "../../src/compiler/compiler.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

async function makeFixture(
  provider: LlmProvider,
  opts: { reviewRole?: string } = {},
) {
  const f = await freshCompilerDb();
  if (opts.reviewRole !== undefined) {
    await f.db.execute(sql`
      UPDATE domains SET review_role = ${opts.reviewRole}
      WHERE id = ${f.domainId}::uuid
    `);
  }
  const router = new LlmRouter({
    db: f.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: { paused: () => false, pause: () => undefined, resume: () => undefined },
    provider,
  });
  const wikiAdapter = new InMemoryWikiAdapter();
  const wikiDeps: WikiWriteDeps = {
    adapter: wikiAdapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => new Date("2026-04-25T12:00:00Z"),
    instanceId: "test",
  };
  return {
    router,
    wikiAdapter,
    wikiDeps,
    db: f.db,
    domainId: f.domainId,
    bindingId: f.bindingId,
  };
}

const HAPPY_RESPONSE = {
  text: JSON.stringify({
    merged_body: "# Q3\n\nDistribution motion.\n",
    worldview_impact: [],
  }),
  tokensIn: 1,
  tokensOut: 1,
};

describe("compile — reviewDispatch hook (extension 5)", () => {
  it("calls reviewDispatch AFTER the wikiWrite when domain.review_role is non-null", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: HAPPY_RESPONSE,
    });
    const f = await makeFixture(mock, { reviewRole: "executive-team" });
    let writeCount = 0;
    let dispatchCalledAt = -1;
    const events: ReviewDispatchEvent[] = [];
    const writeSpy = vi
      .spyOn(f.wikiAdapter, "writeAtomic")
      .mockImplementation(async () => {
        writeCount += 1;
        return { status: "ok", sha: "deadbeef00000000" };
      });

    const result = await compile({
      router: f.router,
      domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
      sourceRef: "drive:doc-1",
      sourceContent: "Q3 priorities",
      pagePaths: ["strategy/q3.md"],
      locale: "en",
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      db: f.db as unknown as Parameters<typeof compile>[0]["db"],
      reviewDispatch: async (event) => {
        dispatchCalledAt = writeCount;
        events.push(event);
      },
    });

    expect(result.commitSha).toBe("deadbeef00000000");
    // Atomicity: exactly one wikiWrite per run.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    // Dispatch fires AFTER the write.
    expect(dispatchCalledAt).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.reviewRole).toBe("executive-team");
    expect(events[0]?.commitSha).toBe("deadbeef00000000");
    expect(events[0]?.pagePaths).toEqual(["strategy/q3.md"]);
  });

  it("does NOT call reviewDispatch when domain.review_role is null", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: HAPPY_RESPONSE,
    });
    const f = await makeFixture(mock); // no reviewRole
    const dispatch = vi.fn();

    await compile({
      router: f.router,
      domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
      sourceRef: "drive:doc-1",
      sourceContent: "x",
      pagePaths: ["strategy/q3.md"],
      locale: "en",
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      db: f.db as unknown as Parameters<typeof compile>[0]["db"],
      reviewDispatch: dispatch,
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does NOT call reviewDispatch when the commit is a no-op (skip-write)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: HAPPY_RESPONSE,
    });
    const f = await makeFixture(mock, { reviewRole: "executive-team" });
    // Pre-inject a page whose body equals what mergePage will
    // emit (skip-write trigger).
    f.wikiAdapter.inject(
      "test-domain" as Parameters<typeof f.wikiAdapter.inject>[0],
      "strategy/q3.md",
      "---\ntitle: Q3\n---\n# Q3\n\nDistribution motion.\n",
    );
    const dispatch = vi.fn();
    const result = await compile({
      router: f.router,
      domainId: f.domainId as Parameters<typeof compile>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compile>[0]["bindingId"],
      sourceRef: "drive:doc-1",
      sourceContent: "x",
      pagePaths: ["strategy/q3.md"],
      locale: "en",
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      db: f.db as unknown as Parameters<typeof compile>[0]["db"],
      reviewDispatch: dispatch,
    });
    expect(result.commitSha).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
