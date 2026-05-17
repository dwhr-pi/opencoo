/**
 * Cost analytics dashboard (PR-R5, phase-a appendix #10).
 *
 * Test-first artifact for the new /Cost route. The dashboard is a
 * read-only consumer of `GET /api/admin/cost-summary` — the
 * server returns aggregated usage per groupBy + budgetState per
 * domain, the UI renders the burn-down + stacked-segment chart +
 * sortable bottom table.
 *
 * Pin matrix:
 *   1. Renders MTD total + projection from a mocked GET response.
 *   2. Burn-down threshold colors: <50% renders --healthy,
 *      80-100% renders --advisory, 100%+ renders --alert.
 *   3. Domain without a cap renders --ink-3 muted with "no cap".
 *   4. Stacked-segment bar shows three tier segments with widths
 *      derived from totalUsd.
 *   5. period selector (day/week/month) re-fetches with the new
 *      `?period=` parameter.
 *   6. groupBy selector (domain/model/tier/agent) re-fetches with
 *      the new `?groupBy=` parameter.
 *   7. Empty state when no usage rows have been recorded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import i18n from "../../src/lib/i18n.js";
import { Cost } from "../../src/routes/Cost.js";

interface CostBucketFixture {
  readonly key: string;
  readonly totalUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly runs: number;
}

interface BudgetFixture {
  readonly domainSlug: string;
  readonly capUsd: number | null;
  readonly usedUsd: number;
  readonly projectedEomUsd: number;
  readonly paused: boolean;
}

interface CostSummaryFixture {
  readonly totalUsd: number;
  readonly period: "day" | "week" | "month";
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly byBucket: readonly CostBucketFixture[];
  readonly budgetState: readonly BudgetFixture[];
}

function makeFetch(
  responsesByQuery: (search: URLSearchParams) => CostSummaryFixture,
): {
  readonly fn: typeof fetch;
  readonly calls: URLSearchParams[];
} {
  const calls: URLSearchParams[] = [];
  const fn = vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/cost-summary")) {
      const u = new URL(url, "http://localhost");
      calls.push(u.searchParams);
      const body = responsesByQuery(u.searchParams);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("404", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const EMPTY_BUDGET: CostSummaryFixture = {
  totalUsd: 0,
  period: "month",
  rangeFrom: new Date("2026-05-01T00:00:00Z").toISOString(),
  rangeTo: new Date("2026-05-09T00:00:00Z").toISOString(),
  byBucket: [],
  budgetState: [],
};

describe("Cost route — initial render", () => {
  it("renders MTD total from a mocked GET response", async () => {
    const { fn } = makeFetch(() => ({
      ...EMPTY_BUDGET,
      totalUsd: 42.18,
      byBucket: [
        { key: "wiki-pilot", totalUsd: 42.18, tokensIn: 1000, tokensOut: 500, runs: 12 },
      ],
      budgetState: [
        {
          domainSlug: "wiki-pilot",
          capUsd: 50,
          usedUsd: 42.18,
          projectedEomUsd: 51.5,
          paused: false,
        },
      ],
    }));
    render(<Cost fetchImpl={fn} />);
    await waitFor(() => {
      // The dashboard renders the dollar total in JetBrains Mono.
      expect(screen.getByTestId("cost-total")).toHaveTextContent("$42.18");
    });
    expect(screen.getByTestId("cost-projection")).toHaveTextContent("$51.50");
  });

  it("renders the empty state when no usage rows exist", async () => {
    const { fn } = makeFetch(() => EMPTY_BUDGET);
    render(<Cost fetchImpl={fn} />);
    // The empty-usage hint appears in both the burndown card
    // (no domains yet) and the tier-split card (no spend) — both
    // are legitimate empty surfaces, so getAllByText is correct.
    await waitFor(() => {
      const matches = screen.getAllByText(/no usage recorded yet/i);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("Cost route — burn-down threshold colors", () => {
  it("renders --healthy when usedUsd is under 50% of cap", async () => {
    const { fn } = makeFetch(() => ({
      ...EMPTY_BUDGET,
      totalUsd: 24,
      byBucket: [
        { key: "wiki-pilot", totalUsd: 24, tokensIn: 100, tokensOut: 50, runs: 5 },
      ],
      budgetState: [
        {
          domainSlug: "wiki-pilot",
          capUsd: 50,
          usedUsd: 24, // 48% of cap → healthy
          projectedEomUsd: 30,
          paused: false,
        },
      ],
    }));
    render(<Cost fetchImpl={fn} />);
    const bar = await screen.findByTestId("cost-budget-bar-wiki-pilot");
    // Inline style references the design-system var directly.
    expect(bar.getAttribute("style")).toContain("var(--healthy)");
  });

  it("renders --advisory when usedUsd is 80-100% of cap", async () => {
    const { fn } = makeFetch(() => ({
      ...EMPTY_BUDGET,
      totalUsd: 42,
      byBucket: [
        { key: "wiki-pilot", totalUsd: 42, tokensIn: 100, tokensOut: 50, runs: 5 },
      ],
      budgetState: [
        {
          domainSlug: "wiki-pilot",
          capUsd: 50,
          usedUsd: 42, // 84% of cap → advisory
          projectedEomUsd: 50,
          paused: false,
        },
      ],
    }));
    render(<Cost fetchImpl={fn} />);
    const bar = await screen.findByTestId("cost-budget-bar-wiki-pilot");
    expect(bar.getAttribute("style")).toContain("var(--advisory)");
  });

  it("renders --alert and a paused badge when usedUsd is >= 100% of cap", async () => {
    const { fn } = makeFetch(() => ({
      ...EMPTY_BUDGET,
      totalUsd: 60,
      byBucket: [
        { key: "wiki-pilot", totalUsd: 60, tokensIn: 100, tokensOut: 50, runs: 5 },
      ],
      budgetState: [
        {
          domainSlug: "wiki-pilot",
          capUsd: 50,
          usedUsd: 60, // 120% of cap → alert
          projectedEomUsd: 70,
          paused: true,
        },
      ],
    }));
    render(<Cost fetchImpl={fn} />);
    const bar = await screen.findByTestId("cost-budget-bar-wiki-pilot");
    expect(bar.getAttribute("style")).toContain("var(--alert)");
    expect(screen.getByTestId("cost-budget-paused-wiki-pilot")).toBeInTheDocument();
  });

  it("renders muted no-cap label when capUsd is null", async () => {
    const { fn } = makeFetch(() => ({
      ...EMPTY_BUDGET,
      totalUsd: 12,
      byBucket: [
        { key: "wiki-misc", totalUsd: 12, tokensIn: 100, tokensOut: 50, runs: 3 },
      ],
      budgetState: [
        {
          domainSlug: "wiki-misc",
          capUsd: null,
          usedUsd: 12,
          projectedEomUsd: 24,
          paused: false,
        },
      ],
    }));
    render(<Cost fetchImpl={fn} />);
    const noCap = await screen.findByTestId("cost-budget-no-cap-wiki-misc");
    expect(noCap).toHaveTextContent(/no cap/i);
    expect(noCap.getAttribute("style")).toContain("var(--ink-3)");
  });
});

describe("Cost route — stacked-segment bar", () => {
  it("renders three tier segments whose widths are proportional to spend", async () => {
    const { fn } = makeFetch((search) => {
      // The stacked-segment bar uses a separate `groupBy=tier`
      // request the route fires alongside the default one. When
      // the URL carries `groupBy=tier` we return the tier split.
      if (search.get("groupBy") === "tier") {
        return {
          ...EMPTY_BUDGET,
          totalUsd: 100,
          byBucket: [
            { key: "thinker", totalUsd: 60, tokensIn: 1000, tokensOut: 500, runs: 5 },
            { key: "worker", totalUsd: 30, tokensIn: 500, tokensOut: 200, runs: 8 },
            { key: "light", totalUsd: 10, tokensIn: 300, tokensOut: 100, runs: 12 },
          ],
        };
      }
      return {
        ...EMPTY_BUDGET,
        totalUsd: 100,
        byBucket: [
          { key: "wiki-pilot", totalUsd: 100, tokensIn: 1800, tokensOut: 800, runs: 25 },
        ],
        budgetState: [
          {
            domainSlug: "wiki-pilot",
            capUsd: null,
            usedUsd: 100,
            projectedEomUsd: 100,
            paused: false,
          },
        ],
      };
    });
    render(<Cost fetchImpl={fn} />);
    await waitFor(() => {
      expect(screen.getByTestId("cost-tier-segment-thinker")).toBeInTheDocument();
    });
    const thinker = screen.getByTestId("cost-tier-segment-thinker");
    const worker = screen.getByTestId("cost-tier-segment-worker");
    const light = screen.getByTestId("cost-tier-segment-light");
    // Width is encoded as a percentage on the inline style.
    expect(thinker.getAttribute("style")).toContain("60%");
    expect(worker.getAttribute("style")).toContain("30%");
    expect(light.getAttribute("style")).toContain("10%");
  });
});

describe("Cost route — selectors", () => {
  it("period selector re-fetches with ?period=", async () => {
    const { fn, calls } = makeFetch(() => EMPTY_BUDGET);
    render(<Cost fetchImpl={fn} />);
    await waitFor(() => {
      expect(calls.some((c) => c.get("period") === "month")).toBe(true);
    });
    const weekBtn = screen.getByTestId("cost-period-week");
    fireEvent.click(weekBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.get("period") === "week")).toBe(true);
    });
  });

  it("groupBy selector changes the bottom-table grouping", async () => {
    const { fn, calls } = makeFetch((search) => {
      const groupBy = search.get("groupBy") ?? "domain";
      if (groupBy === "agent") {
        return {
          ...EMPTY_BUDGET,
          totalUsd: 12,
          byBucket: [
            { key: "compiler", totalUsd: 9, tokensIn: 500, tokensOut: 200, runs: 4 },
            { key: "classifier", totalUsd: 3, tokensIn: 200, tokensOut: 80, runs: 6 },
          ],
        };
      }
      return {
        ...EMPTY_BUDGET,
        totalUsd: 12,
        byBucket: [
          { key: "wiki-pilot", totalUsd: 12, tokensIn: 700, tokensOut: 280, runs: 10 },
        ],
        budgetState: [
          {
            domainSlug: "wiki-pilot",
            capUsd: 50,
            usedUsd: 12,
            projectedEomUsd: 24,
            paused: false,
          },
        ],
      };
    });
    render(<Cost fetchImpl={fn} />);
    // Default groupBy=domain → bottom table shows wiki-pilot.
    await waitFor(() => {
      expect(
        within(screen.getByTestId("cost-bucket-table")).getByText("wiki-pilot"),
      ).toBeInTheDocument();
    });
    const agentBtn = screen.getByTestId("cost-groupBy-agent");
    fireEvent.click(agentBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.get("groupBy") === "agent")).toBe(true);
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("cost-bucket-table")).getByText("compiler"),
      ).toBeInTheDocument();
    });
  });
});

describe("Cost route — locale-aware number formatting (PR-W9)", () => {
  // Each test in this block swaps the active i18n locale; reset
  // afterwards so unrelated tests still resolve under `en`.
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("renders USD totals with en-US separators under en", async () => {
    const { fn } = makeFetch(() => ({
      ...EMPTY_BUDGET,
      totalUsd: 12345.67,
      byBucket: [
        { key: "wiki-pilot", totalUsd: 12345.67, tokensIn: 76543, tokensOut: 321, runs: 4 },
      ],
      budgetState: [],
    }));
    render(<Cost fetchImpl={fn} />);
    await waitFor(() => {
      expect(screen.getByTestId("cost-total")).toHaveTextContent("$12,345.67");
    });
    // The bucket table renders both the USD total and the
    // token count under the en locale's `1,234` grouping.
    const table = screen.getByTestId("cost-bucket-table");
    expect(within(table).getByText("$12,345.67")).toBeInTheDocument();
    expect(within(table).getByText("76,543")).toBeInTheDocument();
  });

  it("renders USD totals with pl-PL separators under pl", async () => {
    await i18n.changeLanguage("pl");
    const { fn } = makeFetch(() => ({
      ...EMPTY_BUDGET,
      totalUsd: 12345.67,
      byBucket: [
        { key: "wiki-pilot", totalUsd: 12345.67, tokensIn: 76543, tokensOut: 321, runs: 4 },
      ],
      budgetState: [],
    }));
    render(<Cost fetchImpl={fn} />);
    // Currency stays USD per the formatUsd contract; only the
    // separator / grouping conventions switch to pl-PL (NBSP for
    // thousands, comma for decimals). The en-US comma-grouping
    // must NOT show up in the rendered total.
    await waitFor(() => {
      const total = screen.getByTestId("cost-total").textContent ?? "";
      expect(total).toMatch(/^\$12[\s ]345,67$/);
      expect(total).not.toContain("12,345.67");
    });
    const table = screen.getByTestId("cost-bucket-table");
    // Token count likewise follows the pl-PL grouping convention.
    expect(within(table).queryByText("76,543")).not.toBeInTheDocument();
    expect(within(table).getByText(/^76[\s ]543$/)).toBeInTheDocument();
  });
});
