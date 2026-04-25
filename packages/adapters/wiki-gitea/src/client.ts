/**
 * GiteaClient port — narrow surface over the four Gitea REST endpoints
 * the WikiAdapter needs. Raw `fetch`, no `gitea-js` (Correction C from
 * team-lead): smaller supply chain, exact request shape under our
 * control, easier to mock.
 *
 * The endpoints used by `GiteaRestClient`:
 *
 *   GET  /api/v1/repos/{owner}/{repo}/branches/{branch}
 *   GET  /api/v1/repos/{owner}/{repo}/contents/{path}?ref={sha}
 *   POST /api/v1/repos/{owner}/{repo}/contents              (ChangeFilesOptions — batch)
 *   GET  /api/v1/repos/{owner}/{repo}/git/commits/{sha}
 *
 * The port is deliberately Gitea-shaped (file changes carry base64
 * content; stale-detect leans on Gitea's HTTP 422 + diagnostic body
 * — see `isStaleSignalMessage` for the three recognised phrases).
 * Two implementations consume it: `GiteaRestClient` (real wire) and
 * `MockGiteaClient` in `./testing/mock-client.ts`.
 *
 * Stale-detect contract: `commitFiles` returns `{ status: 'stale',
 * currentSha }` when the request's `parentSha` no longer matches the
 * branch HEAD. The adapter passes this through to its
 * `WriteAtomicResult`. NEVER throw on stale — it's the normal path.
 *
 * Error surface: transport failures (non-422 HTTP errors, malformed
 * JSON, 422s whose body doesn't match a stale-signal phrase) throw a
 * plain `Error` with the failing endpoint and HTTP status. The
 * orchestrating `wikiWrite()` upstream is the layer that wraps these
 * into `WikiTransportError` if it needs the typed-error semantics —
 * the adapter stays stack-light and dependency-free on shared/errors.
 */

// ---------------------------------------------------------------------------
// Port shapes
// ---------------------------------------------------------------------------

export interface GiteaRepoLocator {
  readonly owner: string;
  readonly name: string;
}

export interface GiteaFileContent {
  readonly content: string;
  readonly sha: string;
}

export type GiteaFileChange =
  | {
      readonly mode: "create" | "update";
      readonly path: string;
      readonly contentBase64: string;
      /** SHA of the file's previous version. Required for `update` so
       *  Gitea can detect concurrent edits to the same file. */
      readonly fromSha?: string;
    }
  | {
      readonly mode: "delete";
      readonly path: string;
      readonly fromSha: string;
    };

export interface CommitFilesArgs {
  readonly repo: GiteaRepoLocator;
  readonly branch: string;
  readonly parentSha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly files: ReadonlyArray<GiteaFileChange>;
}

export type CommitFilesResult =
  | { readonly status: "ok"; readonly commitSha: string }
  | { readonly status: "stale"; readonly currentSha: string };

export interface CommitInspection {
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
}

export interface GiteaClient {
  /** Returns the HEAD commit sha of the branch. */
  getBranchSha(repo: GiteaRepoLocator, branch: string): Promise<string>;
  /** Returns file content + blob-sha at the given commit; `null` for
   *  missing files (so the adapter can map to `readPage` → null). */
  getFileContent(
    repo: GiteaRepoLocator,
    path: string,
    ref: string,
  ): Promise<GiteaFileContent | null>;
  /** Atomic batch commit. Stale-detect returns `ok | stale`; transport
   *  failures (non-stale HTTP errors, malformed JSON, etc.) throw a
   *  plain `Error` — `wikiWrite()` upstream wraps that into a typed
   *  `WikiTransportError` when callers need the taxonomy. */
  commitFiles(args: CommitFilesArgs): Promise<CommitFilesResult>;
  /** Optional commit-metadata reader, used by the contract suite's
   *  CommitInspector path (assertions 8/9/10). */
  inspectCommit(repo: GiteaRepoLocator, sha: string): Promise<CommitInspection>;
  /** List every file path in the repo at the given branch. The
   *  adapter filters to `*.md` and sorts; the client returns the
   *  full tree because future use-cases (Lint, Cleanup) may need
   *  other extensions. (PR 17 / plan #77, for the Index Rebuilder
   *  pipeline.) */
  listTreePaths(repo: GiteaRepoLocator, branch: string): Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

export interface GiteaRestClientOptions {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface BranchResponse {
  readonly commit?: { readonly id?: unknown };
}

interface ContentsResponse {
  readonly content?: unknown;
  readonly sha?: unknown;
  readonly type?: unknown;
}

interface CommitResponse {
  readonly message?: unknown;
  readonly commit?: {
    readonly message?: unknown;
    readonly author?: {
      readonly name?: unknown;
      readonly email?: unknown;
    };
  };
  readonly author?: {
    readonly login?: unknown;
    readonly email?: unknown;
  };
}

interface ChangeFilesResponse {
  readonly commit?: { readonly sha?: unknown };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Raw-fetch GiteaClient. Trims trailing slashes from the URL and uses
 * the documented `Authorization: token <pat>` header style (Gitea
 * accepts `Bearer` too but `token` keeps logs unambiguous).
 */
export class GiteaRestClient implements GiteaClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GiteaRestClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getBranchSha(
    repo: GiteaRepoLocator,
    branch: string,
  ): Promise<string> {
    const path = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches/${encodeURIComponent(branch)}`;
    const response = await this.request("GET", path);
    if (!response.ok) {
      throw new Error(
        `Gitea getBranchSha ${repo.owner}/${repo.name}@${branch} → HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!isObject(body)) {
      throw new Error(
        `Gitea getBranchSha returned non-object for ${repo.owner}/${repo.name}@${branch}`,
      );
    }
    const commit = (body as BranchResponse).commit;
    if (!isObject(commit) || typeof commit.id !== "string") {
      throw new Error(
        `Gitea getBranchSha response missing commit.id for ${repo.owner}/${repo.name}@${branch}`,
      );
    }
    return commit.id;
  }

