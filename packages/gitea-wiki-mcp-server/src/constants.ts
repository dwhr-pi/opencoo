/**
 * Server-wide constants. Values intentionally conservative — tweak in code,
 * not via env, so their effect on LLM behavior is reviewable in git.
 */

/** Max bytes of text returned from a single tool call. Prevents blowing up the
 * LLM context on a huge search or a gigantic page. Tools truncate above this
 * and include a `truncated: true` marker with advice on narrowing the query. */
export const CHARACTER_LIMIT = 25_000;

/** Max ripgrep hits per `wiki_search` call. Beyond this, results are capped
 * and the tool instructs the caller to narrow `query` or `path_glob`. */
export const MAX_SEARCH_HITS = 100;

/** Per-invocation timeout for spawned ripgrep. Generous for large repos. */
export const RIPGREP_TIMEOUT_MS = 5_000;

/** Default pagination page size for list-returning tools. */
export const DEFAULT_LIMIT = 20;

/** Max pagination page size — protects against `limit: 10000`. */
export const MAX_LIMIT = 100;

/** MCP server identity, used in the protocol handshake. */
export const SERVER_INFO = {
  name: "gitea-wiki-mcp-server",
  version: "0.1.0",
} as const;
