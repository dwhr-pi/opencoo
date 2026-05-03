import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import {
  createWikiReader,
  createWikiLister,
  WIKI_LIST_CAP,
} from "../../src/resources/wiki.js";
import type { GiteaScopeChecker } from "../../src/services/scope-checker.js";
import { RepoRegistry } from "../../src/services/repo-registry.js";
import type { Config, RepoEntry } from "../../src/config.js";

// Minimal AuthInfo shape used in these tests. Matches the worldview-resource
// test's shape so both suites stay aligned.
interface TestAuthInfo {
  readonly token: string;
  readonly clientId?: string;
  readonly scopes: readonly string[];
  readonly extra?: { readonly kind?: "static" | "gitea" };
}

function spyOnlyScopeChecker(): GiteaScopeChecker & {
  readonly spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn();
  return {
    check: spy as unknown as GiteaScopeChecker["check"],
    invalidate: () => undefined,
    spy,
  };
}

function allowingScopeChecker(): GiteaScopeChecker {
  return {
    async check() {
      return { allow: true };
    },
    invalidate() {},
  };
}

function denyingScopeChecker(): GiteaScopeChecker {
  return {
    async check() {
      return { allow: false };
    },
    invalidate() {},
  };
}

function freshRegistry(
  entries: ReadonlyArray<RepoEntry>,
  dataDir: string,
): RepoRegistry {
  const config: Config = {
    mcpMode: "stdio",
    port: 3000,
    host: "127.0.0.1",
    bearerToken: "x".repeat(32),
    giteaPat: "pat",
    giteaBaseUrl: "http://gitea.local",
    repos: [...entries],
    dataDir,
    syncIntervalMin: 0,
    giteaWebhookSecret: "",
    logLevel: "info",
    corsOrigins: "",
  };
  return new RepoRegistry(config);
}

const STATIC_AUTH: TestAuthInfo = {
  token: "static-token",
  scopes: [],
  extra: { kind: "static" },
};
const OAUTH_AUTH: TestAuthInfo = {
  token: "oauth-token-abc",
  scopes: [],
  extra: { kind: "gitea" },
};

function baseEntries(): RepoEntry[] {
  return [
    {
      slug: "exec",
      owner: "opencoo",
      name: "wiki-exec",
      default: true,
      aggregator: false,
    },
    {
      slug: "hr",
      owner: "opencoo",
      name: "wiki-hr",
      default: false,
      aggregator: false,
    },
  ];
}

