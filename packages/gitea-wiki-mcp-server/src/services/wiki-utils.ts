/**
 * Shared helpers for walking a cloned wiki repo and parsing markdown + YAML
 * frontmatter. Used by multiple tools (wiki_toc, wiki_read, index-builder).
 */
import path from "node:path";
import fs from "node:fs/promises";
import matter from "gray-matter";

export interface PageFrontmatter {
  title?: string;
  type?: string;
  tags?: string[];
  related?: string[];
  updated?: string;
  source_types?: string[];
  [key: string]: unknown;
}

export interface ParsedPage {
  /** Repo-relative forward-slash path (e.g. "strategy/fundamentals.md"). */
  path: string;
  frontmatter: PageFrontmatter;
  body: string;
  /** File size in bytes. */
  size: number;
  /** mtime as ISO-8601 UTC. */
  modified_at: string;
}

/** Normalize a filesystem path to a repo-relative forward-slash path. */
export function toRepoRelative(repoRoot: string, absPath: string): string {
  const rel = path.relative(repoRoot, absPath);
  return rel.split(path.sep).join("/");
}

/** List every .md file under `repoRoot`, skipping `.git`, `.github`, `node_modules`,
 * and any dotfiles. Returns repo-relative forward-slash paths, sorted. */
export async function listMarkdownPaths(repoRoot: string): Promise<string[]> {
  const results: string[] = [];
  await walk(repoRoot, repoRoot, results);
  results.sort();
  return results;
}

async function walk(repoRoot: string, dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(repoRoot, abs, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(toRepoRelative(repoRoot, abs));
    }
  }
}

/** Read and parse a single page. Absolute `absPath` must already be validated
 * via safeResolve().
 *
 * Malformed YAML frontmatter (common: unquoted colons in titles like
 * `title: Foo: Bar`) is tolerated: the page is treated as having no
 * frontmatter, and we best-effort extract a title from the raw text so tools
 * still show something meaningful in the TOC. Without this, gray-matter
 * throws and the page becomes invisible to all tools except wiki_search. */
export async function readParsedPage(
  repoRoot: string,
  absPath: string,
): Promise<ParsedPage> {
  const [raw, stat] = await Promise.all([
    fs.readFile(absPath, "utf8"),
    fs.stat(absPath),
  ]);
  let frontmatter: PageFrontmatter;
  let body: string;
  const hasFence = raw.startsWith("---\n") || raw.startsWith("---\r\n");
  try {
    const parsed = matter(raw);
    frontmatter = parsed.data as PageFrontmatter;
    body = parsed.content;
    // gray-matter CACHES malformed input: first call throws, subsequent calls
    // return { data: {}, content: raw } silently. Detect that case and run the
    // fallback so title/type are still extracted.
    if (hasFence && Object.keys(frontmatter).length === 0 && body === raw) {
      frontmatter = extractFallbackFrontmatter(raw);
    }
  } catch {
    frontmatter = extractFallbackFrontmatter(raw);
    body = raw;
  }
  return {
    path: toRepoRelative(repoRoot, absPath),
    frontmatter,
    body,
    size: stat.size,
    modified_at: stat.mtime.toISOString(),
  };
}

/** Best-effort title + type extraction from raw text when YAML parsing fails.
 * Scans the content between the first `---` markers (or the first 15 lines if
 * no fence) for `key: value` lines. Good enough for malformed frontmatter
 * where only ONE line confused the parser (e.g. an unquoted colon in title). */
function extractFallbackFrontmatter(raw: string): PageFrontmatter {
  const lines = raw.split(/\r?\n/);
  let scanLines: string[];
  if (lines[0]?.trim() === "---") {
    const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    scanLines = endIdx > 0 ? lines.slice(1, endIdx) : lines.slice(1, 15);
  } else {
    scanLines = lines.slice(0, 15);
  }
  const out: PageFrontmatter = {};
  for (const line of scanLines) {
    const m = /^\s*(title|type|updated)\s*:\s*(.+)\s*$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    // Strip wrapping quotes.
    const value = m[2]!.replace(/^['"](.+)['"]$/, "$1").trim();
    if (!value) continue;
    if (key === "title" && !out.title) out.title = value;
    else if (key === "type" && !out.type) out.type = value;
    else if (key === "updated" && !out.updated) out.updated = value;
  }
  return out;
}

/** Extract a short (≤200 char) preview from the body for TOC listings. */
export function bodyPreview(body: string): string {
  const stripped = body
    .replace(/^#+\s.*$/gm, "") // headers
    .replace(/[*_`~]/g, "") // basic markdown punctuation
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 200 ? stripped.slice(0, 197) + "..." : stripped;
}