  async getFileContent(
    repo: GiteaRepoLocator,
    filePath: string,
    ref: string,
  ): Promise<GiteaFileContent | null> {
    const path = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`;
    const response = await this.request("GET", path);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Gitea getFileContent ${repo.owner}/${repo.name}/${filePath} → HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!isObject(body)) {
      throw new Error(
        `Gitea getFileContent returned non-object for ${repo.owner}/${repo.name}/${filePath}`,
      );
    }
    const cb = body as ContentsResponse;
    // Directory listings come back as arrays — the adapter only ever
    // asks for a file path, so anything non-file is a caller bug.
    if (cb.type !== "file") {
      throw new Error(
        `Gitea getFileContent expected file at ${filePath}, got ${String(cb.type)}`,
      );
    }
    if (typeof cb.content !== "string" || typeof cb.sha !== "string") {
      throw new Error(
        `Gitea getFileContent malformed response for ${filePath}`,
      );
    }
    return {
      content: Buffer.from(cb.content, "base64").toString("utf8"),
      sha: cb.sha,
    };
  }

  async commitFiles(args: CommitFilesArgs): Promise<CommitFilesResult> {
    // Preflight: HEAD vs parentSha (copilot #13). Gitea's per-file SHA
    // rejection only catches conflicts ON THE SAME PATH — an unrelated
    // concurrent commit advances HEAD without per-file conflict, and
    // a naive POST would silently succeed with the WRONG git parent.
    // The WriteAtomicArgs.parentSha contract requires "proceed only if
    // HEAD === parentSha, else stale" — surface the stale status here
    // before any write.
    const headSha = await this.getBranchSha(args.repo, args.branch);
    if (headSha !== args.parentSha) {
      return { status: "stale", currentSha: headSha };
    }

    const path = `/api/v1/repos/${encodeURIComponent(args.repo.owner)}/${encodeURIComponent(args.repo.name)}/contents`;
    // Gitea's ChangeFilesOptions: `branch`, `new_branch?`, `message`,
    // `author`, `committer`, `dates`, `files: [{operation, path,
    // content?, sha?, from_path?}]`. We pin author=committer and skip
    // dates so the server timestamps the commit.
    const body = {
      branch: args.branch,
      message: args.message,
      author: { name: args.authorName, email: args.authorEmail },
      committer: { name: args.authorName, email: args.authorEmail },
      files: args.files.map((f) => {
        if (f.mode === "delete") {
          return { operation: "delete", path: f.path, sha: f.fromSha };
        }
        const base = {
          operation: f.mode, // "create" | "update"
          path: f.path,
          content: f.contentBase64,
        };
        return f.fromSha !== undefined ? { ...base, sha: f.fromSha } : base;
      }),
    };
    const response = await this.request("POST", path, body);
    // Gitea's stale-detect signal is an HTTP 422 with one of two
    // distinguishing messages:
    //   - "sha does not match [given: …, expected: …]"      (update)
    //   - "repository file already exists [path: …]"         (create)
    //   - "repository file does not exist [path: …]"         (delete)
    // Tested against gitea/gitea:1.26.0; older versions used different
    // status codes — if a regression appears, surface the raw message
    // for triage rather than silently expanding the match. Other 422s
    // (malformed body, empty content, etc.) bubble through as
    // transport errors.
    if (response.status === 422) {
      const errMessage = await readErrorMessage(response);
      if (isStaleSignalMessage(errMessage)) {
        const currentSha = await this.getBranchSha(args.repo, args.branch);
        return { status: "stale", currentSha };
      }
      throw new Error(
        `Gitea commitFiles ${args.repo.owner}/${args.repo.name} → HTTP 422: ${errMessage}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Gitea commitFiles ${args.repo.owner}/${args.repo.name} → HTTP ${response.status}`,
      );
    }
    const data: unknown = await response.json();
    if (!isObject(data)) {
      throw new Error(
        `Gitea commitFiles returned non-object for ${args.repo.owner}/${args.repo.name}`,
      );
    }
    const cf = data as ChangeFilesResponse;
    if (!isObject(cf.commit) || typeof cf.commit.sha !== "string") {
      throw new Error(
        `Gitea commitFiles response missing commit.sha for ${args.repo.owner}/${args.repo.name}`,
      );
    }
    return { status: "ok", commitSha: cf.commit.sha };
  }

  async inspectCommit(
    repo: GiteaRepoLocator,
    sha: string,
  ): Promise<CommitInspection> {
    const path = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/commits/${encodeURIComponent(sha)}`;
    const response = await this.request("GET", path);
    if (!response.ok) {
      throw new Error(
        `Gitea inspectCommit ${repo.owner}/${repo.name}@${sha} → HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!isObject(body)) {
      throw new Error(
        `Gitea inspectCommit returned non-object for ${sha}`,
      );
    }
    // Two ways Gitea exposes message + author: top-level (per-commit
    // surface) and nested under `commit` (git-commit shape). Prefer
    // the nested shape; the top-level `author` is the GITEA USER, not
    // the git author of the commit.
    const cb = body as CommitResponse;
    const nested = cb.commit;
    let message: string;
    let authorName: string;
    let authorEmail: string;
    if (
      isObject(nested) &&
      typeof nested.message === "string" &&
      isObject(nested.author) &&
      typeof nested.author.name === "string" &&
      typeof nested.author.email === "string"
    ) {
      message = nested.message;
      authorName = nested.author.name;
      authorEmail = nested.author.email;
    } else if (typeof cb.message === "string") {
      message = cb.message;
      // Fallback — Gitea-user shape (top-level author). authorName
      // best-effort via login; authorEmail straight through.
      const topAuthor = cb.author;
      authorName =
        isObject(topAuthor) && typeof topAuthor.login === "string"
          ? topAuthor.login
          : "";
      authorEmail =
        isObject(topAuthor) && typeof topAuthor.email === "string"
          ? topAuthor.email
          : "";
    } else {
      throw new Error(`Gitea inspectCommit malformed response for ${sha}`);
    }
    return { message, authorName, authorEmail };
  }

  async listTreePaths(
    repo: GiteaRepoLocator,
    branch: string,
  ): Promise<readonly string[]> {
    // Gitea exposes `/api/v1/repos/{owner}/{name}/git/trees/{ref}`
    // with `recursive=true` for a flat list of every blob path.
    // The branch name is a valid `ref` for this endpoint.
    const path = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(branch)}?recursive=true&per_page=1000`;
    const response = await this.request("GET", path);
    if (response.status === 404) {
      // Empty repo (no commits yet) — return [] so the Index
      // Rebuilder pipeline treats it as "no files to index".
      return [];
    }
    if (!response.ok) {
      throw new Error(
        `Gitea listTreePaths ${repo.owner}/${repo.name}@${branch} → HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!isObject(body)) {
      throw new Error(
        `Gitea listTreePaths returned non-object for ${repo.owner}/${repo.name}@${branch}`,
      );
    }
    const tree = (body as { tree?: unknown }).tree;
    if (!Array.isArray(tree)) return [];
    const out: string[] = [];
    for (const entry of tree) {
      if (
        isObject(entry) &&
        typeof entry.path === "string" &&
        // Only blob entries — skip subdirectory marker rows.
        entry.type === "blob"
      ) {
        out.push(entry.path);
      }
    }
    return out;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `token ${this.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        signal: controller.signal,
        // Conditional spread: under exactOptionalPropertyTypes, RequestInit.body
        // does not accept `undefined` — the field has to be ABSENT, not present-but-undefined.
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      };
      return await this.fetchImpl(`${this.url}${path}`, init);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * encodeURIComponent escapes `/`, but Gitea's `/contents/{path}` wants
 * the path to keep its slashes. Encode each segment, then rejoin.
 */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/**
 * Read Gitea's error-shape `{message, url}` body. Falls back to
 * `<unparseable error body>` if the response isn't JSON.
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      isObject(body) &&
      typeof (body as { message?: unknown }).message === "string"
    ) {
      return (body as { message: string }).message;
    }
    return JSON.stringify(body);
  } catch {
    return "<unparseable error body>";
  }
}

/**
 * The three Gitea diagnostic messages that mean "the branch advanced
 * under you / file shape changed". Tested against gitea/gitea:1.26.0;
 * if a future Gitea version rephrases these, this list is the only
 * place to update.
 *
 *   1. update with stale blob sha   → "sha does not match …"
 *   2. create over existing path    → "file already exists …"
 *   3. delete missing path          → "file does not exist …"
 */
const STALE_SIGNAL_PATTERNS = [
  /sha does not match/i,
  /file already exists/i,
  /file does not exist/i,
] as const;

function isStaleSignalMessage(message: string): boolean {
  return STALE_SIGNAL_PATTERNS.some((re) => re.test(message));
}
