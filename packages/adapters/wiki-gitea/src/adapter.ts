/**
 * `GiteaWikiAdapter` — implements the WikiAdapter port via Gitea's REST
 * API. Pass-through transport: takes the fully-built commit message
 * from `WriteAtomicArgs.commitMessage` and writes it byte-for-byte
 * (Correction A from team-lead). `coAuthors` in args is INFORMATIONAL
 * only — never injected into the commit text; that's wikiWrite()'s job
 * upstream.
 *
 * Domain → repo binding: `domainSlug` is mapped to
 * `${owner}/${repoPrefix}-${slug}`. The wiki-write path-guard already
 * forbids `wiki-` segments inside page paths, so the prefix doesn't
 * collide with file content. We re-validate every op.path here too
 * (defense-in-depth — required by wikiAdapterContract assertion #11).
 *
 * Append semantics on Gitea: there's no native `append` operation.
 * The adapter resolves it as read-old-content + concat + update.
 * That's two HTTP calls per `append` op; for the v0.1 workload
 * (compiler / lint writes a few pages per run) this is fine. Future
 * optimisation could batch reads, but not until profiling shows it
 * matters.
 */
import type { DomainSlug } from "@opencoo/shared/db";
import { validatePath } from "@opencoo/shared/wiki-write";
import type {
  WikiAdapter,
  WikiOperation,
  WriteAtomicArgs,
  WriteAtomicResult,
} from "@opencoo/shared/wiki-write";

import type {
  CommitInspection,
  GiteaClient,
  GiteaFileChange,
  GiteaRepoLocator,
} from "./client.js";

export interface GiteaWikiAdapterDeps {
  readonly client: GiteaClient;
  /** Owner of every wiki repo (org or user). */
  readonly owner: string;
  /** Repo-name prefix; concrete repo per domain is
   *  `{owner}/{repoPrefix}-{domainSlug}`. */
  readonly repoPrefix: string;
  /** Branch to write to. v0.1 uses a single branch per domain
   *  (typically "main"). Multi-branch flows are out of scope. */
  readonly branch: string;
}

/** Surface re-exported from index.ts for the gated contract test. */
export interface GiteaWikiAdapter extends WikiAdapter {
  inspectCommit(sha: string, domainSlug: DomainSlug): Promise<CommitInspection>;
}

class GiteaWikiAdapterImpl implements GiteaWikiAdapter {
  constructor(private readonly deps: GiteaWikiAdapterDeps) {}

  async getHeadSha(domainSlug: DomainSlug): Promise<string> {
    return this.deps.client.getBranchSha(this.repoFor(domainSlug), this.deps.branch);
  }

  async readPage(
    domainSlug: DomainSlug,
    path: string,
  ): Promise<{ sha: string; content: string } | null> {
    // The page-read path is unauthenticated reads against a known sha;
    // the freshest available sha is the current branch HEAD. wikiWrite
    // calls `getHeadSha` immediately before, so a per-call HEAD lookup
    // here is effectively a noop in the orchestrated path. Worth it
    // for direct readPage() callers (the contract suite, future
    // tooling).
    const repo = this.repoFor(domainSlug);
    const ref = await this.deps.client.getBranchSha(repo, this.deps.branch);
    const file = await this.deps.client.getFileContent(repo, path, ref);
    if (file === null) return null;
    return { sha: file.sha, content: file.content };
  }

  async writeAtomic(args: WriteAtomicArgs): Promise<WriteAtomicResult> {
    // 1. Defense-in-depth path validation. wikiWrite already runs
    //    validatePath; the contract suite locks this rejection at the
    //    adapter layer for any direct caller.
    for (const op of args.operations) {
      validatePath(op.path);
    }

    const repo = this.repoFor(args.domainSlug);
    const files = await this.resolveOperations(repo, args.parentSha, args.operations);

    // 2. Single batch commit. Stale detect is the client's job;
    //    transport failures bubble through (caller upstream wraps in
    //    WikiTransportError if needed).
    const result = await this.deps.client.commitFiles({
      repo,
      branch: this.deps.branch,
      parentSha: args.parentSha,
      message: args.commitMessage, // verbatim — Correction A
      authorName: args.author.name,
      authorEmail: args.author.email,
      files,
    });
    if (result.status === "stale") {
      return { status: "stale", currentSha: result.currentSha };
    }
    return { status: "ok", sha: result.commitSha };
  }

  async inspectCommit(
    sha: string,
    domainSlug: DomainSlug,
  ): Promise<CommitInspection> {
    return this.deps.client.inspectCommit(this.repoFor(domainSlug), sha);
  }

  async listMarkdown(
    domainSlug: DomainSlug,
  ): Promise<readonly string[]> {
    const all = await this.deps.client.listTreePaths(
      this.repoFor(domainSlug),
      this.deps.branch,
    );
    const md = all.filter((p) => p.endsWith(".md"));
    md.sort();
    return md;
  }

  private repoFor(domainSlug: DomainSlug): GiteaRepoLocator {
    return {
      owner: this.deps.owner,
      name: `${this.deps.repoPrefix}-${domainSlug}`,
    };
  }

  /**
   * Translate WikiOperations to Gitea ChangeFiles entries. Every op
   * needs the existing file's blob sha (so create-vs-update can be
   * decided and `update`/`delete` can carry `fromSha`). The resulting
   * list is ALL `create | update | delete` — Gitea has no native
   * append; `append` is resolved here as read-old + concat + update.
   */
  private async resolveOperations(
    repo: GiteaRepoLocator,
    parentSha: string,
    ops: ReadonlyArray<WikiOperation>,
  ): Promise<GiteaFileChange[]> {
    const changes: GiteaFileChange[] = [];
    for (const op of ops) {
      const existing = await this.deps.client.getFileContent(
        repo,
        op.path,
        parentSha,
      );

      if (op.mode === "delete") {
        // Gitea refuses to delete a missing file; treat "delete a
        // path that doesn't exist" as a no-op. The contract suite's
        // delete assertion always preconditions on an existing file.
        if (existing === null) continue;
        changes.push({ mode: "delete", path: op.path, fromSha: existing.sha });
        continue;
      }

      // replace | append — append concatenates onto existing content;
      // replace overwrites. When there's no existing content the two
      // collapse to the same payload.
      const newContent =
        op.mode === "append" && existing !== null
          ? existing.content + op.content
          : op.content;
      const base = {
        mode: existing === null ? "create" : "update",
        path: op.path,
        contentBase64: Buffer.from(newContent, "utf8").toString("base64"),
      } as const;
      changes.push(
        existing !== null ? { ...base, fromSha: existing.sha } : base,
      );
    }
    return changes;
  }
}

export function giteaWikiAdapter(deps: GiteaWikiAdapterDeps): GiteaWikiAdapter {
  return new GiteaWikiAdapterImpl(deps);
}
