/**
 * In-memory `GiteaClient` for hermetic adapter tests. Stores per-repo
 * state and records every commit so `inspectCommit` can answer the
 * contract suite's pass-through assertions (8/9/10).
 *
 * Stale-detect: the mock compares `args.parentSha` against the repo's
 * current HEAD on `commitFiles`. Mismatch → returns `{status:'stale',
 * currentSha}` (NEVER throws). Matches the `GiteaRestClient` shape
 * exactly so the adapter handles both backends identically.
 *
 * The mock is intentionally dumb: no per-file SHA tracking on
 * `update`/`delete`. The contract only races at the BRANCH level
 * (Gitea returns 409 on a stale branch HEAD), and replicating
 * per-file SHA semantics would be busy-work without contract value.
 */
import { createHash } from "node:crypto";

import type {
  CommitFilesArgs,
  CommitFilesResult,
  CommitInspection,
  GiteaClient,
  GiteaFileChange,
  GiteaFileContent,
  GiteaRepoLocator,
} from "../client.js";

interface RepoState {
  head: string;
  /** path → utf8 content. Mock does not retain history; only the
   *  commit-log + the live tree. */
  files: Map<string, string>;
  commits: Map<string, CommitInspection>;
}

const INITIAL_HEAD = "0000000000000000000000000000000000000000";

function repoKey(repo: GiteaRepoLocator): string {
  return `${repo.owner}/${repo.name}`;
}

function nextSha(prevHead: string, message: string): string {
  return createHash("sha256")
    .update(prevHead)
    .update("\n")
    .update(message)
    .digest("hex");
}

function applyChange(state: RepoState, change: GiteaFileChange): void {
  if (change.mode === "delete") {
    state.files.delete(change.path);
    return;
  }
  // create | update — base64 in, utf-8 out (matches the real client).
  const utf8 = Buffer.from(change.contentBase64, "base64").toString("utf8");
  state.files.set(change.path, utf8);
}

export class MockGiteaClient implements GiteaClient {
  private readonly repos: Map<string, RepoState> = new Map();

  /**
   * Fixture helper — ensures a repo exists with empty state and a
   * deterministic initial HEAD. Used by tests; not part of the
   * `GiteaClient` port.
   */
  async initRepo(repo: GiteaRepoLocator): Promise<void> {
    const key = repoKey(repo);
    if (!this.repos.has(key)) {
      this.repos.set(key, {
        head: INITIAL_HEAD,
        files: new Map(),
        commits: new Map(),
      });
    }
  }

  /**
   * Test-only backdoor — simulates an EXTERNAL commit landing on the
   * branch, advancing HEAD without going through `commitFiles`. Used
   * by the preflight regression tests (copilot #13) to prove that
   * unrelated-file races make a subsequent commitFiles({parentSha:
   * oldHead}) surface as `stale`. Not part of the `GiteaClient` port;
   * production code must never call this.
   *
   * @internal
   */
  _injectConcurrentCommit(
    repo: GiteaRepoLocator,
    branch: string,
    path: string,
    content: string,
  ): string {
    void branch;
    const state = this.stateOf(repo);
    state.files.set(path, content);
    const newHead = nextSha(state.head, `__concurrent__:${path}`);
    state.head = newHead;
    state.commits.set(newHead, {
      message: `[concurrent] ${path}`,
      authorName: "external",
      authorEmail: "external@opencoo.test",
    });
    return newHead;
  }

  async getBranchSha(
    repo: GiteaRepoLocator,
    branch: string,
  ): Promise<string> {
    // The mock keeps a single HEAD per repo regardless of branch — the
    // adapter only ever asks for the configured branch. Reference the
    // arg so noUnusedParameters doesn't fire; a future multi-branch
    // mock can hash by `${repoKey}/${branch}`.
    void branch;
    return this.stateOf(repo).head;
  }

  async getFileContent(
    repo: GiteaRepoLocator,
    path: string,
    ref: string,
  ): Promise<GiteaFileContent | null> {
    // Mock has no commit history — `ref` is the live HEAD by
    // construction. Real GiteaRestClient honours `ref` against the
    // server; the mock can't, and the adapter doesn't depend on it.
    void ref;
    const state = this.repos.get(repoKey(repo));
    const content = state?.files.get(path);
    if (content === undefined) return null;
    // Blob sha — not the commit sha; deterministic content-hash so the
    // adapter can diff in the "did the file change" sense.
    const sha = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content, "utf8")}\0`)
      .update(content)
      .digest("hex");
    return { content, sha };
  }

  async commitFiles(args: CommitFilesArgs): Promise<CommitFilesResult> {
    const state = this.stateOf(args.repo);
    if (args.parentSha !== state.head) {
      return { status: "stale", currentSha: state.head };
    }
    for (const f of args.files) applyChange(state, f);
    const newHead = nextSha(state.head, args.message);
    state.head = newHead;
    state.commits.set(newHead, {
      message: args.message,
      authorName: args.authorName,
      authorEmail: args.authorEmail,
    });
    return { status: "ok", commitSha: newHead };
  }

  async inspectCommit(
    repo: GiteaRepoLocator,
    sha: string,
  ): Promise<CommitInspection> {
    const state = this.stateOf(repo);
    const recorded = state.commits.get(sha);
    if (recorded === undefined) {
      throw new Error(
        `MockGiteaClient: no recorded commit ${sha} in ${repoKey(repo)}`,
      );
    }
    return recorded;
  }

  async listTreePaths(
    repo: GiteaRepoLocator,
    branch: string,
  ): Promise<readonly string[]> {
    void branch; // mock has no branch concept, only one branch per repo
    const state = this.repos.get(repoKey(repo));
    if (state === undefined) return [];
    return [...state.files.keys()];
  }

  private stateOf(repo: GiteaRepoLocator): RepoState {
    const key = repoKey(repo);
    let state = this.repos.get(key);
    if (state === undefined) {
      state = {
        head: INITIAL_HEAD,
        files: new Map(),
        commits: new Map(),
      };
      this.repos.set(key, state);
    }
    return state;
  }
}
