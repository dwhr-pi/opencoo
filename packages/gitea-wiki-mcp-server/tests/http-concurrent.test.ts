/**
 * Concurrency regression for `/mcp` POST. The pre-fix transport wired a fresh
 * `StreamableHTTPServerTransport` per request to a SINGLE shared `McpServer`,
 * so two POSTs racing through `mcpServer.connect(transport)` collided with
 * "Already connected to a transport. Call close() before connecting to a new
 * transport, or use a separate Protocol instance per connection." The lint
 * agent dispatches ≥ 4 resource reads in fast succession, which is what
 * surfaced the bug live.
 *
 * The fix per the upstream SDK example (`simpleStatelessStreamableHttp.ts`)
 * is per-request: build a fresh `McpServer` AND `StreamableHTTPServerTransport`
 * for each POST, sharing only the closure-captured handler state (registry +
 * scope checker). This test fires 8 concurrent `resources/read` against a real
 * fixture wiki and asserts every response is HTTP 200 with a JSON-RPC `result`
 * — no "Already connected" errors. Run against the unfixed shared-server
 * pattern and the test fails with that exact string.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startHttpServer, type HttpServerHandle } from "../src/http/server.js";
import { createServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import type { GitSync } from "../src/sync/git-sync.js";

const STATIC_BEARER = "static-token-0123456789abcdef-long-enough";

/** Stub GitSync — the /mcp path never touches it; only /refresh does, and we
 *  don't exercise that route here. */
function stubGitSync(): GitSync {
  return {
    async pullOne() {
      return { changed: false };
    },
    async rebuildIndex() {
      return undefined;
    },
    async ensureAllCloned() {
      return undefined;
    },
    startScheduler() {
      return undefined;
    },
    stopScheduler() {
      return undefined;
    },
  } as unknown as GitSync;
}

function makeConfig(dataDir: string): Config {
  return {
    mcpMode: "http",
    port: 0,
    host: "127.0.0.1",
    bearerToken: STATIC_BEARER,
    giteaPat: "pat",
    giteaBaseUrl: "http://gitea.local",
    repos: [
      {
        slug: "exec",
        owner: "opencoo",
        name: "wiki-exec",
        default: true,
        aggregator: false,
      },
    ],
    dataDir,
    syncIntervalMin: 0,
    giteaWebhookSecret: "",
    logLevel: "info",
    corsOrigins: "",
  };
}

interface BootedServer {
  readonly url: string;
  readonly handle: HttpServerHandle;
  readonly tmpRoot: string;
}

async function boot(): Promise<BootedServer> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "http-concurrent-"));
  const execRoot = path.join(tmpRoot, "repos", "exec");
  fs.mkdirSync(path.join(execRoot, "team"), { recursive: true });
  fs.writeFileSync(
    path.join(execRoot, "team", "eng.md"),
    "---\ntitle: Engineering\n---\n\nSENTINEL-EXEC-TEAM-ENG\n",
  );
  fs.writeFileSync(
    path.join(execRoot, "index.md"),
    "# Index\n\nSENTINEL-EXEC-INDEX\n",
  );

  const config = makeConfig(tmpRoot);
  const { createMcpServer, registry } = createServer(config);
  const handle = await startHttpServer(
    config,
    createMcpServer,
    registry,
    stubGitSync(),
  );

  // `port: 0` lets the OS pick a free port. The Q12 fix exposes the bound
  // AddressInfo on `HttpServerHandle.address` so tests can resolve the
  // assigned port without parsing log output.
  const url = `http://${handle.address.address}:${handle.address.port}`;
  return { url, handle, tmpRoot };
}

describe("/mcp POST — concurrent resources/read", () => {
  let booted: BootedServer;

  beforeAll(async () => {
    booted = await boot();
  });

  afterAll(async () => {
    await booted.handle.close();
    fs.rmSync(booted.tmpRoot, { recursive: true, force: true });
  });

  it("handles 8 concurrent resources/read POSTs without 'Already connected' errors", async () => {
    const requests = Array.from({ length: 8 }, (_, i) => ({
      jsonrpc: "2.0" as const,
      id: i + 1,
      method: "resources/read" as const,
      params: { uri: "wiki://exec/team/eng.md" },
    }));

    const responses = await Promise.all(
      requests.map((body) =>
        fetch(`${booted.url}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${STATIC_BEARER}`,
            "Content-Type": "application/json",
            // Streamable HTTP transport requires the client to advertise it
            // accepts both JSON and SSE; the SDK transport rejects requests
            // that omit text/event-stream from Accept.
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        }).then(async (res) => {
          const text = await res.text();
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // Non-JSON body (could be SSE event-stream chunks). Capture the
            // raw text so the assertions can still inspect for the
            // "Already connected" sentinel.
          }
          return { status: res.status, json, text };
        }),
      ),
    );

    // Each POST must succeed independently. Pre-fix, racing POSTs trip
    // the "Already connected to a transport" guard inside the SDK
    // Protocol class — but the SDK masks the underlying message, so
    // racing requests surface as `{ "code": -32603, "message":
    // "Internal error" }` with HTTP 500 (verified locally on the
    // shared-server pattern: 6/8 fail). The HTTP-200 + JSON-RPC-result
    // assertions catch the regression definitively. The body-substring
    // guards are kept as belt-and-braces in case a future SDK release
    // surfaces the original error string verbatim.
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("Already connected");
      expect(r.text).not.toContain("connect()");
      // Must be a JSON-RPC result, not an error.
      expect(r.json).not.toBeNull();
      expect(r.json).toHaveProperty("result");
      expect(r.json).not.toHaveProperty("error");
    }

    // The result payload should carry the wiki body — sanity check that the
    // shared registry/scopeChecker closure still works under per-request
    // server construction.
    const first = responses[0]?.json as
      | { result?: { contents?: Array<{ text?: string }> } }
      | undefined;
    const text = first?.result?.contents?.[0]?.text ?? "";
    expect(text).toContain("SENTINEL-EXEC-TEAM-ENG");
  });
});
