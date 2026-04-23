/**
 * Repo-relative path validation. Every tool that accepts a `path` input runs it
 * through `safeResolve()` before touching the filesystem — otherwise a
 * malicious prompt could make the LLM ask for `../../../etc/passwd`.
 */
import path from "node:path";

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

/**
 * Resolve a user-supplied repo-relative path to an absolute filesystem path,
 * confirming it stays inside `repoRoot`. Throws `PathSafetyError` otherwise.
 *
 * Accepts: `strategy/fundamentals.md`, `projects/foo.md`, `./index.md`
 * Rejects: `/etc/passwd`, `../../escape`, `strategy/../../../etc`
 */
export function safeResolve(repoRoot: string, userPath: string): string {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new PathSafetyError("path must be a non-empty string");
  }
  if (userPath.length > 500) {
    throw new PathSafetyError("path exceeds 500 character limit");
  }
  if (path.isAbsolute(userPath)) {
    throw new PathSafetyError("absolute paths are not allowed");
  }
  // Reject null bytes (common in path-traversal payloads)
  if (userPath.includes("\0")) {
    throw new PathSafetyError("path contains null byte");
  }

  const absoluteRoot = path.resolve(repoRoot);
  const joined = path.resolve(absoluteRoot, userPath);
  const rel = path.relative(absoluteRoot, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathSafetyError(`path escapes repo root: ${userPath}`);
  }
  return joined;
}
