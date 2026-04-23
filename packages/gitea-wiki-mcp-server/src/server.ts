/**
 * McpServer factory. Tools are registered here — when a new tool lands, add
 * its register call in `registerAllTools()`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO } from "./constants.js";
import type { Config } from "./config.js";
import { RepoRegistry } from "./services/repo-registry.js";
import { registerWikiToc } from "./tools/wiki-toc.js";
import { registerWikiRead } from "./tools/wiki-read.js";
import { registerWikiSearch } from "./tools/wiki-search.js";
import { registerWikiFrontmatterIndex } from "./tools/wiki-frontmatter.js";
import { registerWikiBacklinks } from "./tools/wiki-backlinks.js";
import { registerWikiRecentChanges } from "./tools/wiki-recent-changes.js";

export interface ServerBundle {
  server: McpServer;
  registry: RepoRegistry;
}

export function createServer(config: Config): ServerBundle {
  const server = new McpServer(
    {
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const registry = new RepoRegistry(config);
  registerAllTools(server, registry);

  // SDK 1.29 automatically adds `execution: { taskSupport: "forbidden" }` to
  // every tool registered via server.tool(). This field is not part of the MCP
  // 2024-11-05 or 2025-06-18 specs and ChatGPT interprets "forbidden" as
  // "this tool is blocked". Strip it from every registered tool.
  const tools = (server as unknown as { _registeredTools: Record<string, { execution?: unknown }> })
    ._registeredTools;
  for (const tool of Object.values(tools)) {
    delete tool.execution;
  }

  return { server, registry };
}

function registerAllTools(server: McpServer, registry: RepoRegistry): void {
  registerWikiToc(server, registry);
  registerWikiRead(server, registry);
  registerWikiSearch(server, registry);
  registerWikiFrontmatterIndex(server, registry);
  registerWikiBacklinks(server, registry);
  registerWikiRecentChanges(server, registry);
}
