/**
 * `wiki://{slug}/{path}` MCP resources (THREAT-MODEL §3.14, phase-a appendix
 * #7 PR-O1). Sibling of `worldview://{slug}` — agents pull individual wiki
 * pages as URI-addressable resources, not tool calls. The PR-N3 runners
 * (Heartbeat / Lint) call `readResource(wiki://{slug}/{path})` and
 * `listResources(filter: { uriPrefix: "wiki://{slug}/" })`; before this
 * registration the gitea-wiki-mcp-server returned `not found` and the
 * runners DLQ'd. This module closes the gap.
 *
 * Authorisation model (mirrors worldview.ts byte-for-byte):
 *   - Static-token principal (`MCP_BEARER_TOKEN`) bypasses the scope check
 *     — internal engine traffic is implicitly full-scope.
 *   - OAuth-principal (Gitea user access token) → every request calls
 *     `GiteaScopeChecker.check(token, owner, name)`. Deny if `allow:false`
 *     or anything throws. The 60s LRU cache inside the checker absorbs
 *     N+1 cost across a session.
 *   - Missing `authInfo` → uniform deny (mirrors worldview).
 *
 * Error uniformity: every deny path (unknown slug / missing file / out-of-
 * scope / path traversal / no auth) surfaces the same `McpError(InvalidRequest,
 * "resource not accessible")`. The distinguishing reason is logged at the
 * operator-facing log; the wire response cannot be used to fingerprint
 * existence vs. scope.
 *
 * Lister model: the MCP `resources/list` protocol does NOT pass a URI prefix
 * to the server-side handler — the SDK calls `listCallback(extra)` with no
 * filter parameter. The PR-N3 client filters URIs by prefix CLIENT-SIDE
 * after the response. So this module's lister returns ALL `wiki://{slug}/{path}`
 * URIs across every repo the principal can see, capped at `WIKI_LIST_CAP`
 * (500 in v0.1; pagination defers per the appendix #7 plan).
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  ListResourcesResult,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoEntry } from "../config.js";
import type { RepoRegistry } from "../services/repo-registry.js";
import { UnknownRepoError } from "../services/repo-registry.js";
import type { GiteaScopeChecker } from "../services/scope-checker.js";
import { safeResolve, PathSafetyError } from "../services/path-safety.js";
import {
  listMarkdownPaths,
  readParsedPage,
} from "../services/wiki-utils.js";

const UNIFORM_DENY_MESSAGE = "resource not accessible";

/** v0.1 ceiling on the number of resources returned by a single
 *  `resources/list` call. Matches the appendix #7 plan; pagination is the
 *  deferred follow-up once a deployment has > 500 pages per domain. */
export const WIKI_LIST_CAP = 500;

/** Deny-cause tags are operator-facing only — never surface in responses. */
type DenyReason =
  | "unknown_slug"
  | "missing_file"
  | "out_of_scope"
  | "no_auth"
  | "bad_uri"
  | "path_unsafe";

export interface WikiResourceDeps {
  readonly registry: RepoRegistry;
  readonly scopeChecker: GiteaScopeChecker;
  /** Optional operator-facing logger. Defaults to a no-op so unit tests
   *  don't spam stderr; production wiring passes through to console.error. */
  readonly log?: (reason: DenyReason, detail: Record<string, unknown>) => void;
}

export type WikiReader = (
  uri: URL,
  extra: { readonly authInfo?: AuthInfo },
) => Promise<ReadResourceResult>;

export type WikiLister = (extra: {
  readonly authInfo?: AuthInfo;
}) => Promise<ListResourcesResult>;

/**
 * Factory returns a reader callable — kept pure (no McpServer dep) so it
 * can be unit-tested without standing up a full MCP session.
 */
