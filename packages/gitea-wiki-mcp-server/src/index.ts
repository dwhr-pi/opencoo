#!/usr/bin/env node
/**
 * gitea-wiki-mcp-server entry point.
 *
 * Routes to stdio or streamable-HTTP transport based on MCP_MODE env.
 * Stdio is default (Claude Code local usage); HTTP is for multi-client remote
 * deployments.
 *
 * CRITICAL: stdio transport uses stdout for JSON-RPC traffic. All logs
 * MUST go to stderr (`console.error`) — never `console.log`.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { GitSync } from "./sync/git-sync.js";
import { startHttpServer } from "./http/server.js";

async function runStdio(): Promise<void> {
  const config = loadConfig();
  const { server, registry } = createServer(config);

  const gitSync = new GitSync(config, registry);
  await gitSync.ensureAllCloned();
  gitSync.startScheduler();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `gitea-wiki-mcp-server ready on stdio (repos: ${config.repos.map((r) => r.slug).join(", ")})`,
  );

  const shutdown = (): void => {
    gitSync.stopScheduler();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runHttp(): Promise<void> {
  const config = loadConfig();
  const { server, registry } = createServer(config);

  const gitSync = new GitSync(config, registry);
  await gitSync.ensureAllCloned();
  gitSync.startScheduler();

  const http = await startHttpServer(config, server, registry, gitSync);

  const shutdown = (): void => {
    console.error("[http] shutting down...");
    gitSync.stopScheduler();
    http
      .close()
      .catch((err) => console.error(`[http] close error: ${err instanceof Error ? err.message : err}`))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const mode = process.env.MCP_MODE ?? "stdio";
  if (mode === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
