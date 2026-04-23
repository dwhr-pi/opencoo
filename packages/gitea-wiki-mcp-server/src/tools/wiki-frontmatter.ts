/**
 * wiki_frontmatter_index — filter wiki pages by frontmatter metadata (tags,
 * type, updated_since). Lets the AI agent slice the wiki ("all strategy docs
 * tagged coo-system updated after 2026-03-01") in one call, without reading
 * each page.
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
import { UnknownRepoError } from "../services/repo-registry.js";
import { getIndex } from "../services/index-cache.js";
import type { IndexedPage } from "../sync/index-builder.js";

const InputSchema = z
  .object({
    repo: RepoSlugSchema,
    tag: z
      .string()
      .optional()
      .describe("Filter to pages whose frontmatter `tags` array contains this string."),
    type: z
      .string()
      .optional()
      .describe(
        "Filter to pages whose frontmatter `type` matches exactly. Examples: 'strategy', 'asana-project', 'meeting'.",
      ),
    updated_since: z
      .string()
      .optional()
      .describe(
        "ISO date (YYYY-MM-DD). Include only pages whose frontmatter `updated` is on or after this date. Pages without `updated` are excluded.",
      ),
    path_prefix: z
      .string()
      .optional()
      .describe("Filter to pages whose path starts with this prefix, e.g. 'projects/'."),
    ...PaginationSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface FrontmatterEntry {
  path: string;
  title: string;
  type?: string;
  tags: string[];
  updated?: string;
}

interface FrontmatterOutput {
  repo: string;
  filters: {
    tag?: string;
    type?: string;
    updated_since?: string;
    path_prefix?: string;
  };
  pages: FrontmatterEntry[];
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  index_stale: boolean;
}

export function registerWikiFrontmatterIndex(
  server: McpServer,
  registry: RepoRegistry,
): void {
  server.registerTool(
    "wiki_frontmatter_index",
    {
      title: "Filter Wiki Pages by Frontmatter",
      description: `Filter wiki pages by their YAML frontmatter fields. Much faster than reading pages one by one when you want "all pages of type X" or "everything tagged Y updated after Z".

Args:
  - repo (string, optional): Repo slug.
  - tag (string, optional): Filter to pages containing this in their tags array.
  - type (string, optional): Exact match on the type field ('strategy', 'engineering-project', ...).
  - updated_since (string, optional): ISO date (YYYY-MM-DD). Keep pages with updated >= this.
  - path_prefix (string, optional): Keep pages whose path starts with this.
  - limit (1-100, default 20), offset (default 0).
  - response_format ('markdown' | 'json').

All filters are ANDed. Omit all for a full catalog.

Returns (JSON):
  {
    "repo": "my-wiki",
    "filters": {"type": "strategy"},
    "pages": [
      {"path": "strategy/fundamentals.md", "title": "Engineering Principles", "type": "strategy", "tags": ["north-star"], "updated": "2026-03-10"}
    ],
    "total": 3, "count": 3, "offset": 0, "has_more": false,
    "index_stale": false
  }

Examples:
  - "All strategy docs" → filter: {type: "strategy"}
  - "Project pages touched this month" → filter: {path_prefix: "projects/", updated_since: "2026-03-01"}
  - "Anything tagged 'platform'" → filter: {tag: "platform"}

The 'index_stale' flag is true if the server couldn't find a built index — frontmatter tools degrade to reading the repo directly (slow). Call again in ~5 min for fresh results.`,
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
        const pages = index ? index.pages : [];

        const filtered = pages.filter((p) =>
          matchesFilters(p, params.tag, params.type, params.updated_since, params.path_prefix),
        );

        const limit = resolveLimit(params.limit);
        const offset = resolveOffset(params.offset);
        const paged = filtered.slice(offset, offset + limit);
        const meta = buildPaginationMeta(filtered.length, paged.length, offset);

        const output: FrontmatterOutput = {
          repo: resolved.entry.slug,
          filters: {
            ...(params.tag !== undefined ? { tag: params.tag } : {}),
            ...(params.type !== undefined ? { type: params.type } : {}),
            ...(params.updated_since !== undefined ? { updated_since: params.updated_since } : {}),
            ...(params.path_prefix !== undefined ? { path_prefix: params.path_prefix } : {}),
          },
          pages: paged.map(toEntry),
          total: meta.total,
          count: meta.count,
          offset: meta.offset,
          has_more: meta.has_more,
          ...(meta.next_offset !== undefined ? { next_offset: meta.next_offset } : {}),
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

function matchesFilters(
  p: IndexedPage,
  tag?: string,
  type?: string,
  updatedSince?: string,
  pathPrefix?: string,
): boolean {
  if (tag && !p.tags.includes(tag)) return false;
  if (type && p.type !== type) return false;
  if (updatedSince) {
    if (!p.updated) return false;
    if (p.updated < updatedSince) return false;
  }
  if (pathPrefix && !p.path.startsWith(pathPrefix)) return false;
  return true;
}

function toEntry(p: IndexedPage): FrontmatterEntry {
  const e: FrontmatterEntry = {
    path: p.path,
    title: p.title,
    tags: p.tags,
  };
  if (p.type !== undefined) e.type = p.type;
  if (p.updated !== undefined) e.updated = p.updated;
  return e;
}

function renderMarkdown(out: FrontmatterOutput): string {
  const filterBits = Object.entries(out.filters)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "(none)";
  const lines: string[] = [
    `# Wiki pages — ${out.repo}`,
    "",
    `Filters: ${filterBits}`,
    `Matched: ${out.total}, showing ${out.count}${out.has_more ? ` (next offset ${out.next_offset})` : ""}${out.index_stale ? " — **index stale**" : ""}`,
    "",
  ];
  if (out.pages.length === 0) {
    lines.push("_No matching pages._");
    return lines.join("\n");
  }
  lines.push("| Path | Title | Type | Tags | Updated |", "| --- | --- | --- | --- | --- |");
  for (const p of out.pages) {
    lines.push(
      `| \`${p.path}\` | ${cell(p.title)} | ${cell(p.type ?? "—")} | ${cell(p.tags.join(", ") || "—")} | ${cell(p.updated ?? "—")} |`,
    );
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
