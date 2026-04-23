import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { buildIndex, loadIndex } from "../../src/sync/index-builder.js";

const FIXTURE = path.resolve(__dirname, "../fixtures/sample-wiki");

describe("buildIndex against sample-wiki", () => {
  it("indexes every page with frontmatter + link graph", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idx-"));
    const out = path.join(tmp, "test.json");
    try {
      const idx = await buildIndex("test", FIXTURE, out);
      expect(idx.page_count).toBe(6);
      expect(idx.pages.map((p) => p.path).sort()).toEqual([
        "index.md",
        "no-frontmatter.md",
        "projects/bad-yaml-frontmatter.md",
        "projects/infra-backlog.md",
        "projects/platform-refresh.md",
        "strategy/fundamentals.md",
      ]);

      // Malformed YAML page is indexed with best-effort title, still discoverable.
      const bad = idx.pages.find((p) => p.path === "projects/bad-yaml-frontmatter.md")!;
      expect(bad.title).toBe("Pay to Play: A Strategic Plan");
      expect(bad.type).toBe("engineering-project");

      const fundamentals = idx.pages.find((p) => p.path === "strategy/fundamentals.md")!;
      expect(fundamentals.title).toBe("Engineering Principles");
      expect(fundamentals.type).toBe("strategy");
      expect(fundamentals.tags).toEqual(["north-star", "quality"]);
      // [[projects/platform-refresh]] resolves to projects/platform-refresh.md
      expect(fundamentals.outbound_links).toContain("projects/platform-refresh.md");
      // [backlog](../projects/infra-backlog.md) — relative to strategy/ → projects/infra-backlog.md
      expect(fundamentals.outbound_links).toContain("projects/infra-backlog.md");

      // Inbound links: fundamentals is linked from the platform-refresh project
      expect(fundamentals.inbound_links).toContain("projects/platform-refresh.md");

      // Non-frontmatter page handled gracefully
      const bare = idx.pages.find((p) => p.path === "no-frontmatter.md")!;
      expect(bare.title).toBe("no frontmatter"); // fallback swaps `-` for space
      expect(bare.tags).toEqual([]);
      expect(bare.type).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("persists + loads the index from disk", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idx-"));
    const out = path.join(tmp, "test.json");
    try {
      const built = await buildIndex("test", FIXTURE, out);
      const reloaded = await loadIndex(out);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.page_count).toBe(built.page_count);
      expect(reloaded!.pages[0]!.path).toBe(built.pages[0]!.path);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loadIndex returns null for missing file", async () => {
    const result = await loadIndex("/nonexistent/path/index.json");
    expect(result).toBeNull();
  });
});
