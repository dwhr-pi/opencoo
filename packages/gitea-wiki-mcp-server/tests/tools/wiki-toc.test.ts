import { describe, it, expect } from "vitest";
import path from "node:path";
import { listMarkdownPaths, readParsedPage } from "../../src/services/wiki-utils.js";

const FIXTURE_REPO = path.resolve(__dirname, "../fixtures/sample-wiki");

describe("wiki utils against sample-wiki fixture", () => {
  it("lists every markdown file, sorted, repo-relative", async () => {
    const paths = await listMarkdownPaths(FIXTURE_REPO);
    expect(paths).toEqual([
      "index.md",
      "no-frontmatter.md",
      "projects/bad-yaml-frontmatter.md",
      "projects/infra-backlog.md",
      "projects/platform-refresh.md",
      "strategy/fundamentals.md",
    ]);
  });

  it("tolerates pages with malformed YAML frontmatter (unquoted colons)", async () => {
    const abs = path.join(FIXTURE_REPO, "projects/bad-yaml-frontmatter.md");
    const page = await readParsedPage(FIXTURE_REPO, abs);
    // Fallback extracts the title and type from raw text.
    expect(page.frontmatter.title).toBe("Pay to Play: A Strategic Plan");
    expect(page.frontmatter.type).toBe("engineering-project");
    // Body is the whole raw file since YAML parsing failed.
    expect(page.body).toContain("unquoted colon");
  });

  it("parses frontmatter and body separately", async () => {
    const abs = path.join(FIXTURE_REPO, "strategy/fundamentals.md");
    const page = await readParsedPage(FIXTURE_REPO, abs);
    expect(page.path).toBe("strategy/fundamentals.md");
    expect(page.frontmatter.title).toBe("Engineering Principles");
    expect(page.frontmatter.type).toBe("strategy");
    expect(page.frontmatter.tags).toEqual(["north-star", "quality"]);
    expect(page.body).toContain("three pillars");
    expect(page.body).not.toContain("---");
    expect(page.size).toBeGreaterThan(100);
    expect(page.modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("tolerates pages without frontmatter", async () => {
    const abs = path.join(FIXTURE_REPO, "no-frontmatter.md");
    const page = await readParsedPage(FIXTURE_REPO, abs);
    expect(page.frontmatter).toEqual({});
    expect(page.body).toContain("Page Without Frontmatter");
  });
});
