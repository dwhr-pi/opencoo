/**
 * wiki_recent_changes — recent git commits for auditability and
 * "what changed lately" queries. Uses simple-git against the cloned repo.
 */
import { z } from "zod";
import path from "node:path";
import { simpleGit } from "simple-git";
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

const InputSchema = z
  .object({
    repo: RepoSlugSchema,
    since: z
      .string()
      .optional()
      .describe(
        "ISO date or datetime (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ). Include commits on or after this. Omit for no lower bound.",
      ),
    path_prefix: z
      .string()
      .optional()
      .describe("Restrict to commits touching files under this path prefix, e.g. 'projects/'."),
    ...PaginationSchema,
    response_format: ResponseFormatSchema,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface CommitEntry {
  sha: string;
  short_sha: string;
  date: string;
  author: string;
  email: string;
  message: string;
  paths: string[];
}

interface RecentChangesOutput {
  repo: string;
  since?: string;
  path_prefix?: string;
  commits: CommitEntry[];
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

export function registerWikiRecentChanges(
  server: McpServer,
  registry: RepoRegistry,
): void {
  server.registerTool(
    "wiki_recent_changes",
    {
      title: "Wiki Recent Commits",
      description: `List recent commits on the wiki repo, optionally filtered by date or path prefix. Use this to answer "what changed recently?" or to audit edits to a specific area.

Args:
  - repo (string, optional): Repo slug.
  - since (string, optional): ISO date (YYYY-MM-DD) or datetime. Only commits on/after this.
  - path_prefix (string, optional): Only commits that touch files under this prefix, e.g. 'strategy/', 'projects/foo.md'.
  - limit (1-100, default 20), offset (default 0).
  - response_format ('markdown' | 'json').

Returns (JSON):
  {
    "repo": "my-wiki",
    "commits": [
      {
        "sha": "a7f3b9c...", "short_sha": "a7f3b9c",
        "date": "2026-03-15T14:30:00Z",
        "author": "Jane Doe", "email": "jane@example.com",
        "message": "chore(wiki): update projects/infra-backlog",
        "paths": ["projects/infra-backlog.md"]
      }
    ],
    "total": 47, "count": 20, "offset": 0, "has_more": true, "next_offset": 20
  }

Examples:
  - "What changed in the last 7 days?" → since: "2026-03-09"
  - "Audit strategy edits since start of month" → since: "2026-03-01", path_prefix: "strategy/"`,
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
        const git = simpleGit(resolved.repoPath);

        const limit = resolveLimit(params.limit);
        const offset = resolveOffset(params.offset);

        // --name-only + custom format gets us commit meta + changed paths
        // in one shot. Separator `\x1f` (unit separator) + `\x1e` (record separator).
        const FORMAT = "%H%x1f%an%x1f%ae%x1f%aI%x1f%s";
        const args = [
          "log",
          `--pretty=format:${FORMAT}`,
          "--name-only",
        ];
        if (params.since) {
          args.push(`--since=${params.since}`);
        }
        // Cap maximum commits to examine — we need enough for offset+limit plus
        // a buffer for path-prefix filtering. 500 is a sane ceiling.
        const maxCommits = Math.min(500, Math.max(50, (offset + limit) * 5));
        args.push(`-n`, String(maxCommits));
        if (params.path_prefix) {
          args.push("--", params.path_prefix);
        }

        const raw = await git.raw(args);
        const commits = parseCommits(raw);

        // path_prefix post-filter (git handles it via pathspec above, but we
        // strip commits that ended up with zero matching paths for safety).
        const filtered = params.path_prefix
          ? commits.filter((c) =>
              c.paths.some((p) => p.startsWith(params.path_prefix!)),
            )
          : commits;

        const paged = filtered.slice(offset, offset + limit);
        const meta = buildPaginationMeta(filtered.length, paged.length, offset);

        const output: RecentChangesOutput = {
          repo: resolved.entry.slug,
          ...(params.since !== undefined ? { since: params.since } : {}),
          ...(params.path_prefix !== undefined ? { path_prefix: params.path_prefix } : {}),
          commits: paged,
          total: meta.total,
          count: meta.count,
          offset: meta.offset,
          has_more: meta.has_more,
          ...(meta.next_offset !== undefined ? { next_offset: meta.next_offset } : {}),
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

  void path; // suppress unused-import warning (kept for future consistency)
}

function parseCommits(raw: string): CommitEntry[] {
  // Each commit block: header line with \x1f separators, followed by name-only
  // paths (one per line), then a blank line before next commit. git log's
  // --name-only output sometimes uses blank-line separators, sometimes runs
  // paths directly — we split on blank lines.
  const commits: CommitEntry[] = [];
  const blocks = raw.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0]!;
    const parts = header.split("\x1f");
    if (parts.length < 5) continue;
    const [sha, author, email, date, message] = parts as [string, string, string, string, string];
    const paths = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    commits.push({
      sha,
      short_sha: sha.slice(0, 7),
      author,
      email,
      date,
      message,
      paths,
    });
  }
  return commits;
}

function renderMarkdown(out: RecentChangesOutput): string {
  const filters: string[] = [];
  if (out.since) filters.push(`since=${out.since}`);
  if (out.path_prefix) filters.push(`path_prefix=${out.path_prefix}`);
  const lines: string[] = [
    `# Recent changes — ${out.repo}`,
    "",
    filters.length ? `Filters: ${filters.join(", ")}` : "No filters.",
    `Matched: ${out.total}, showing ${out.count}${out.has_more ? ` (next offset ${out.next_offset})` : ""}`,
    "",
  ];
  if (out.commits.length === 0) {
    lines.push("_No commits._");
    return lines.join("\n");
  }
  for (const c of out.commits) {
    lines.push(
      `### \`${c.short_sha}\` — ${c.date}`,
      `**${c.author}** <${c.email}>`,
      "",
      c.message,
      "",
      ...c.paths.map((p) => `- \`${p}\``),
      "",
    );
  }
  return lines.join("\n");
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
