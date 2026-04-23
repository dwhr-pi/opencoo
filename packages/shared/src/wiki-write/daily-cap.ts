import type { DomainSlug } from "../db/brands.js";

import { WikiWriteCapExceededError } from "./errors.js";

const DEFAULT_DAILY_LIMIT = 10;

// Per-domain daily delete counter. `reserve(slug, n, now)` commits
// `n` against the (slug, today) budget and throws when the total
// would exceed the configured limit. Date-based reset uses the ISO
// YYYY-MM-DD prefix from the injected clock (test-friendly).
export interface DeleteCap {
  reserve(domainSlug: DomainSlug, count: number, now: Date): void;
}

interface CounterEntry {
  isoDate: string;
  count: number;
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface InMemoryDeleteCapOptions {
  readonly dailyLimit?: number;
}

export class InMemoryDeleteCap implements DeleteCap {
  private readonly counts: Map<DomainSlug, CounterEntry> = new Map();
  private readonly dailyLimit: number;

  constructor(options: InMemoryDeleteCapOptions = {}) {
    this.dailyLimit = options.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  }

  reserve(domainSlug: DomainSlug, count: number, now: Date): void {
    const today = isoDate(now);
    const prior = this.counts.get(domainSlug);
    const current =
      prior === undefined || prior.isoDate !== today ? 0 : prior.count;
    const next = current + count;
    if (next > this.dailyLimit) {
      throw new WikiWriteCapExceededError(
        `wiki-write delete cap exceeded for ${domainSlug}: ${current}+${count} > ${this.dailyLimit} on ${today}`,
      );
    }
    this.counts.set(domainSlug, { isoDate: today, count: next });
  }
}
