/**
 * Directory-prefix match for the rule allow-list patterns. Patterns are
 * repo-relative directory prefixes with an optional `/**` suffix
 * (e.g. `packages/shared/wiki-write/**`); matching is substring-based on
 * the filename after normalising Windows separators to `/`. This keeps
 * the rules' `allowedPaths` option ergonomic without pulling in a glob
 * engine — every pattern in use and every fixture is of this shape.
 */

export function pathMatchesAny(
  filename: string,
  patterns: readonly string[],
): boolean {
  const normalised = filename.replaceAll("\\", "/");
  return patterns.some((pattern) => {
    const prefix = pattern.replace(/\/\*\*$/, "");
    return normalised.includes(`/${prefix}/`) || normalised.startsWith(`${prefix}/`);
  });
}
