/**
 * Walks a cloned wiki repo, parses frontmatter + link graph, writes
 * `data/index/{slug}.json`. Called on boot + after every `git pull`.
 *
 * Link extraction handles both `[[wikilink]]` and standard markdown
 * `[text](path.md)` syntax for repo-local .md targets. External URLs and
 * non-markdown targets are skipped.
 */
import path from "node:path";
import fs from "node:fs/promises";
import {
  listMarkdownPaths,
  readParsedPage,
  type PageFrontmatter,
} from "../services/wiki-utils.js";

export interface IndexedPage {
  path: string;
  title: string;
  type?: string;
  tags: string[];
  related: string[];
  updated?: string;
  size: number;
  modified_at: string;
  frontmatter: PageFrontmatter;
  outbound_links: string[];
  inbound_links: string[];
}

export interface WikiIndex {
  repo_slug: string;
  built_at: string;
  page_count: number;
  pages: IndexedPage[];
}

/** Build a wiki index for a cloned repo and persist to `indexPath`. */
export async function buildIndex(
  repoSlug: string,
  repoPath: string,
  indexPath: string,
): Promise<WikiIndex> {
  const paths = await listMarkdownPaths(repoPath);
  const pages: IndexedPage[] = [];

  // First pass: parse frontmatter + outbound links.
  for (const relPath of paths) {
    const abs = path.join(repoPath, relPath);
    try {
      const page = await readParsedPage(repoPath, abs);
      const fm = page.frontmatter;
      const title = typeof fm.title === "string" ? fm.title : fallbackTitle(relPath);
      const tags = extractStringArray(fm.tags);
      const related = extractStringArray(fm.related);
      const outbound = extractOutboundLinks(relPath, page.body, paths);
      const indexed: IndexedPage = {
        path: relPath,
        title,
        tags,
        related,
        size: page.size,
        modified_at: page.modified_at,
        frontmatter: fm,
        outbound_links: outbound,
        inbound_links: [],
      };
      if (typeof fm.type === "string") indexed.type = fm.type;
      if (typeof fm.updated === "string") indexed.updated = fm.updated;
      pages.push(indexed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[index-builder] skipping ${relPath}: ${msg}`);
    }
  }

  // Second pass: compute inbound_links from outbound graph.
  const byPath = new Map(pages.map((p) => [p.path, p]));
  for (const p of pages) {
    for (const target of p.outbound_links) {
      const dest = byPath.get(target);
      if (dest && !dest.inbound_links.includes(p.path)) {
        dest.inbound_links.push(p.path);
      }
    }
  }

  const index: WikiIndex = {
    repo_slug: repoSlug,
    built_at: new Date().toISOString(),
    page_count: pages.length,
    pages,
  };

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index), "utf8");

  return index;
}

/** Load an existing index from disk, returning null if missing. */
export async function loadIndex(indexPath: string): Promise<WikiIndex | null> {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    return JSON.parse(raw) as WikiIndex;
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

function fallbackTitle(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

function extractStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Pull outbound links (page paths this page references) from markdown body.
 * - [[wikilink]] style, optionally with subdir: [[strategy/fundamentals]]
 * - [text](path.md) style, both relative (../other.md) and rooted (/strategy/foo.md)
 *
 * Only returns paths that actually exist in `allPaths` — avoids stale refs
 * polluting the graph.
 */
function extractOutboundLinks(
  fromPath: string,
  body: string,
  allPaths: string[],
): string[] {
  const known = new Set(allPaths);
  const out = new Set<string>();
  const fromDir = path.dirname(fromPath);

  // [[wikilink]] — capture slug, optionally with subdir, ignore any trailing |alias
  const WIKI_LINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  for (const m of body.matchAll(WIKI_LINK)) {
    const slug = m[1]?.trim();
    if (!slug) continue;
    const candidates = wikiLinkCandidates(slug);
    for (const c of candidates) {
      if (known.has(c)) {
        out.add(c);
        break;
      }
    }
  }

  // [text](target) — only local .md targets.
  const MD_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
  for (const m of body.matchAll(MD_LINK)) {
    const target = m[2]?.trim();
    if (!target) continue;
    if (/^(https?|mailto|ftp):/i.test(target)) continue;
    if (target.startsWith("#")) continue; // in-page anchor
    const cleaned = target.split("#")[0]!.split("?")[0]!;
    if (!cleaned.toLowerCase().endsWith(".md")) continue;

    let resolved: string;
    if (cleaned.startsWith("/")) {
      resolved = cleaned.slice(1);
    } else {
      resolved = path.posix.normalize(`${fromDir}/${cleaned}`);
    }
    if (known.has(resolved)) out.add(resolved);
  }

  return [...out].sort();
}

function wikiLinkCandidates(slug: string): string[] {
  // `[[strategy/fundamentals]]` → strategy/fundamentals.md
  // `[[fundamentals]]` → fundamentals.md
  const cleaned = slug.replace(/\.md$/i, "");
  return [
    `${cleaned}.md`,
    `${cleaned}/index.md`,
  ];
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}