export function createWikiReader(deps: WikiResourceDeps): WikiReader {
  const log = deps.log ?? (() => undefined);

  function deny(reason: DenyReason, detail: Record<string, unknown>): never {
    log(reason, detail);
    throw new McpError(ErrorCode.InvalidRequest, UNIFORM_DENY_MESSAGE);
  }

  return async function readWikiPage(uri, extra) {
    const parsed = parseWikiUri(uri);
    if (parsed === null) {
      deny("bad_uri", { uri: uri.href });
    }
    const { slug, path: pagePath } = parsed;

    const authInfo = extra.authInfo;
    if (!authInfo) {
      deny("no_auth", { uri: uri.href });
    }

    // Resolve repo BEFORE scope check so we know which (owner, name) to
    // ask Gitea about. Unknown slug routes to the same uniform deny as
    // out-of-scope to prevent fingerprinting.
    let resolved;
    try {
      resolved = deps.registry.resolve(slug);
    } catch (err) {
      if (err instanceof UnknownRepoError) {
        deny("unknown_slug", { slug });
      }
      throw err;
    }

    const kind = readPrincipalKind(authInfo);
    if (kind === "gitea") {
      let allow = false;
      try {
        const result = await deps.scopeChecker.check(
          authInfo.token,
          resolved.entry.owner,
          resolved.entry.name,
        );
        allow = result.allow;
      } catch {
        // Fail-closed on any scope-check error (network, timeout).
        allow = false;
      }
      if (!allow) {
        deny("out_of_scope", {
          slug: resolved.entry.slug,
          owner: resolved.entry.owner,
          name: resolved.entry.name,
        });
      }
    }

    // Path-traversal guard. `safeResolve` throws PathSafetyError on
    // absolute paths, `..` segments, or null bytes. Map to the uniform
    // deny so callers can't distinguish "bad path" from "no scope".
    let absPath: string;
    try {
      absPath = safeResolve(resolved.repoPath, pagePath);
    } catch (err) {
      if (err instanceof PathSafetyError) {
        deny("path_unsafe", { slug: resolved.entry.slug, requested: pagePath });
      }
      throw err;
    }

    // Only now do we touch disk. Missing file / read error → uniform deny.
    let body: string;
    try {
      const page = await readParsedPage(resolved.repoPath, absPath);
      body = page.body;
    } catch {
      deny("missing_file", { slug: resolved.entry.slug, path: pagePath });
    }

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: body,
        },
      ],
    };
  };
}

/**
 * Factory returns a lister callable. Walks every configured repo, lists
 * markdown pages, and emits `wiki://{slug}/{path}` URIs sorted globally.
 * Repos the principal cannot see are silently omitted (no count leak, no
 * path leak). Static principals see every configured repo.
 */
export function createWikiLister(deps: WikiResourceDeps): WikiLister {
  return async function listWikiPages(extra) {
    const authInfo = extra.authInfo;
    if (!authInfo) {
      // No authInfo → uniform empty list. Cannot enumerate any resource.
      return { resources: [] };
    }
    const kind = readPrincipalKind(authInfo);

    const visibleRepos: RepoEntry[] = [];
    for (const entry of deps.registry.list()) {
      if (kind === "gitea") {
        let allow = false;
        try {
          const result = await deps.scopeChecker.check(
            authInfo.token,
            entry.owner,
            entry.name,
          );
          allow = result.allow;
        } catch {
          allow = false;
        }
        if (!allow) {
          // Silently omit out-of-scope repos. The lister is the OPPOSITE
          // shape from the reader — list returns only what the caller
          // can see, rather than throwing. The appendix #7 plan calls
          // out the "no leakage of page paths" requirement.
          continue;
        }
      }
      visibleRepos.push(entry);
    }

    // Walk each visible repo, collect URIs. Cap GLOBALLY at WIKI_LIST_CAP
    // — early-return once we've reached the ceiling so we don't enumerate
    // every page on disk just to throw most away.
    const resources: Resource[] = [];
    outer: for (const entry of visibleRepos) {
      let resolved;
      try {
        resolved = deps.registry.resolve(entry.slug);
      } catch {
        // resolve() throws UnknownRepoError if the slug isn't in the
        // registry; the entry came FROM the registry's list() call so
        // this is unreachable. Defensive skip.
        continue;
      }
      let pagePaths: string[];
      try {
        pagePaths = await listMarkdownPaths(resolved.repoPath);
      } catch {
        // Repo dir missing on disk (e.g., not yet cloned). Skip this
        // repo — same uniform "no leakage" stance as out-of-scope.
        continue;
      }
      for (const pagePath of pagePaths) {
        resources.push({
          uri: `wiki://${entry.slug}/${pagePath}`,
          name: pagePath,
          mimeType: "text/markdown",
        });
        if (resources.length >= WIKI_LIST_CAP) {
          break outer;
        }
      }
    }

    resources.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    return { resources };
  };
}

