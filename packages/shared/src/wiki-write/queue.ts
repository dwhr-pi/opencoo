import type { DomainSlug } from "../db/brands.js";

// Per-domain serialisation surface. Each `enqueue(slug, fn)` returns
// a promise that resolves to `fn()`'s output, but the queue
// guarantees two concurrent `enqueue` calls for the same slug run
// strictly sequentially — no interleaving, no racing on wiki HEAD.
// Different slugs run concurrently; there's no cross-domain lock.
export interface WikiWriteQueue {
  enqueue<T>(domainSlug: DomainSlug, fn: () => Promise<T>): Promise<T>;
}

// In-memory implementation: a promise-chain per domain. When a new
// task arrives, we chain its execution after whatever was previously
// stored; the chained promise becomes the new tail. The Map entry
// isn't cleared after resolve — memory grows proportionally to
// distinct domains touched (not proportional to calls). Acceptable
// for v0.1; the PR 13 BullMQ queue replaces this for horizontal
// scale.
export class InMemoryWikiWriteQueue implements WikiWriteQueue {
  private readonly tails: Map<DomainSlug, Promise<unknown>> = new Map();

  async enqueue<T>(
    domainSlug: DomainSlug,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prior = this.tails.get(domainSlug) ?? Promise.resolve();
    // Swallow the prior's rejection in the chain — one task's failure
    // must not propagate and cancel all subsequent tasks for the
    // domain. Each caller still sees its own promise resolve or
    // reject with its own outcome.
    const next = prior.catch(() => undefined).then(() => fn());
    this.tails.set(domainSlug, next);
    return next;
  }
}
