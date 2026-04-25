/**
 * Index Rebuilder pipeline (PR 17 / plan #77).
 *
 * Two surfaces:
 *   1. buildIndexBody — pure-function tests on grouping + sort.
 *   2. runIndexRebuilder — end-to-end with InMemoryWikiAdapter:
 *      lists wiki, builds body, writes via wikiWrite with the
 *      [index-rebuild] tag, skips when no change.
 */
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  buildIndexBody,
  runIndexRebuilder,
} from "../../src/pipelines/index-rebuilder.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const DOMAIN = "test-domain" as Parameters<
  InMemoryWikiAdapter["readPage"]
>[0];

const REBUILDER_AUTHOR = {
  name: "opencoo-rebuilder",
  email: "rebuilder@opencoo.local",
} as const;

function harness(): {
  wikiAdapter: InMemoryWikiAdapter;
  wikiDeps: WikiWriteDeps;
} {
  const wikiAdapter = new InMemoryWikiAdapter();
  const wikiDeps: WikiWriteDeps = {
    adapter: wikiAdapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => new Date("2026-04-25T12:00:00Z"),
    instanceId: "test",
  };
  return { wikiAdapter, wikiDeps };
}

describe("buildIndexBody — pure", () => {
  it("returns a placeholder body for an empty repo", () => {
    expect(buildIndexBody([])).toContain("_No pages yet._");
  });

  it("groups by top-level directory and sorts subdirs before (root)", () => {
    const body = buildIndexBody([
      "executive/log.md",
      "readme.md",
      "strategy/q3.md",
      "strategy/roadmap.md",
    ]);
    // executive/ then strategy/ then (root).
    const execIdx = body.indexOf("## executive/");
    const stratIdx = body.indexOf("## strategy/");
    const rootIdx = body.indexOf("## (root)");
    expect(execIdx).toBeGreaterThan(0);
    expect(stratIdx).toBeGreaterThan(execIdx);
    expect(rootIdx).toBeGreaterThan(stratIdx);
    expect(body).toContain("- strategy/q3.md");
    expect(body).toContain("- strategy/roadmap.md");
    expect(body).toContain("- readme.md");
  });

  it("excludes index.md from its own listing", () => {
    const body = buildIndexBody(["index.md", "strategy/q3.md"]);
    expect(body).not.toContain("- index.md");
    expect(body).toContain("- strategy/q3.md");
  });
});

describe("runIndexRebuilder — end-to-end", () => {
  it("writes a fresh index commit with the [index-rebuild] tag", async () => {
    const { wikiAdapter, wikiDeps } = harness();
    wikiAdapter.inject(DOMAIN, "strategy/q3.md", "# Q3\n");
    wikiAdapter.inject(DOMAIN, "executive/log.md", "# Log\n");
    const writeSpy = vi.spyOn(wikiAdapter, "writeAtomic");

    const result = await runIndexRebuilder({
      domainSlug: "test-domain",
      wikiDeps,
      wikiAdapter,
      logger: silentLogger(),
      author: REBUILDER_AUTHOR,
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{8,}$/);
    expect(result.fileCount).toBe(2);
    const call = writeSpy.mock.calls[0]?.[0];
    expect(call?.commitMessage.split("\n")[0]).toContain("[index-rebuild]");
    const indexPage = await wikiAdapter.readPage(DOMAIN, "index.md");
    expect(indexPage?.content).toContain("- strategy/q3.md");
    expect(indexPage?.content).toContain("- executive/log.md");
  });

  it("is a no-op when the regenerated index equals the existing one", async () => {
    const { wikiAdapter, wikiDeps } = harness();
    wikiAdapter.inject(DOMAIN, "strategy/q3.md", "# Q3\n");
    // First run lays down the index.
    await runIndexRebuilder({
      domainSlug: "test-domain",
      wikiDeps,
      wikiAdapter,
      logger: silentLogger(),
      author: REBUILDER_AUTHOR,
    });
    // Second run with the same file set should be a no-op.
    const writeSpy = vi.spyOn(wikiAdapter, "writeAtomic");
    const result = await runIndexRebuilder({
      domainSlug: "test-domain",
      wikiDeps,
      wikiAdapter,
      logger: silentLogger(),
      author: REBUILDER_AUTHOR,
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(result.commitSha).toBeNull();
    // fileCount is the listMarkdown count (includes index.md
    // itself, which buildIndexBody filters out from its listing).
    // After the first run there's strategy/q3.md + index.md = 2.
    expect(result.fileCount).toBe(2);
  });
});
