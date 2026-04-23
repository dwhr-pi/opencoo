/**
 * LRU cache for wiki indexes loaded from disk. Invalidated after every
 * successful `git pull` (see GitSync).
 */
import { LRUCache } from "lru-cache";
import { loadIndex, type WikiIndex } from "../sync/index-builder.js";

const cache = new LRUCache<string, WikiIndex>({
  max: 32,
  ttl: 1000 * 60 * 10, // 10min safety TTL; explicit invalidation is the main path
});

/** Get the index for a repo slug, loading from disk on cache miss. */
export async function getIndex(
  slug: string,
  indexPath: string,
): Promise<WikiIndex | null> {
  const hit = cache.get(slug);
  if (hit) return hit;
  const loaded = await loadIndex(indexPath);
  if (loaded) cache.set(slug, loaded);
  return loaded;
}

/** Drop a cached index. Call after rebuilding the index on disk. */
export function invalidateIndex(slug: string): void {
  cache.delete(slug);
}
