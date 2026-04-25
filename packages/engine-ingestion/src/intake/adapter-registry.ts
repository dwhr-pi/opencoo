/**
 * AdapterRegistry — engine-ingestion looks up the source adapter
 * for an incoming binding by its `adapter_slug`. v0.1 ships an
 * in-memory registry; the SourceAdapter port itself lands in PR
 * 23+. Until then, the receiver only needs `get(slug)` /
 * `require(slug)` shape — a bare `{ slug }` stub is enough.
 */
import { AdapterNotFoundError } from "./errors.js";

/**
 * Minimum surface PR 14 needs from a SourceAdapter. PR 23+ widens
 * this to the full adapter contract (verifyWebhook, fetchPayload,
 * pollForChanges, etc.). For today, the receiver only needs the
 * slug to confirm a binding's adapter is registered + wired.
 */
export interface SourceAdapterStub {
  readonly slug: string;
}

export class InMemoryAdapterRegistry {
  private readonly bySlug = new Map<string, SourceAdapterStub>();

  register(adapter: SourceAdapterStub): void {
    if (this.bySlug.has(adapter.slug)) {
      throw new Error(
        `InMemoryAdapterRegistry: duplicate adapter slug '${adapter.slug}'`,
      );
    }
    this.bySlug.set(adapter.slug, adapter);
  }

  get(slug: string): SourceAdapterStub | undefined {
    return this.bySlug.get(slug);
  }

  /** Throws AdapterNotFoundError when the slug isn't registered. */
  require(slug: string): SourceAdapterStub {
    const a = this.bySlug.get(slug);
    if (a === undefined) throw new AdapterNotFoundError(slug);
    return a;
  }

  list(): ReadonlyArray<SourceAdapterStub> {
    return [...this.bySlug.values()];
  }
}

export { AdapterNotFoundError };