/**
 * Parse a `wiki://{slug}/{path}` URL into its slug + repo-relative path.
 * Returns null if the URI does not match the expected shape — the caller
 * routes to uniform deny.
 *
 * WHATWG URL parsing: `new URL("wiki://exec/team/eng.md")` exposes
 * `hostname = "exec"` and `pathname = "/team/eng.md"`. We strip the
 * leading `/` and reject empty / root-only pathnames.
 */
function parseWikiUri(uri: URL): { slug: string; path: string } | null {
  if (uri.protocol !== "wiki:") return null;
  const slug = uri.hostname;
  if (!slug) return null;
  // pathname is always present; "/" or "" means no page selected.
  const raw = uri.pathname ?? "";
  if (raw === "" || raw === "/") return null;
  const stripped = raw.startsWith("/") ? raw.slice(1) : raw;
  if (stripped.length === 0) return null;
  // Decode URL-percent encoding so callers can use spaces / unicode in
  // page names. `decodeURIComponent` throws on malformed input — treat
  // that as an unparsable URI.
  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    return null;
  }
  return { slug, path: decoded };
}

function readPrincipalKind(authInfo: AuthInfo): "static" | "gitea" | "unknown" {
  const extra = authInfo.extra;
  if (extra && typeof extra === "object" && "kind" in extra) {
    const kind = (extra as { kind?: unknown }).kind;
    if (kind === "static" || kind === "gitea") return kind;
  }
  return "unknown";
}

/**
 * Bind reader + lister to an McpServer. Called from `createServer`. The SDK
 * routes `resources/read` to the reader by URI-template match, and walks
 * every registered template's `list` callback to assemble `resources/list`
 * responses (see `mcp.js` line 344-365).
 */
export function registerWikiResources(
  server: McpServer,
  registry: RepoRegistry,
  scopeChecker: GiteaScopeChecker,
  log?: WikiResourceDeps["log"],
): void {
  const reader = createWikiReader({
    registry,
    scopeChecker,
    ...(log !== undefined ? { log } : {}),
  });
  const lister = createWikiLister({
    registry,
    scopeChecker,
    ...(log !== undefined ? { log } : {}),
  });

  // RFC 6570: the `+` operator (reserved-string expansion) matches paths
  // that contain `/`. Plain `{path}` would only match `[^/,]+` per the
  // SDK's UriTemplate implementation, so a real path like `team/eng.md`
  // would fail the template match. `{+path}` makes the page path opaque
  // to template parsing while still binding to the `path` variable.
  server.registerResource(
    "wiki",
    new ResourceTemplate("wiki://{slug}/{+path}", {
      list: async (extra) => lister({ authInfo: extra.authInfo }),
    }),
    {
      title: "Wiki Page",
      description:
        "Individual markdown pages in a domain wiki. URI shape: wiki://{slug}/{path} where {path} is the repo-relative .md path. Returns the page body as text/markdown. Per-request Gitea PAT scope check is enforced for OAuth principals; internal static-token clients get implicit full scope. Listing is capped at 500 entries in v0.1.",
      mimeType: "text/markdown",
    },
    async (uri, _variables, extra) => {
      return reader(uri, { authInfo: extra.authInfo });
    },
  );
}
