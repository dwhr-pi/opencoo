/**
 * wiki_toc — returns a table-of-contents for the wiki: every markdown page
 * with its path, title, type, tags, and last-updated date. Rich enough to
 * let an AI agent pick the right page to read in one shot, without extra
 * file reads.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoRegistry } from "../services/repo-registry.js";
import {
  ResponseFormatSchema,
  RepoSlugSchema,
  resolveFormat,
} from "../schemas/common.js";
import {
  listMarkdownPaths,
  readParsedPage,
  type ParsedPage,
} from "../services/wiki-utils.js";
import { UnknownRepoError } from "../services/repo-registry.js";
import path from "node:path";

const InputSchema = z
  .object({
    repo: RepoSlugSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface TocEntry {
  path: string;
  title: string;
  type?: string;
  tags?: string[];
  updated?: string;
  size: number;
}

interface TocOutput {
  repo: string;
  total: number;
  pages: TocEntry[];
}

export function registerWikiToc(server: McpServer, registry: RepoRegistry): void {
  server.registerTool(
    "wiki_toc",
    {
      title: "Wiki Table of Contents",
      description: `List every markdown page in the wiki with its path, title, type, tags, and last-updated date. Use this FIRST when you don't know which page has the answer — it lets you pick the right page in one call instead of walking the tree.

Args:
  - repo (string, optional): Repo slug. Omit for the default repo.
  - response_format ('markdown' | 'json', default 'markdown'): Output shape.

Returns (JSON):
  {
    "repo": "my-wiki",
    "total": 32,
    "pages": [
      {"path": "strategy/fundamentals.md", "title": "Engineering Principles", "type": "strategy", "tags": ["north-star"], "updated": "2026-03-10", "size": 3421},
      ...
    ]
  }

Examples:
  - "What pages do we have about the platform refresh?" → call wiki_toc, filter by type=strategy or tags containing 'platform'
  - "List all project pages" → call wiki_toc, filter by path prefix 'projects/' or a specific type

When NOT to use:
  - When you already know the exact path (use wiki_read instead)
  - When searching for specific content (use wiki_search for full-text)`,
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
        const paths = await listMarkdownPaths(resolved.repoPath);
        const entries = await Promise.all(
          paths.map(async (relPath): Promise<TocEntry> => {
            const abs = path.join(resolved.repoPath, relPath);
            let page: ParsedPage;
            try {
              page = await readParsedPage(resolved.repoPath, abs);
            } catch {
              // Unreadable page — include a stub so the LLM knows it exists.
              return { path: relPath, title: relPath, size: 0 };
            }
            const fm = page.frontmatter;
            const entry: TocEntry = {
              path: relPath,
              title: typeof fm.title === "string" ? fm.title : fallbackTitle(relPath),
              size: page.size,
            };
            if (typeof fm.type === "string") entry.type = fm.type;
            if (Array.isArray(fm.tags) && fm.tags.every((t) => typeof t === "string")) {
              entry.tags = fm.tags as string[];
            }
            if (typeof fm.updated === "string") entry.updated = fm.updated;
            return entry;
          }),
        );

        const output: TocOutput = {
          repo: resolved.entry.slug,
          total: entries.length,
          pages: entries,
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

function fallbackTitle(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

function renderMarkdown(out: TocOutput): string {
  const lines: string[] = [
    `# Wiki TOC — ${out.repo}`,
    "",
    `Total: ${out.total} pages`,
    "",
    "| Path | Title | Type | Tags | Updated |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const p of out.pages) {
    const tags = p.tags?.length ? p.tags.join(", ") : "—";
    const type = p.type ?? "—";
    const updated = p.updated ?? "—";
    lines.push(
      `| \`${p.path}\` | ${escapeCell(p.title)} | ${escapeCell(type)} | ${escapeCell(tags)} | ${escapeCell(updated)} |`,
    );
  }
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function errorResponse(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const msg =
    err instanceof UnknownRepoError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${msg}` }],
  };
}
