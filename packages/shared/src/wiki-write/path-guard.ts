import { WikiPathError } from "./errors.js";

// Canonical wiki path shape:
// - Starts with an ASCII lowercase letter or digit.
// - Body is ASCII lowercase letters, digits, `_`, `-`, `/`.
// - Ends with one of the four extensions Karpathy-wiki pages use.
// - No `..` path component, no leading `/`, no `\` separator, no
//   control characters, no `wiki-` prefix anywhere (the repo-name
//   namespace prefix is reserved for repo slugs, not page paths).
const PATH_REGEX = /^[a-z0-9][a-z0-9/_-]*\.(md|yml|yaml|json)$/;

export function validatePath(path: string): void {
  if (path === "") {
    throw new WikiPathError("wiki path is empty");
  }
  if (path.startsWith("/")) {
    throw new WikiPathError(`wiki path must not start with '/': ${path}`);
  }
  if (path.includes("\\")) {
    throw new WikiPathError(
      `wiki path must not contain '\\\\' separators: ${path}`,
    );
  }
  // Any ASCII control character (incl. NUL, tab, LF) is forbidden —
  // these never belong in a repo path and catch a class of smuggling
  // attacks where a path is reconstructed across stores.
  if (/[\x00-\x1F\x7F]/.test(path)) {
    throw new WikiPathError(
      `wiki path must not contain control characters: ${JSON.stringify(path)}`,
    );
  }
  for (const segment of path.split("/")) {
    if (segment === "..") {
      throw new WikiPathError(
        `wiki path must not contain '..' component: ${path}`,
      );
    }
  }
  if (path.startsWith("wiki-")) {
    throw new WikiPathError(
      `wiki path must not start with 'wiki-' (reserved for repo namespace): ${path}`,
    );
  }
  if (path.includes("/wiki-")) {
    throw new WikiPathError(
      `wiki path must not contain '/wiki-' segment (reserved for repo namespace): ${path}`,
    );
  }
  if (!PATH_REGEX.test(path)) {
    throw new WikiPathError(
      `wiki path does not match ${PATH_REGEX}: ${path}`,
    );
  }
}
