/**
 * McpServer factory. Tools and resources are registered against a fresh
 * `McpServer` on every call to `createMcpServer()`; the long-lived state
 * (RepoRegistry, GiteaScopeChecker) is constructed once and captured by
 * closure so per-request servers stay cheap and identical.
 *
 * Why a factory instead of a singleton? The Streamable HTTP transport
 * couples a `Server` and a `Transport` 1:1: calling
 * `server.connect(transport)` while the same `server` already has a transport
 * raises "Already connected to a transport. Call close() before connecting
 * to a new transport, or use a separate Protocol instance per connection."
 * The upstream SDK's stateless example (`simpleStatelessStreamableHttp.ts`)
 * builds a fresh server per request — that's the pattern we mirror in
 * `http/server.ts`. The stdio path still spins up exactly one server via
 * `createMcpServer()` once at boot.
 *
 * When a new tool or resource lands, add its register call in
 * `registerAllToolsAndResources()` — both transports inherit it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO } from "./constants.js";
import type { Config } from "./config.js";
import { RepoRegistry } from "./services/repo-registry.js";
import {
  createGiteaScopeChecker,
  type GiteaScopeChecker,
} from "./services/scope-checker.js";
import { registerWorldviewResource } from "./resources/worldview.js";
import { registerWikiResources } from "./resources/wiki.js";
import { registerWikiToc } from "./tools/wiki-toc.js";
import { registerWikiRead } from "./tools/wiki-read.js";
import { registerWikiSearch } from "./tools/wiki-search.js";
import { registerWikiFrontmatterIndex } from "./tools/wiki-frontmatter.js";
import { registerWikiBacklinks } from "./tools/wiki-backlinks.js";
import { registerWikiRecentChanges } from "./tools/wiki-recent-changes.js";

export interface ServerBundle {
  /** Build a fresh, fully-registered `McpServer`. Each call returns an
   *  independent instance suitable for binding to a single transport. The
   *  HTTP path calls this per-request; stdio calls it once at boot. */
  readonly createMcpServer: () => McpServer;
  readonly registry: RepoRegistry;
  readonly scopeChecker: GiteaScopeChecker;
}

export function createServer(config: Config): ServerBundle {
  const registry = new RepoRegistry(config);
  const scopeChecker = createGiteaScopeChecker({
    giteaBaseUrl: config.giteaBaseUrl,
  });

  const createMcpServer = (): McpServer => {
    const server = new McpServer(
      {
        name: SERVER_INFO.name,
        version: SERVER_INFO.version,
      },
      {
        capabilities: {
          tools: {},
          // worldview:// exposes compiled per-domain synthesis as an MCP
          // resource; declaring the capability tells SDK clients to list it.
          resources: {},
        },
      },
    );

    registerAllToolsAndResources(server, registry, scopeChecker);

    // SDK 1.29 automatically adds `execution: { taskSupport: "forbidden" }`
    // to every tool registered via server.tool(). This field is not part of
    // the MCP 2024-11-05 or 2025-06-18 specs and ChatGPT interprets
    // "forbidden" as "this tool is blocked". Strip it from every registered
    // tool.
    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { execution?: unknown }>;
      }
    )._registeredTools;
    for (const tool of Object.values(tools)) {
      delete tool.execution;
    }

    return server;
  };

  return { createMcpServer, registry, scopeChecker };
}

function registerAllToolsAndResources(
  server: McpServer,
  registry: RepoRegistry,
  scopeChecker: GiteaScopeChecker,
): void {
  registerWikiToc(server, registry);
  registerWikiRead(server, registry);
  registerWikiSearch(server, registry);
  registerWikiFrontmatterIndex(server, registry);
  registerWikiBacklinks(server, registry);
  registerWikiRecentChanges(server, registry);

  registerWorldviewResource(
    server,
    registry,
    scopeChecker,
    (reason, detail) => {
      // Operator-facing only; never exposes the deny reason to clients.
      console.error(
        `[worldview] deny reason=${reason} ${JSON.stringify(detail)}`,
      );
    },
  );
  registerWikiResources(server, registry, scopeChecker, (reason, detail) => {
    // Operator-facing only; never exposes the deny reason to clients.
    console.error(`[wiki] deny reason=${reason} ${JSON.stringify(detail)}`);
  });
}
