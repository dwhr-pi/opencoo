#!/usr/bin/env node
/**
 * Smoke test: spawn the server in stdio mode with the fixture repo mounted as
 * a pre-cloned data dir, then speak JSON-RPC. Verifies:
 *   1. initialize handshake
 *   2. tools/list returns the tools we registered
 *   3. wiki_toc call works (fixture has 5 pages)
 *   4. wiki_read call works
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "sample-wiki");

// Mount fixture as a pre-cloned repo so the server skips `git clone`.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-mcp-smoke-"));
const repoDir = path.join(tmpDataDir, "repos", "fixture");
fs.mkdirSync(path.join(tmpDataDir, "index"), { recursive: true });
fs.mkdirSync(path.dirname(repoDir), { recursive: true });
// Init a minimal fake .git so `git pull` doesn't no-op with fatal error.
// We'll just let simple-git fail on pull; the boot calls pullOne which we
// catch. The tools themselves only read the filesystem.
fs.cpSync(FIXTURE, repoDir, { recursive: true });
fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

const env = {
  ...process.env,
  MCP_BEARER_TOKEN: "smoke_token_1234567890abcdef",
  GITEA_PAT: "fake",
  GITEA_BASE_URL: "https://gitea.example.com",
  REPOS: JSON.stringify([
    { slug: "fixture", owner: "x", name: "y", default: true },
  ]),
  DATA_DIR: tmpDataDir,
  SYNC_INTERVAL_MIN: "0",
  MCP_MODE: "stdio",
};

const child = spawn("node", [path.join(ROOT, "dist", "index.js")], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const responses = [];
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      responses.push(msg);
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (err) {
      console.error("non-JSON line from server:", line);
    }
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[server] ${chunk}`);
});

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    child.stdin.write(msg);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 5000);
  });
}

async function main() {
  await new Promise((r) => setTimeout(r, 300)); // boot

  console.log("1. initialize...");
  const init = await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.1.0" },
  });
  if (init.error) throw new Error("initialize failed: " + JSON.stringify(init.error));
  console.log("  OK:", init.result.serverInfo.name, init.result.serverInfo.version);

  // Client must send initialized notification
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await new Promise((r) => setTimeout(r, 100));

  console.log("2. tools/list...");
  const list = await send("tools/list", {});
  if (list.error) throw new Error("tools/list failed: " + JSON.stringify(list.error));
  const toolNames = list.result.tools.map((t) => t.name);
  console.log("  OK:", toolNames.join(", "));
  const expected = ["wiki_toc", "wiki_read", "wiki_search", "wiki_frontmatter_index", "wiki_backlinks"];
  for (const name of expected) {
    if (!toolNames.includes(name)) throw new Error("missing tool: " + name);
  }

  console.log("3. tools/call wiki_toc...");
  const toc = await send("tools/call", {
    name: "wiki_toc",
    arguments: { response_format: "json" },
  });
  if (toc.error) throw new Error("wiki_toc call failed: " + JSON.stringify(toc.error));
  const tocStruct = toc.result.structuredContent;
  console.log("  OK: total=" + tocStruct.total + " pages");
  if (tocStruct.total !== 6) throw new Error(`expected 6 pages in fixture, got ${tocStruct.total}`);

  console.log("4. tools/call wiki_read strategy/fundamentals.md...");
  const read = await send("tools/call", {
    name: "wiki_read",
    arguments: { path: "strategy/fundamentals.md", response_format: "json" },
  });
  if (read.error) throw new Error("wiki_read call failed: " + JSON.stringify(read.error));
  const page = read.result.structuredContent;
  console.log("  OK: title=" + page.frontmatter.title);
  if (page.frontmatter.title !== "Engineering Principles") {
    throw new Error("wrong title in read response");
  }
  if (!page.body.includes("three pillars")) {
    throw new Error("body content missing expected text");
  }

  console.log("5. tools/call wiki_search 'three pillars'...");
  const search = await send("tools/call", {
    name: "wiki_search",
    arguments: { query: "three pillars", response_format: "json" },
  });
  if (search.error) throw new Error("wiki_search call failed: " + JSON.stringify(search.error));
  const hits = search.result.structuredContent.hits;
  console.log("  OK: " + hits.length + " hit(s), first: " + (hits[0]?.path ?? "(none)"));
  if (hits.length === 0 || hits[0].path !== "strategy/fundamentals.md") {
    throw new Error("expected a hit in strategy/fundamentals.md");
  }

  console.log("6. tools/call wiki_frontmatter_index type=strategy...");
  const fm = await send("tools/call", {
    name: "wiki_frontmatter_index",
    arguments: { type: "strategy", response_format: "json" },
  });
  if (fm.error) throw new Error("wiki_frontmatter_index failed: " + JSON.stringify(fm.error));
  const fmOut = fm.result.structuredContent;
  console.log("  OK: " + fmOut.total + " strategy pages, index_stale=" + fmOut.index_stale);
  if (fmOut.total !== 1 || fmOut.pages[0].path !== "strategy/fundamentals.md") {
    throw new Error("expected exactly 1 strategy page");
  }

  console.log("7. tools/call wiki_backlinks strategy/fundamentals.md...");
  const bl = await send("tools/call", {
    name: "wiki_backlinks",
    arguments: { path: "strategy/fundamentals.md", response_format: "json" },
  });
  if (bl.error) throw new Error("wiki_backlinks failed: " + JSON.stringify(bl.error));
  const blOut = bl.result.structuredContent;
  console.log("  OK: " + blOut.total + " backlink(s)");
  if (blOut.total === 0) {
    throw new Error("expected at least 1 backlink to strategy/fundamentals.md from projects/");
  }

  console.log("8. path-safety: wiki_read ../../../etc/passwd (expect error)...");
  const bad = await send("tools/call", {
    name: "wiki_read",
    arguments: { path: "../../../etc/passwd", response_format: "json" },
  });
  if (!bad.result.isError) {
    throw new Error("path-traversal read should have errored");
  }
  console.log("  OK: rejected");

  console.log("\nALL SMOKE TESTS PASSED");
  child.kill("SIGTERM");
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err.message);
  child.kill("SIGKILL");
  try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
