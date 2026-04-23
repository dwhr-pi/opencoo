#!/usr/bin/env node
/**
 * HTTP smoke test: boot server in MCP_MODE=http, hit /health, then send
 * JSON-RPC to /mcp with bearer auth. Verifies tool list + 2 tool calls.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "sample-wiki");

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-mcp-http-"));
const repoDir = path.join(tmpDataDir, "repos", "fixture");
fs.mkdirSync(path.join(tmpDataDir, "index"), { recursive: true });
fs.mkdirSync(path.dirname(repoDir), { recursive: true });
fs.cpSync(FIXTURE, repoDir, { recursive: true });
fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
fs.writeFileSync(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

const PORT = 33215;
const TOKEN = "smoke_http_token_1234567890abcdef";

const WEBHOOK_SECRET = "webhook_secret_abcdef1234567890";
const PUBLIC_URL = `http://127.0.0.1:${PORT}`;
const OAUTH_CLIENT_ID = "smoke-client-id-abcdef";
const OAUTH_CLIENT_SECRET = "smoke-client-secret-1234567890";
const env = {
  ...process.env,
  MCP_MODE: "http",
  MCP_BEARER_TOKEN: TOKEN,
  GITEA_PAT: "fake",
  GITEA_BASE_URL: "https://gitea.example.com",
  REPOS: JSON.stringify([
    { slug: "fixture", owner: "x", name: "y", default: true },
  ]),
  DATA_DIR: tmpDataDir,
  SYNC_INTERVAL_MIN: "0",
  PORT: String(PORT),
  HOST: "127.0.0.1",
  GITEA_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PUBLIC_URL,
  GITEA_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
  GITEA_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
  CORS_ORIGINS: "https://chatgpt.com",
};

const child = spawn("node", [path.join(ROOT, "dist", "index.js")], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));

function cleanup(code) {
  child.kill("SIGTERM");
  try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

async function waitForReady() {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {}
  }
  throw new Error("server did not come up");
}

async function rpc(token, body) {
  const headers = { "Content-Type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  await waitForReady();

  console.log("1. GET /health (no auth)...");
  const h = await fetch(`http://127.0.0.1:${PORT}/health`);
  if (h.status !== 200) throw new Error(`health returned ${h.status}`);
  const hj = await h.json();
  console.log("  OK:", hj.service, hj.version, "repos=" + hj.repos.join(","));

  console.log("2. POST /mcp without bearer → 401...");
  const noauth = await rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  if (noauth.status !== 401) throw new Error(`expected 401, got ${noauth.status}`);
  console.log("  OK: 401");

  console.log("3. POST /mcp with bearer → initialize...");
  const init = await rpc(TOKEN, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  if (init.status !== 200) throw new Error(`initialize returned ${init.status}: ${init.body}`);
  const initMsg = JSON.parse(init.body);
  console.log("  OK:", initMsg.result.serverInfo.name);

  // Initialized notification (no response expected)
  await rpc(TOKEN, { jsonrpc: "2.0", method: "notifications/initialized" });

  console.log("4. tools/list...");
  const list = await rpc(TOKEN, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listMsg = JSON.parse(list.body);
  const names = listMsg.result.tools.map((t) => t.name);
  console.log("  OK:", names.join(", "));
  const expected = ["wiki_toc", "wiki_read", "wiki_search", "wiki_frontmatter_index", "wiki_backlinks", "wiki_recent_changes"];
  for (const n of expected) if (!names.includes(n)) throw new Error("missing tool " + n);

  console.log("5. tools/call wiki_toc...");
  const toc = await rpc(TOKEN, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "wiki_toc", arguments: { response_format: "json" } },
  });
  const tocMsg = JSON.parse(toc.body);
  const total = tocMsg.result.structuredContent.total;
  console.log("  OK: total=" + total);
  if (total !== 6) throw new Error("expected 6 pages");

  console.log("6. POST /refresh/fixture without signature → 401 (secret set)...");
  const refNoSig = await fetch(`http://127.0.0.1:${PORT}/refresh/fixture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (refNoSig.status !== 401) throw new Error("expected 401, got " + refNoSig.status);
  console.log("  OK: 401");

  console.log("7. POST /refresh/fixture with valid signature...");
  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify({ ref: "refs/heads/main" });
  const sig = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const refOk = await fetch(`http://127.0.0.1:${PORT}/refresh/fixture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gitea-Signature": sig },
    body,
  });
  // Pull will fail on our fake .git, but the endpoint should accept auth and
  // return 500 (pull_failed). That proves the HMAC check passed.
  const refJson = await refOk.json();
  if (refOk.status === 401) throw new Error("HMAC rejected valid signature");
  console.log("  OK: status=" + refOk.status + " (HMAC accepted, pull may still error on fake repo)");

  console.log("8. GET /.well-known/oauth-protected-resource...");
  const pr = await fetch(`http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource`);
  if (pr.status !== 200) throw new Error(`oauth-protected-resource returned ${pr.status}`);
  const prJson = await pr.json();
  if (prJson.resource !== `${PUBLIC_URL}/mcp`) throw new Error("wrong resource");
  if (!Array.isArray(prJson.authorization_servers) || prJson.authorization_servers[0] !== PUBLIC_URL)
    throw new Error("wrong authorization_servers");
  console.log("  OK:", prJson.resource);

  console.log("9. GET /.well-known/oauth-authorization-server...");
  const as = await fetch(`http://127.0.0.1:${PORT}/.well-known/oauth-authorization-server`);
  if (as.status !== 200) throw new Error(`oauth-authorization-server returned ${as.status}`);
  const asJson = await as.json();
  if (asJson.issuer !== PUBLIC_URL) throw new Error("wrong issuer");
  if (!asJson.authorization_endpoint.includes("/login/oauth/authorize"))
    throw new Error("wrong authorization_endpoint");
  if (!asJson.code_challenge_methods_supported.includes("S256"))
    throw new Error("S256 missing");
  console.log("  OK:", asJson.issuer, "→", asJson.authorization_endpoint);

  console.log("10. POST /oauth/register (DCR proxy)...");
  const dcr = await fetch(`http://127.0.0.1:${PORT}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_name: "Smoke Test",
    }),
  });
  if (dcr.status !== 201) throw new Error(`DCR returned ${dcr.status}: ${await dcr.text()}`);
  const dcrJson = await dcr.json();
  if (dcrJson.client_id !== OAUTH_CLIENT_ID) throw new Error("DCR wrong client_id");
  if (dcrJson.client_secret !== OAUTH_CLIENT_SECRET) throw new Error("DCR wrong client_secret");
  console.log("  OK: client_id=" + dcrJson.client_id.slice(0, 12) + "…");

  console.log("11. POST /mcp (no auth) → 401 with WWW-Authenticate resource_metadata...");
  const unauth = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "s", version: "1" } } }),
  });
  if (unauth.status !== 401) throw new Error(`expected 401, got ${unauth.status}`);
  const www = unauth.headers.get("www-authenticate") ?? "";
  if (!www.includes("resource_metadata=")) throw new Error("missing resource_metadata hint: " + www);
  if (!www.includes("/.well-known/oauth-protected-resource")) throw new Error("hint wrong: " + www);
  console.log("  OK: WWW-Authenticate=" + www);

  console.log("12. GET /mcp → 405 Allow: POST...");
  const getMcp = await fetch(`http://127.0.0.1:${PORT}/mcp`);
  if (getMcp.status !== 405) throw new Error(`expected 405 on GET /mcp, got ${getMcp.status}`);
  if (getMcp.headers.get("allow") !== "POST") throw new Error("missing Allow: POST");
  console.log("  OK: 405 Allow: POST");

  console.log("13. POST /refresh/unknown with valid signature → 404...");
  const sig2 = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const refUnk = await fetch(`http://127.0.0.1:${PORT}/refresh/unknown`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gitea-Signature": sig2 },
    body,
  });
  if (refUnk.status !== 404) throw new Error("expected 404, got " + refUnk.status);
  console.log("  OK: 404");

  console.log("\nALL HTTP SMOKE TESTS PASSED");
  cleanup(0);
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err.message);
  cleanup(1);
});
