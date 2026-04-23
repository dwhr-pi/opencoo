/**
 * Git lifecycle for configured repos: initial clone on boot, periodic `git
 * pull` on an interval, and on-demand pulls (used by the /refresh webhook).
 * All operations are idempotent — `ensureCloned` is safe to re-run.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Config, RepoEntry } from "../config.js";
import type { RepoRegistry } from "../services/repo-registry.js";
import { buildIndex } from "./index-builder.js";
import { invalidateIndex } from "../services/index-cache.js";

export class GitSync {
  private readonly config: Config;
  private readonly registry: RepoRegistry;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(config: Config, registry: RepoRegistry) {
    this.config = config;
    this.registry = registry;
  }

  /** Clone all configured repos if not already present, then build indexes. Idempotent. */
  async ensureAllCloned(): Promise<void> {
    await fs.mkdir(path.join(this.config.dataDir, "repos"), { recursive: true });
    await fs.mkdir(path.join(this.config.dataDir, "index"), { recursive: true });
    for (const entry of this.registry.list()) {
      await this.ensureCloned(entry);
      await this.rebuildIndex(entry);
    }
  }

  /** Clone one repo if missing, otherwise fast-forward via `git pull`. Pull
   * failures are logged but do NOT throw — stale content is better than
   * refusing to serve. */
  async ensureCloned(entry: RepoEntry): Promise<void> {
    const repoPath = path.join(this.config.dataDir, "repos", entry.slug);
    if (existsSync(path.join(repoPath, ".git"))) {
      try {
        await this.pullOne(entry);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[git-sync] initial pull of ${entry.slug} failed (continuing with on-disk content): ${msg}`);
      }
      return;
    }
    const cloneUrl = this.buildCloneUrl(entry);
    console.error(`[git-sync] cloning ${entry.slug} -> ${repoPath}`);
    const git = simpleGit();
    await git.clone(cloneUrl, repoPath, ["--depth", "50"]);
    console.error(`[git-sync] cloned ${entry.slug}`);
  }

  /** Pull latest commits for one repo. Safe to call repeatedly. */
  async pullOne(entry: RepoEntry): Promise<{ changed: boolean }> {
    const repoPath = path.join(this.config.dataDir, "repos", entry.slug);
    const git: SimpleGit = simpleGit(repoPath);
    const before = (await git.revparse(["HEAD"])).trim();
    await git.pull();
    const after = (await git.revparse(["HEAD"])).trim();
    const changed = before !== after;
    if (changed) {
      console.error(`[git-sync] pulled ${entry.slug}: ${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
    }
    return { changed };
  }

  /** Pull all repos, rebuilding indexes for those that changed. */
  async pullAll(): Promise<{ slug: string; changed: boolean }[]> {
    const results: { slug: string; changed: boolean }[] = [];
    for (const entry of this.registry.list()) {
      try {
        const { changed } = await this.pullOne(entry);
        if (changed) await this.rebuildIndex(entry);
        results.push({ slug: entry.slug, changed });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[git-sync] pull failed for ${entry.slug}: ${msg}`);
        results.push({ slug: entry.slug, changed: false });
      }
    }
    return results;
  }

  /** Rebuild the wiki index for a single repo. Logs + continues on failure. */
  async rebuildIndex(entry: RepoEntry): Promise<void> {
    const repoPath = path.join(this.config.dataDir, "repos", entry.slug);
    const indexPath = path.join(this.config.dataDir, "index", `${entry.slug}.json`);
    try {
      const index = await buildIndex(entry.slug, repoPath, indexPath);
      invalidateIndex(entry.slug);
      console.error(`[index-builder] built ${entry.slug} (${index.page_count} pages)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[index-builder] failed ${entry.slug}: ${msg}`);
    }
  }

  /** Start periodic pulls. Caller is responsible for calling stopScheduler on shutdown. */
  startScheduler(): void {
    if (this.config.syncIntervalMin <= 0) {
      console.error("[git-sync] periodic sync disabled (SYNC_INTERVAL_MIN=0)");
      return;
    }
    const ms = this.config.syncIntervalMin * 60 * 1000;
    this.intervalHandle = setInterval(() => {
      this.pullAll().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[git-sync] scheduled pull error: ${msg}`);
      });
    }, ms);
    console.error(`[git-sync] periodic pulls every ${this.config.syncIntervalMin}min`);
  }

  stopScheduler(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Build the clone URL with the PAT embedded for HTTPS auth.
   * The PAT is never logged — simpleGit doesn't echo the URL. */
  private buildCloneUrl(entry: RepoEntry): string {
    const base = new URL(this.config.giteaBaseUrl);
    // Format: https://<user>:<pat>@host/owner/name.git
    // Gitea accepts any username when a PAT is used; we use "x-access-token".
    return `${base.protocol}//x-access-token:${this.config.giteaPat}@${base.host}/${entry.owner}/${entry.name}.git`;
  }
}
