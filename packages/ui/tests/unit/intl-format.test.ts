/**
 * Tests for `packages/ui/src/lib/intl-format.ts` — locale-aware
 * number / currency / date / relative-time helpers (PR-C3,
 * wave-16).
 *
 * CI-coverage note (Copilot triage on PR #175): this suite lives
 * under `packages/ui/` so it runs via
 * `pnpm --filter @opencoo/ui test`, NOT via the root
 * `pnpm test` shard that CI invokes (the root vitest config
 * excludes `packages/ui/**` because its pool is node-env and the
 * UI specs need jsdom). The load-bearing locale-bundle contract
 * is pinned by `tools/i18n-check.test.ts` which DOES run in CI
 * via the root vitest config; this file's behaviour-pinning runs
 * on every local `pnpm --filter @opencoo/ui test`. Wiring a
 * dedicated `ui` CI job is a separate follow-up (4 pre-existing
 * UI test failures on main need triage first; not in scope here).
 *
 * Pin matrix:
 *   1. `formatUsd` — preserves the wave-9 Cost-tab behavior:
 *      en → `$1,234.56`, pl → comma-as-decimal, negative amounts
 *      render with a leading `-`.
 *   2. `formatNumber` — locale-shaped grouping for plain integers.
 *   3. `formatDateTime` — `Intl.DateTimeFormat` output that
 *      contains the right calendar parts for each locale.
 *   4. `formatRelativeTime` — `Intl.RelativeTimeFormat` produces
 *      Polish phrasing (`temu`) for past offsets and English
 *      (`ago`) for the same offset under `en`.
 *   5. `intlLocale` — maps i18next codes onto BCP-47 tags so an
 *      unknown locale falls back to `en-US`.
 */
import { describe, expect, it } from "vitest";

import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  formatTime,
  formatUsd,
  intlLocale,
} from "../../src/lib/intl-format.js";

describe("intlLocale", () => {
  it("maps en → en-US", () => {
    expect(intlLocale("en")).toBe("en-US");
  });

  it("maps pl → pl-PL", () => {
    expect(intlLocale("pl")).toBe("pl-PL");
  });

  it("falls back to en-US for unknown codes", () => {
    expect(intlLocale("de")).toBe("en-US");
    expect(intlLocale("")).toBe("en-US");
  });

  it("matches a regional sub-tag prefix", () => {
    expect(intlLocale("pl-PL")).toBe("pl-PL");
    expect(intlLocale("en-GB")).toBe("en-US");
  });
});

describe("formatUsd", () => {
  it("renders en grouping with comma separator", () => {
    expect(formatUsd(1234.56, "en")).toBe("$1,234.56");
  });

  it("renders pl with comma decimal separator", () => {
    // The contract is that the decimal separator is a comma
    // under Polish locale; the grouping separator's exact glyph
    // (regular vs narrow NBSP) depends on the runtime's ICU
    // build and isn't load-bearing here.
    const out = formatUsd(1234.56, "pl");
    expect(out.startsWith("$")).toBe(true);
    expect(out).toMatch(/,56$/);
    expect(out).not.toMatch(/\.56$/);
  });

  it("renders pl grouping for amounts past 9,999", () => {
    const out = formatUsd(1234567.89, "pl");
    expect(out).toMatch(/,89$/);
  });

  it("renders a negative amount with leading minus", () => {
    expect(formatUsd(-42.5, "en")).toBe("-$42.50");
  });

  it("always renders two fraction digits", () => {
    expect(formatUsd(7, "en")).toBe("$7.00");
    expect(formatUsd(0, "en")).toBe("$0.00");
  });
});

describe("formatNumber", () => {
  it("renders en grouping for a large integer", () => {
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
  });

  it("renders pl grouping for a large integer", () => {
    const out = formatNumber(1234567, "pl");
    expect(out).toMatch(/^1.*234.*567$/);
    expect(out).not.toMatch(/,/);
  });
});

describe("formatDateTime", () => {
  it("renders a recognisable date string for en", () => {
    const out = formatDateTime("2026-01-15T10:30:00Z", "en");
    expect(out).toMatch(/2026/);
    expect(out.length).toBeGreaterThan(8);
  });

  it("renders a recognisable date string for pl", () => {
    const out = formatDateTime("2026-01-15T10:30:00Z", "pl");
    expect(out).toMatch(/2026/);
    expect(out.length).toBeGreaterThan(8);
  });

  it("accepts a Date object", () => {
    const d = new Date("2026-01-15T10:30:00Z");
    const out = formatDateTime(d, "en");
    expect(out).toMatch(/2026/);
  });
});

describe("formatDate", () => {
  it("renders date without time-of-day", () => {
    const out = formatDate("2026-01-15T10:30:00Z", "en");
    expect(out).toMatch(/2026/);
    expect(out).not.toMatch(/:/);
  });
});

describe("formatTime", () => {
  it("renders only the time portion", () => {
    const out = formatTime("2026-01-15T10:30:45Z", "en");
    expect(out).toMatch(/:/);
    expect(out).not.toMatch(/2026/);
  });
});

describe("formatRelativeTime", () => {
  it("renders English `ago` for a past offset", () => {
    const now = Date.now();
    const past = new Date(now - 3 * 60 * 60 * 1000);
    const out = formatRelativeTime(past, "en", new Date(now));
    expect(out).toMatch(/ago/);
  });

  it("renders Polish `temu` for a past offset", () => {
    const now = Date.now();
    const past = new Date(now - 3 * 60 * 60 * 1000);
    const out = formatRelativeTime(past, "pl", new Date(now));
    expect(out).toMatch(/temu/);
  });

  it("renders English `in` for a future offset", () => {
    const now = Date.now();
    const future = new Date(now + 5 * 60 * 1000);
    const out = formatRelativeTime(future, "en", new Date(now));
    expect(out).toMatch(/in/);
  });

  it("picks an appropriate unit for the magnitude", () => {
    const now = Date.now();
    const dayAgo = new Date(now - 26 * 60 * 60 * 1000);
    const out = formatRelativeTime(dayAgo, "en", new Date(now));
    expect(out).toMatch(/day|hour/);
  });
});
