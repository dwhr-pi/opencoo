/**
 * Maps a repo `slug` (as passed by tool callers) to the on-disk clone path +
 * its config entry. A missing slug resolves to the configured default repo.
 */
import path from "node:path";
import type { Config, RepoEntry } from "../config.js";

export class UnknownRepoError extends Error {
  constructor(slug: string, available: string[]) {
    super(
      `Unknown repo "${slug}". Known slugs: ${available.join(", ") || "(none)"}`,
    );
    this.name = "UnknownRepoError";
  }
}

export interface ResolvedRepo {
  entry: RepoEntry;
  /** Absolute path to the cloned repo on disk. */
  repoPath: string;
  /** Absolute path to the index.json for this repo. */
  indexPath: string;
}

export class RepoRegistry {
  private readonly bySlug: Map<string, RepoEntry>;
  private readonly defaultSlug: string;
  private readonly dataDir: string;

  constructor(config: Config) {
    this.bySlug = new Map(config.repos.map((r) => [r.slug, r]));
    // loadConfig() guarantees exactly one default.
    const def = config.repos.find((r) => r.default);
    if (!def) throw new Error("BUG: no default repo (config validation missed)");
    this.defaultSlug = def.slug;
    this.dataDir = config.dataDir;
  }

  /**
   * Resolve optional slug to a repo bundle. Throws UnknownRepoError if the
   * slug doesn't match any configured repo.
   */
  resolve(slug?: string): ResolvedRepo {
    const effective = slug ?? this.defaultSlug;
    const entry = this.bySlug.get(effective);
    if (!entry) {
      throw new UnknownRepoError(effective, [...this.bySlug.keys()]);
    }
    return {
      entry,
      repoPath: path.join(this.dataDir, "repos", entry.slug),
      indexPath: path.join(this.dataDir, "index", `${entry.slug}.json`),
    };
  }

  list(): RepoEntry[] {
    return [...this.bySlug.values()];
  }

  getDefaultSlug(): string {
    return this.defaultSlug;
  }
}
