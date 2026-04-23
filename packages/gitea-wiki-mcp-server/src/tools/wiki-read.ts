/**
 * wiki_read — fetches a single markdown page by path, returning frontmatter
 * and body separately so the agent doesn't need to re-parse.
 */
import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoRegistry } from "../services/repo-registry.js";
import {
  ResponseFormatSchema,
  RepoSlugSchema,
  resolveFormat,
} from "../schemas/common.js";
import {
  readParsedPage,
  type PageFrontmatter,
} from "../services/wiki-utils.js";
import { safeResolve, PathSafetyError } from "../services/path-safety.js";
import { UnknownRepoError } from "../services/repo-registry.js";
import { CHARACTER_LIMIT } from "../constants.js";

const InputSchema = z
  .object({
    repo: RepoSlugSchema,
    path: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "Repo-relative path to a markdown file, e.g. 'strategy/fundamentals.md'.",
      ),
    response_format: ResponseFormatSchema,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface ReadOutput {
  repo: string;
  path: string;
  frontmatter: PageFrontmatter;
  body: string;
  size: number;
  modified_at: string;
  truncated?: boolean;
  truncation_message?: string;
}

export function registerWikiRead(server: McpServer, registry: RepoRegistry): void {
  server.registerTool(
    "wiki_read",
    {
      title: "Read Wiki Page",
      description: `Read a single markdown page by its repo-relative path. Returns frontmatter (parsed YAML) and body separately. Use this after wiki_toc or wiki_search has told you which page to read.

Args:
  - repo (string, optional): Repo slug. Omit for the default repo.
  - path (string): Repo-relative path, e.g. 'strategy/fundamentals.md'. Absolute paths and path traversal ('../') are rejected.
  - response_format ('markdown' | 'json', default 'markdown'): Output shape. Markdown format shows frontmatter as YAML block + body; JSON returns structured object.

Returns (JSON):
  {
    "repo": "my-wiki",
    "path": "strategy/fundamentals.md",
    "frontmatter": {"title": "Engineering Principles", "type": "strategy", "tags": ["north-star"], "updated": "2026-03-10"},
    "body": "# Engineering Principles\\n\\n...",
    "size": 3421,
    "modified_at": "2026-03-10T14:32:01Z"
  }

Errors:
  - Path not found → "Error: Page not found: <path>"
  - Unsafe path (absolute or traversal) → "Error: path escapes repo root"

Large pages are truncated at ${CHARACTER_LIMIT} chars with a 'truncated: true' marker.`,
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
        const abs = safeResolve(resolved.repoPath, params.path);
        const page = await readParsedPage(resolved.repoPath, abs);

        const output: ReadOutput = {
          repo: resolved.entry.slug,
          path: page.path,
          frontmatter: page.frontmatter,
          body: page.body,
          size: page.size,
          modified_at: page.modified_at,
        };

        if (output.body.length > CHARACTER_LIMIT) {
          output.body = output.body.slice(0, CHARACTER_LIMIT);
          output.truncated = true;
          output.truncation_message = `Body truncated at ${CHARACTER_LIMIT} chars. Page is ${page.body.length} chars total. Re-read with smaller section or use wiki_search for specific content.`;
        }

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
        return errorResponse(err, params.path);
      }
    },
  );
}

function renderMarkdown(out: ReadOutput): string {
  const fmLines = Object.entries(out.frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const trunc = out.truncated
    ? `\n\n> **Note:** ${out.truncation_message ?? "Content truncated."}`
    : "";
  return [
    `# \`${out.path}\` (${out.repo})`,
    "",
    "---",
    fmLines,
    "---",
    "",
    out.body,
    trunc,
  ].join("\n");
}

function errorResponse(
  err: unknown,
  requestedPath: string,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  let msg: string;
  if (err instanceof UnknownRepoError || err instanceof PathSafetyError) {
    msg = err.message;
  } else if (isErrnoException(err) && err.code === "ENOENT") {
    msg = `Page not found: ${requestedPath}. Use wiki_toc to list available pages.`;
  } else if (err instanceof Error) {
    msg = err.message;
  } else {
    msg = String(err);
  }
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${msg}` }],
  };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string"
  );
}

// Suppress unused import warning for usage in path.join style imports elsewhere.
void path;
