/**
 * Wrapper around the ripgrep binary shipped by `@vscode/ripgrep`. Runs as a
 * subprocess with safe arg handling, per-call timeout, and result caps.
 *
 * SECURITY NOTES:
 *   - `query` is passed as an argv element, NOT shell-interpolated.
 *   - `cwd` is the already-validated repo root from RepoRegistry.
 *   - `path_glob` (if provided) is vetted against an allow-list before use.
 */
import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import { MAX_SEARCH_HITS, RIPGREP_TIMEOUT_MS } from "../constants.js";

export interface SearchHit {
  path: string;
  line_no: number;
  snippet: string;
}

export interface SearchOptions {
  query: string;
  cwd: string;
  pathGlob?: string;
  limit: number;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  total_hit_count: number;
}

/**
 * Globs accepted for `path_glob`. Tight allow-list: alphanumerics, hyphen,
 * underscore, slash, dot (single), and standard glob metachars `*?[]{}`.
 * Explicitly reject `..` anywhere in the string — rg already enforces cwd,
 * but defense-in-depth.
 */
const GLOB_ALLOW = /^[\w\-/*?.[\]{}]+$/;

function isSafeGlob(glob: string): boolean {
  if (!GLOB_ALLOW.test(glob)) return false;
  // No parent-directory references.
  if (glob.split("/").includes("..")) return false;
  // No absolute paths (leading slash).
  if (glob.startsWith("/")) return false;
  return true;
}

export class RipgrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RipgrepError";
  }
}

export async function searchRepo(opts: SearchOptions): Promise<SearchResult> {
  if (typeof opts.query !== "string" || opts.query.length === 0) {
    throw new RipgrepError("query must be a non-empty string");
  }
  if (opts.query.length > 500) {
    throw new RipgrepError("query exceeds 500 characters");
  }

  const args: string[] = [
    "--json",
    "--smart-case",
    "--max-count",
    String(MAX_SEARCH_HITS * 2), // slight headroom before our own cap
  ];

  if (opts.pathGlob) {
    if (!isSafeGlob(opts.pathGlob)) {
      throw new RipgrepError(
        `path_glob is not in the allow-list (rejected for safety): ${opts.pathGlob}`,
      );
    }
    // User's glob replaces the default markdown-only filter. If they want
    // non-markdown search, their glob expresses that; if they want markdown
    // within a subdir, they should include *.md in their pattern.
    args.push("--glob", opts.pathGlob);
  } else {
    // Default: markdown only.
    args.push("--glob", "*.md");
  }

  // The literal query, terminator to prevent being parsed as a flag.
  // `.` at the end is the explicit search path — rg requires it in some
  // spawn contexts (otherwise it expects stdin input and returns nothing).
  args.push("--", opts.query, ".");

  return new Promise<SearchResult>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const hits: SearchHit[] = [];
    let stderr = "";
    let buffer = "";
    let totalHits = 0;

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RipgrepError(`ripgrep timed out after ${RIPGREP_TIMEOUT_MS}ms`));
    }, RIPGREP_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as RgJsonMessage;
          if (msg.type === "match") {
            totalHits++;
            if (hits.length < opts.limit) {
              const text = msg.data.lines.text ?? "";
              hits.push({
                path: stripLeadingDot(msg.data.path.text),
                line_no: msg.data.line_number,
                snippet: trimSnippet(text),
              });
            }
          }
        } catch {
          // ignore non-JSON lines (rg summary is JSON; stray output shouldn't occur)
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new RipgrepError(`ripgrep spawn error: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      // rg exits 0 on match, 1 on no match, 2 on error.
      if (code === 0 || code === 1) {
        resolve({
          hits,
          truncated: totalHits > hits.length,
          total_hit_count: totalHits,
        });
      } else {
        reject(
          new RipgrepError(
            `ripgrep exited ${code ?? "null"}${stderr ? ": " + stderr.trim() : ""}`,
          ),
        );
      }
    });
  });
}

function trimSnippet(text: string): string {
  const cleaned = text.replace(/\r?\n$/, "").replace(/\t/g, "  ");
  return cleaned.length > 300 ? cleaned.slice(0, 297) + "..." : cleaned;
}

/** Strip leading "./" that rg prepends when the search root is "." */
function stripLeadingDot(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

// Minimal subset of ripgrep --json output we consume.
interface RgJsonMessage {
  type: "begin" | "end" | "match" | "summary" | "context";
  data: {
    path: { text: string };
    lines: { text?: string };
    line_number: number;
    [key: string]: unknown;
  };
}
