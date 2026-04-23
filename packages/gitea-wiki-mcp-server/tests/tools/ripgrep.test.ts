import { describe, it, expect } from "vitest";
import path from "node:path";
import { searchRepo, RipgrepError } from "../../src/services/ripgrep.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-wiki");

describe("searchRepo against sample-wiki", () => {
  it("finds a unique substring with line + path", async () => {
    const result = await searchRepo({
      query: "three pillars",
      cwd: FIXTURE,
      limit: 10,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    const hit = result.hits[0]!;
    expect(hit.path).toBe("strategy/fundamentals.md");
    expect(hit.line_no).toBeGreaterThan(0);
    expect(hit.snippet.toLowerCase()).toContain("pillars");
    expect(result.truncated).toBe(false);
    expect(result.total_hit_count).toBe(result.hits.length);
  });

  it("is smart-case: lowercase query matches mixed-case text", async () => {
    const result = await searchRepo({
      query: "engineering",
      cwd: FIXTURE,
      limit: 20,
    });
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("returns 0 hits for nonsense query without error", async () => {
    const result = await searchRepo({
      query: "thisStringDoesNotExistAnywhere",
      cwd: FIXTURE,
      limit: 10,
    });
    expect(result.hits).toEqual([]);
    expect(result.total_hit_count).toBe(0);
  });

  it("respects path_glob", async () => {
    const result = await searchRepo({
      query: "backlog",
      cwd: FIXTURE,
      pathGlob: "projects/**/*.md",
      limit: 20,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((h) => h.path.startsWith("projects/"))).toBe(true);
  });

  it("rejects path_glob with unsafe characters", async () => {
    await expect(
      searchRepo({
        query: "anything",
        cwd: FIXTURE,
        pathGlob: "../../../etc/*",
        limit: 10,
      }),
    ).rejects.toThrow(RipgrepError);
  });

  it("rejects empty query", async () => {
    await expect(
      searchRepo({ query: "", cwd: FIXTURE, limit: 10 }),
    ).rejects.toThrow(RipgrepError);
  });
});
