/**
 * wiki_search — ripgrep-backed full-text search over wiki markdown content.
 * The highest-ROI retrieval tool: replaces "agent has to guess the filename"
 * with "agent gets exact line hits in 50ms".
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoRegistry } from "../services/repo-registry.js";
import {
  ResponseFormatSchema,
  RepoSlugSchema,
  PaginationSchema,
  resolveFormat,
  resolveLimit,
  resolveOffset,
  buildPaginationMeta,
} from "../schemas/common.js";
import { searchRepo, RipgrepError, type SearchHit } from "../services/ripgrep.js";
import { UnknownRepoError } from "../services/repo-registry.js";
import { CHARACTER_LIMIT } from "../constants.js";

const InputSchema = z
  .object({
    repo: RepoSlugSchema,
    query: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Literal string to search for (NOT a regex). Case-insensitive unless the query contains uppercase letters (smart-case). Examples: 'three pillars', 'observability', 'platform refresh'.",
      ),
    path_glob: z
      .string()
      .optional()
      .describe(
        "Optional path glob to narrow search. Examples: 'strategy/**', 'projects/*.md', '*data*'. Only markdown files are ever searched.",
      ),
    ...PaginationSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface SearchOutput {
  repo: string;
  query: string;
  path_glob?: string;
  hits: SearchHit[];
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  truncated: boolean;
}

export function registerWikiSearch(
  server: McpServer,
  registry: RepoRegistry,
): void {
  server.registerTool(
    "wiki_search",
    {
      title: "Search Wiki Content",
      description: `Full-text search across wiki markdown pages via ripgrep. Use this when you know WHAT you're looking for but not WHICH page has it. Faster + more precise than reading pages one by one.

Args:
  - repo (string, optional): Repo slug. Omit for the default repo.
  - query (string): Literal text to search for. Not a regex. Smart-case: lowercase query matches case-insensitively, uppercase letters make it case-sensitive.
  - path_glob (string, optional): Narrow search by path, e.g. 'strategy/**/*.md', 'projects/*.md'. Only markdown is searched regardless.
  - limit (number, optional, 1-100, default 20): Max hits to return.
  - offset (number, optional, default 0): Pagination.
  - response_format ('markdown' | 'json'): Output shape.

Returns (JSON):
  {
    "repo": "my-wiki",
    "query": "three pillars",
    "hits": [
      {"path": "strategy/fundamentals.md", "line_no": 12, "snippet": "Our engineering work rests on three pillars:"},
      ...
    ],
    "total": 3,
    "count": 3,
    "offset": 0,
    "has_more": false,
    "truncated": false
  }

Examples:
  - "What does the wiki say about observability?" → wiki_search(query: "observability")
  - "Find references to overdue tasks in project pages" → wiki_search(query: "overdue", path_glob: "projects/**/*.md")
  - "Any mention of Time to Market?" → wiki_search(query: "Time to Market")

When NOT to use:
  - To list all pages (use wiki_toc)
  - To read a specific page (use wiki_read)
  - To filter by frontmatter tags/type (use wiki_frontmatter_index)`,
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
        const limit = resolveLimit(params.limit);
        const offset = resolveOffset(params.offset);

        // Ask rg for hits up to (limit + offset), then slice.
        const result = await searchRepo({
          query: params.query,
          cwd: resolved.repoPath,
          pathGlob: params.path_glob,
          limit: limit + offset,
        });

        const paged = result.hits.slice(offset, offset + limit);
        const meta = buildPaginationMeta(result.total_hit_count, paged.length, offset);

        const output: SearchOutput = {
          repo: resolved.entry.slug,
          query: params.query,
          ...(params.path_glob ? { path_glob: params.path_glob } : {}),
          hits: paged,
          total: meta.total,
          count: meta.count,
          offset: meta.offset,
          has_more: meta.has_more,
          ...(meta.next_offset !== undefined ? { next_offset: meta.next_offset } : {}),
          truncated: result.truncated,
        };

        const format = resolveFormat(params.response_format);
        let text =
          format === "json"
            ? JSON.stringify(output, null, 2)
            : renderMarkdown(output);
        if (text.length > CHARACTER_LIMIT) {
          // Fall back to a shorter JSON in case markdown exploded.
          text = JSON.stringify(
            { ...output, hits: output.hits.slice(0, 10), _note: "truncated for context limit" },
            null,
            2,
          );
        }

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

function renderMarkdown(out: SearchOutput): string {
  const header = [
    `# Search: "${out.query}"${out.path_glob ? ` in \`${out.path_glob}\`` : ""} — ${out.repo}`,
    "",
    `${out.total} total hits${out.truncated ? " (capped)" : ""} — showing ${out.count}${out.has_more ? ` (next offset ${out.next_offset})` : ""}`,
    "",
  ];
  if (out.hits.length === 0) {
    header.push("_No matches._");
    return header.join("\n");
  }
  for (const h of out.hits) {
    header.push(`- \`${h.path}:${h.line_no}\` — ${h.snippet}`);
  }
  return header.join("\n");
}

function errorResponse(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const msg =
    err instanceof UnknownRepoError || err instanceof RipgrepError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${msg}` }],
  };
}