describe("wiki resource — reader", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-resource-test-"));
    const execRoot = path.join(tmpRoot, "repos", "exec");
    fs.mkdirSync(path.join(execRoot, "team"), { recursive: true });
    fs.writeFileSync(
      path.join(execRoot, "team", "eng.md"),
      "---\ntitle: Engineering\n---\nSENTINEL-EXEC-TEAM-ENG\n",
    );
    fs.writeFileSync(
      path.join(execRoot, "index.md"),
      "# Index\nSENTINEL-EXEC-INDEX\n",
    );
    // Second repo (no fixtures other than dir) — used by lister tests.
    fs.mkdirSync(path.join(tmpRoot, "repos", "hr"), { recursive: true });
  });

  it("returns body for an allowed slug+path (static principal, no scope check)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const checker = spyOnlyScopeChecker();
    const reader = createWikiReader({ registry, scopeChecker: checker });
    const result = await reader(new URL("wiki://exec/team/eng.md"), {
      authInfo: STATIC_AUTH,
    });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content?.uri).toBe("wiki://exec/team/eng.md");
    expect(content?.mimeType).toBe("text/markdown");
    expect(content?.text).toContain("SENTINEL-EXEC-TEAM-ENG");
    // Static principal bypasses the scope check.
    expect(checker.spy).not.toHaveBeenCalled();
  });

  it("denies OAuth principal when scope check returns allow:false", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWikiReader({
      registry,
      scopeChecker: denyingScopeChecker(),
    });
    let caught: unknown;
    try {
      await reader(new URL("wiki://exec/team/eng.md"), {
        authInfo: OAUTH_AUTH,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InvalidRequest);
    expect((caught as McpError).message).toMatch(/not accessible/i);
    // Body must NOT have leaked into the error message.
    expect((caught as McpError).message).not.toContain("SENTINEL");
  });

  it("denies path traversal even on a known slug (uniform message)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWikiReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    // safeResolve() rejects `..` segments; the deny path returns the same
    // uniform "not accessible" McpError.
    const traversalUri = new URL("wiki://exec/x");
    // Directly construct a URL whose pathname contains `..` segments by
    // mutating after parse — `new URL("wiki://exec/../etc/passwd")` would
    // be normalized away by WHATWG URL. Instead we set pathname raw.
    Object.defineProperty(traversalUri, "pathname", {
      value: "/../etc/passwd",
      configurable: true,
    });
    Object.defineProperty(traversalUri, "href", {
      value: "wiki://exec/../etc/passwd",
      configurable: true,
    });
    await expect(
      reader(traversalUri, { authInfo: STATIC_AUTH }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("denies an unknown slug uniformly", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWikiReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    await expect(
      reader(new URL("wiki://nonexistent/team/eng.md"), {
        authInfo: STATIC_AUTH,
      }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("denies a missing file uniformly", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWikiReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    await expect(
      reader(new URL("wiki://exec/team/notthere.md"), {
        authInfo: STATIC_AUTH,
      }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("denies when authInfo is missing", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWikiReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    await expect(
      reader(new URL("wiki://exec/team/eng.md"), {}),
    ).rejects.toThrow(/not accessible/i);
  });

  it("denies when slug is missing (no authority component)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWikiReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    // `wiki:/team/eng.md` (single slash) parses with empty hostname.
    await expect(
      reader(new URL("wiki:/team/eng.md"), { authInfo: STATIC_AUTH }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("denies when path is empty (no page selected)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWikiReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    await expect(
      reader(new URL("wiki://exec/"), { authInfo: STATIC_AUTH }),
    ).rejects.toThrow(/not accessible/i);
  });

  it("allows OAuth principal when scope check returns allow:true", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const reader = createWikiReader({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    const result = await reader(new URL("wiki://exec/team/eng.md"), {
      authInfo: OAUTH_AUTH,
    });
    expect(result.contents[0]?.text).toContain("SENTINEL-EXEC-TEAM-ENG");
  });

  it("passes the OAuth principal's token to the scope checker (cross-PAT no-leak)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const calls: Array<{ token: string; owner: string; name: string }> = [];
    const checker: GiteaScopeChecker = {
      async check(token, owner, name) {
        calls.push({ token, owner, name });
        return { allow: token === "ok-token" };
      },
      invalidate() {},
    };
    const reader = createWikiReader({ registry, scopeChecker: checker });
    await expect(
      reader(new URL("wiki://exec/team/eng.md"), {
        authInfo: { token: "bad-token", scopes: [], extra: { kind: "gitea" } },
      }),
    ).rejects.toThrow(/not accessible/i);
    const ok = await reader(new URL("wiki://exec/team/eng.md"), {
      authInfo: { token: "ok-token", scopes: [], extra: { kind: "gitea" } },
    });
    expect(ok.contents[0]?.text).toContain("SENTINEL-EXEC-TEAM-ENG");
    expect(calls).toEqual([
      { token: "bad-token", owner: "opencoo", name: "wiki-exec" },
      { token: "ok-token", owner: "opencoo", name: "wiki-exec" },
    ]);
  });

  it("invokes the operator log on every deny path with no body bytes", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const logs: Array<{ reason: string; detail: Record<string, unknown> }> = [];
    const reader = createWikiReader({
      registry,
      scopeChecker: denyingScopeChecker(),
      log: (reason, detail) => logs.push({ reason, detail }),
    });
    await expect(
      reader(new URL("wiki://exec/team/eng.md"), { authInfo: OAUTH_AUTH }),
    ).rejects.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.reason).toBe("out_of_scope");
    // The operator log must NOT include any page-content bytes.
    const detailJson = JSON.stringify(logs[0]?.detail ?? {});
    expect(detailJson).not.toContain("SENTINEL");
  });
});

describe("wiki resource — lister", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-lister-test-"));
    // exec repo with three .md pages and one non-.md file.
    const execRoot = path.join(tmpRoot, "repos", "exec");
    fs.mkdirSync(path.join(execRoot, "team"), { recursive: true });
    fs.mkdirSync(path.join(execRoot, "ops"), { recursive: true });
    fs.writeFileSync(path.join(execRoot, "index.md"), "# Index\n");
    fs.writeFileSync(path.join(execRoot, "team", "eng.md"), "# Eng\n");
    fs.writeFileSync(path.join(execRoot, "team", "notes.txt"), "ignored\n");
    fs.writeFileSync(path.join(execRoot, "ops", "runbook.md"), "# Runbook\n");
    fs.writeFileSync(path.join(execRoot, "ops", "diagram.png"), "ignored\n");
    // hr repo (separate slug; lister returns from ALL repos when prefix
    // is just `wiki://`, but per-slug prefix scopes to one repo).
    const hrRoot = path.join(tmpRoot, "repos", "hr");
    fs.mkdirSync(hrRoot, { recursive: true });
    fs.writeFileSync(path.join(hrRoot, "policies.md"), "# Policies\n");
  });

  it("lists all .md pages across configured repos as wiki:// URIs", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const lister = createWikiLister({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    const result = await lister({ authInfo: STATIC_AUTH });
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("wiki://exec/index.md");
    expect(uris).toContain("wiki://exec/team/eng.md");
    expect(uris).toContain("wiki://exec/ops/runbook.md");
    expect(uris).toContain("wiki://hr/policies.md");
    // Non-.md files must NOT appear.
    for (const uri of uris) {
      expect(uri.endsWith(".md")).toBe(true);
    }
    // Must be sorted.
    const sorted = [...uris].sort();
    expect(uris).toEqual(sorted);
    // Each entry must carry the markdown mime type so MCP clients render it
    // as text instead of treating it as opaque.
    for (const r of result.resources) {
      expect(r.mimeType).toBe("text/markdown");
    }
  });

  it("static principal bypasses the per-repo scope check", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const checker = spyOnlyScopeChecker();
    const lister = createWikiLister({
      registry,
      scopeChecker: checker,
    });
    const result = await lister({ authInfo: STATIC_AUTH });
    expect(result.resources.length).toBeGreaterThan(0);
    expect(checker.spy).not.toHaveBeenCalled();
  });

  it("OAuth principal: only repos the PAT can see appear (uniform deny → omit)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const checker: GiteaScopeChecker = {
      async check(_token, _owner, name) {
        return { allow: name === "wiki-exec" };
      },
      invalidate() {},
    };
    const lister = createWikiLister({
      registry,
      scopeChecker: checker,
    });
    const result = await lister({ authInfo: OAUTH_AUTH });
    const uris = result.resources.map((r) => r.uri);
    expect(uris.some((u) => u.startsWith("wiki://exec/"))).toBe(true);
    // hr was denied — must not leak any page paths.
    expect(uris.some((u) => u.startsWith("wiki://hr/"))).toBe(false);
  });

  it("missing authInfo yields empty resources (uniform deny, no leakage)", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    const lister = createWikiLister({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    const result = await lister({});
    expect(result.resources).toEqual([]);
  });

  it("caps at WIKI_LIST_CAP entries even with more pages on disk", async () => {
    const registry = freshRegistry(baseEntries(), tmpRoot);
    // Seed exec with WIKI_LIST_CAP + 100 pages.
    const execRoot = path.join(tmpRoot, "repos", "exec");
    const overflowDir = path.join(execRoot, "overflow");
    fs.mkdirSync(overflowDir, { recursive: true });
    const target = WIKI_LIST_CAP + 100;
    for (let i = 0; i < target; i++) {
      fs.writeFileSync(path.join(overflowDir, `page-${i}.md`), `# Page ${i}\n`);
    }
    const lister = createWikiLister({
      registry,
      scopeChecker: allowingScopeChecker(),
    });
    const result = await lister({ authInfo: STATIC_AUTH });
    expect(result.resources).toHaveLength(WIKI_LIST_CAP);
  });
});
