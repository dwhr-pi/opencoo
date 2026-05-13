/**
 * Heartbeat page drill-down (PR-Y10).
 *
 * The 1.1.0 heartbeat prompt + body fetched only worldview.md
 * + the page index, so the LLM had no way to see the underlying
 * task / project pages the worldview referenced. The 1.2.0
 * synthesis-first prompt asks the LLM to surface named
 * projects + tasks with constraint analysis — that requires
 * the body to drill into the pages the worldview mentions and
 * spotlight a small set so the LLM can cite from them.
 *
 * Strategy (deterministic in the runner, not LLM-driven):
 *   1. Scan the worldview body for relative wiki-path tokens
 *      that match the shape `<dir>/<slug>.md` (tasks, projects,
 *      strategy, …). Whole-line matches and inline matches are
 *      both eligible.
 *   2. Intersect with the page index — only paths that actually
 *      exist as wiki pages are eligible. This is the scope
 *      gate: the index comes from MCP, which is itself
 *      domain-scoped by the wiki adapter.
 *   3. Cap at `maxPages` (default 3) to bound context. The cap
 *      is generous enough to give the LLM real signal but not
 *      so wide that the prompt blows past the spotlight budget.
 *      Hard ceiling: 5 pages.
 *
 * The runner calls `selectDrilldownPages(...)` to pick the
 * paths, then `ctx.callTool("wiki.read_page", () =>
 * wikiReadPage(mcp, { domainSlug, path }))` once per pick. Each
 * call passes through the deny-list + tool-call ledger.
 *
 * Why deterministic, not LLM-driven: the heartbeat is a single
 * `router.generateObject` call (no tool-loop). Letting the LLM
 * choose pages would require turning it into a multi-turn agent
 * — out of scope for v0.1. Deterministic selection is a strict
 * subset of "agent decides" because the LLM still cites only
 * pages it has been spotlighted.
 */

/** Cap on how many pages a single heartbeat run can drill into.
 *  3 is the default; the runner can pass a smaller number but
 *  not a larger one. The 5 ceiling matches the heartbeat's max
 *  alerts cap (architecture §9.4) — at most one drilled page
 *  per alert, plus some slack. */
export const HEARTBEAT_DRILLDOWN_HARD_CEILING = 5;
export const HEARTBEAT_DRILLDOWN_DEFAULT = 3;

/**
 * Extract candidate wiki paths from `worldviewBody`. Returns
 * deduplicated, source-order paths that look like wiki paths
 * (\`<dir>/<slug>.md\`). The caller MUST intersect with the
 * page index before reading — this function returns the raw
 * tokens it found, NOT verified-existing paths.
 *
 * Recognised shapes:
 *   - bare path tokens: \`tasks/123-foo.md\`
 *   - markdown links: \`[label](tasks/123-foo.md)\` →
 *     captures the URL portion
 *   - wiki-href tokens: \`[wiki:strategy/foo.md]\` →
 *     captures the path after \`wiki:\`
 *
 * Filters out:
 *   - paths with scheme prefixes (http://, https://, wiki://,
 *     worldview://) — those point off-domain
 *   - paths starting with \`/\` (absolute, never a wiki path)
 *   - paths whose first segment contains \`.\` (e.g.
 *     \`example.com/foo.md\` — a stray domain in prose)
 */
export function extractCandidatePaths(
  worldviewBody: string,
): readonly string[] {
  // Match `<seg>/<seg>(/<seg>)*.md` token. The leading boundary
  // prevents matching the tail of a longer path like
  // `wiki://test/projects/q3.md` or `http://x.io/y.md` (we
  // don't want absolute MCP URIs or stray inline URLs to leak
  // into the candidate list). The lookbehind excludes
  // path-internal chars `[A-Za-z0-9/_:.\-]` so any prefix that
  // makes the token a sub-path of a longer URL/path disqualifies
  // the match.
  const RAW_PATH_RE = /(?<![A-Za-z0-9/_:.-])([a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9/_-]*\.md)\b/gi;
  const WIKI_HREF_RE = /\[wiki:([a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9/_-]*\.md)\]/gi;

  const found: string[] = [];
  const seen = new Set<string>();

  function push(raw: string): void {
    // Reject paths whose first segment contains a dot (looks
    // like a domain or a versioned scheme).
    const firstSeg = raw.split("/", 1)[0] ?? "";
    if (firstSeg.includes(".")) {
      return;
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      found.push(raw);
    }
  }

  for (const m of worldviewBody.matchAll(WIKI_HREF_RE)) {
    if (m[1] !== undefined) push(m[1]);
  }
  for (const m of worldviewBody.matchAll(RAW_PATH_RE)) {
    if (m[1] !== undefined) push(m[1]);
  }
  return found;
}

export interface SelectDrilldownPagesArgs {
  readonly worldviewBody: string;
  /** Page paths from the domain's index. Used as the existence
   *  filter — only candidates present here are returned. */
  readonly pageIndex: readonly string[];
  /** Cap (1..HEARTBEAT_DRILLDOWN_HARD_CEILING). Defaults to
   *  HEARTBEAT_DRILLDOWN_DEFAULT. Out-of-range values are
   *  clamped: <=0 → 0, >ceiling → ceiling. */
  readonly maxPages?: number;
}

/**
 * Pick up to `maxPages` wiki paths to drill into. The function
 * is pure — the runner is responsible for the actual reads via
 * `ctx.callTool('wiki.read_page', ...)`.
 *
 * Selection algorithm:
 *   1. Parse candidates from worldview body (source order,
 *      deduplicated).
 *   2. Filter to candidates that exist in `pageIndex`.
 *   3. Take the first `maxPages`.
 */
export function selectDrilldownPages(
  args: SelectDrilldownPagesArgs,
): readonly string[] {
  const rawCap = args.maxPages ?? HEARTBEAT_DRILLDOWN_DEFAULT;
  const cap =
    rawCap <= 0
      ? 0
      : rawCap > HEARTBEAT_DRILLDOWN_HARD_CEILING
        ? HEARTBEAT_DRILLDOWN_HARD_CEILING
        : rawCap;
  if (cap === 0) return [];

  const indexSet = new Set(args.pageIndex);
  const candidates = extractCandidatePaths(args.worldviewBody);
  const picked: string[] = [];
  for (const c of candidates) {
    if (indexSet.has(c)) {
      picked.push(c);
      if (picked.length >= cap) break;
    }
  }
  return picked;
}
