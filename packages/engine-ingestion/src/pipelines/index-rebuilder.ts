/**
 * Index Rebuilder pipeline (architecture §9 pipeline 5).
 *
 * Every 6h: for each enabled domain, list `*.md` files via the
 * WikiAdapter, build an `index.md` body that catalogues them
 * grouped by top-level directory, and commit via wikiWrite with
 * the `[index-rebuild]` tag.
 *
 * Skip-write optimisation: if the new index body equals the
 * existing `index.md` body (modulo frontmatter), no commit
 * happens and the SHA is unchanged. Identical to the Compiler's
 * Q6 no-op shape.
 *
 * The cron schedule is set by the engine harness via
 * PipelineDefinition.schedule; this module exports both the
 * pure `buildIndexBody` (testable in isolation) and the wired
 * `runIndexRebuilder` orchestrator.
 */

import type { DomainSlug } from "@opencoo/shared/db";
import {
  wikiWrite,
  type WikiAdapter,
  type WikiAuthor,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import type { Logger } from "@opencoo/shared/logger";

const INDEX_PATH = "index.md";

/**
 * Group a flat list of `*.md` paths by their top-level directory
 * and emit a Markdown index body. Output shape:
 *
 *   # Index
 *
 *   ## strategy/
 *   - strategy/q3.md
 *   - strategy/roadmap.md
 *
 *   ## (root)
 *   - readme.md
 *
 * The index lists only files (not directories) because the wiki
 * is path-flat. Sort order is deterministic (caller pre-sorts;
 * the function does not re-sort). Excludes `index.md` itself.
 */
export function buildIndexBody(paths: readonly string[]): string {
  const filtered = paths.filter((p) => p !== INDEX_PATH);
  if (filtered.length === 0) {
    return "# Index\n\n_No pages yet._\n";
  }
  const groups = new Map<string, string[]>();
  for (const path of filtered) {
    const slash = path.indexOf("/");
    const group = slash === -1 ? "(root)" : `${path.slice(0, slash)}/`;
    let bucket = groups.get(group);
    if (bucket === undefined) {
      bucket = [];
      groups.set(group, bucket);
    }
    bucket.push(path);
  }
  // Group order: alphabetical with `(root)` last so subdirs
  // surface first in the index.
  const sortedGroupNames = [...groups.keys()].sort((a, b) => {
    if (a === "(root)") return 1;
    if (b === "(root)") return -1;
    return a.localeCompare(b);
  });
  const lines: string[] = ["# Index", ""];
  for (const group of sortedGroupNames) {
    lines.push(`## ${group}`);
    lines.push("");
    for (const path of groups.get(group) ?? []) {
      lines.push(`- ${path}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

export interface RunIndexRebuilderArgs {
  readonly domainSlug: string;
  readonly wikiDeps: WikiWriteDeps;
  readonly wikiAdapter: WikiAdapter;
  readonly logger: Logger;
  readonly author: WikiAuthor;
}

export interface IndexRebuilderResult {
  /** sha of the wikiWrite commit, or null when the index was a
   *  no-op (Q6 skip-write). */
  readonly commitSha: string | null;
  readonly fileCount: number;
}

export async function runIndexRebuilder(
  args: RunIndexRebuilderArgs,
): Promise<IndexRebuilderResult> {
  const paths = await args.wikiAdapter.listMarkdown(
    args.domainSlug as DomainSlug,
  );
  const newBody = buildIndexBody(paths);
  const existing = await args.wikiAdapter.readPage(
    args.domainSlug as DomainSlug,
    INDEX_PATH,
  );
  const existingBody = existing === null ? "" : stripFrontmatter(existing.content);
  if (newBody === existingBody) {
    args.logger.info("index_rebuilder.no-op", {
      domain_slug: args.domainSlug,
      file_count: paths.length,
    });
    return { commitSha: null, fileCount: paths.length };
  }
  const result = await wikiWrite(args.wikiDeps, {
    domainSlug: args.domainSlug,
    tag: "[index-rebuild]",
    description: `rebuild index (${paths.length} page(s))`,
    author: args.author,
    caller: { kind: "engine" },
    operations: [{ mode: "replace", path: INDEX_PATH, content: newBody }],
  });
  args.logger.info("index_rebuilder.committed", {
    domain_slug: args.domainSlug,
    file_count: paths.length,
    sha: result.sha,
  });
  return { commitSha: result.sha, fileCount: paths.length };
}
