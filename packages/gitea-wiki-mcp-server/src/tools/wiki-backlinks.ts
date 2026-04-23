/**
 * wiki_backlinks — list pages that link TO a given page. Enables multi-hop
 * traversal ("what references this strategy page?") without the agent
 * scanning every file.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoRegistry } from "../services/repo-registry.js";
import {
  ResponseFormatSchema,
  RepoSlugSchema,
  resolveFormat,
  resolveLimit,
  resolveOffset,
  buildPaginationMeta,
} from "../schemas/common.js";
import { UnknownRepoError } from "../services/repo-registry.js";
import { getIndex } from "../services/index-cache.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

const InputSchema = z
  .object({
    repo: RepoSlugSchema,
    path: z
      .string()
      .min(1)
      .max(500)
      .describe("Repo-relative path to find backlinks for, e.g. 'strategy/fundamentals.md'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Max results. Default ${DEFAULT_LIMIT}.`),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Pagination offset."),
    response_format: ResponseFormatSchema,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface BacklinkEntry {
  path: string;
  title: string;
  type?: string;
}

interface BacklinksOutput {
  repo: string;
  target_path: string;
  backlinks: BacklinkEntry[];
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  target_exists: boolean;
  index_stale: boolean;
}

export function registerWikiBacklinks(
  server: McpServer,
  registry: RepoRegistry,
): void {
  server.registerTool(
    "wiki_backlinks",
    {
      title: "Wiki Page Backlinks",
      description: `List all wiki pages that link TO the given path. Links come from both [[wikilink]] and markdown [text](path.md) syntax. Useful for discovering which strategy docs reference a project, which notes cite an index, etc.

Args:
  - repo (string, optional): Repo slug.
  - path (string): Target page's repo-relative path.
  - limit (1-100, default 20), offset (default 0).
  - response_format ('markdown' | 'json').

Returns (JSON):
  {
    "repo": "my-wiki",
    "target_path": "strategy/fundamentals.md",
    "backlinks": [
      {"path": "projects/platform-refresh.md", "title": "Platform Refresh 2026", "type": "engineering-project"}
    ],
    "total": 2, "count": 2, "offset": 0, "has_more": false,
    "target_exists": true,
    "index_stale": false
  }

Notes:
  - target_exists=false means the path doesn't match any page in the index. The backlinks list is still valid (may reference a deleted/moved page).
  - If you need inbound + outbound at once, use wiki_read and inspect the 'related' frontmatter, then combine with this tool's output.`,
      inputSchema: InputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) => {
      try {
        const resolved = registry.resolve(params.repo);
        const index = await getIndex(resolved.entry.slug, resolved.indexPath);
        const indexStale = index === null;

        const allPages = index?.pages ?? [];
        const byPath = new Map(allPages.map((p) => [p.path, p]));
        const target = byPath.get(params.path);

        const backlinkPaths = target
          ? target.inbound_links
          : allPages
              .filter((p) => p.outbound_links.includes(params.path))
              .map((p) => p.path);

        const entries: BacklinkEntry[] = backlinkPaths.map((bp) => {
          const src = byPath.get(bp);
          const e: BacklinkEntry = {
            path: bp,
            title: src?.title ?? bp,
          };
          if (src?.type !== undefined) e.type = src.type;
          return e;
        });

        const limit = resolveLimit(params.limit);
        const offset = resolveOffset(params.offset);
        const paged = entries.slice(offset, offset + limit);
        const meta = buildPaginationMeta(entries.length, paged.length, offset);

        const output: BacklinksOutput = {
          repo: resolved.entry.slug,
          target_path: params.path,
          backlinks: paged,
          total: meta.total,
          count: meta.count,
          offset: meta.offset,
          has_more: meta.has_more,
          ...(meta.next_offset !== undefined ? { next_offset: meta.next_offset } : {}),
          target_exists: !!target,
          index_stale: indexStale,
        };

        const format = resolveFormat(params.response_format);
        const text =
          format === "json"
            ? JSON.stringify(output, null, 2)
            : renderMarkdown(output);

        return {
          content: [{ type: "text", text }],
          structuredContent: output as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResponse(err);
      }
    },
  );
}

function renderMarkdown(out: BacklinksOutput): string {
  const lines: string[] = [
    `# Backlinks → \`${out.target_path}\` (${out.repo})`,
    "",
    out.target_exists
      ? `Target exists in wiki. ${out.total} backlinks.`
      : `_Target path not found in wiki index (may have moved or been deleted). ${out.total} backlinks._`,
    "",
  ];
  if (out.index_stale) lines.push("_Note: index is not yet built; results may be empty._", "");
  if (out.backlinks.length === 0) {
    lines.push("_No backlinks._");
    return lines.join("\n");
  }
  lines.push("| Source | Title | Type |", "| --- | --- | --- |");
  for (const b of out.backlinks) {
    lines.push(`| \`${b.path}\` | ${cell(b.title)} | ${cell(b.type ?? "—")} |`);
  }
  return lines.join("\n");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function errorResponse(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const msg = err instanceof UnknownRepoError || err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${msg}` }],
  };
}
