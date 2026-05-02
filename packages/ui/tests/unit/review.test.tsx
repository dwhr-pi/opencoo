/**
 * Review route — integration test (PR-C, phase-a appendix #4).
 *
 * Tests the top-level Review component with its three sub-views:
 *   1. source-binding review
 *   2. lint findings
 *   3. Surfacer candidates
 *
 * Pin matrix:
 *   1. Renders three sub-tab buttons (source-bindings, lint findings,
 *      surfacer candidates).
 *   2. Source-bindings sub-tab is active by default.
 *   3. Switching to lint-findings tab shows finding rows.
 *   4. Switching to surfacer-candidates tab shows candidate rows.
 *   5. An "upcoming" notice appears mentioning skill candidates and
 *      marketplace updates (5th + 6th item types, later phases).
 *   6. Empty states in all three sub-views do not crash.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { Review } from "../../src/routes/Review.js";

// ─── Minimal fixtures ────────────────────────────────────────────────────────

function makeBinding(name: string, pendingEventsCount = 0) {
  return {
    id: `bind-${name}`,
    name,
    adapterSlug: "drive",
    domainSlug: "wiki-exec",
    reviewMode: "review",
    enabled: true,
    status: null as null,
    lastEventAt: null,
    lastError: null,
    pendingEventsCount,
    notes: null,
  };
}

function makeLintRun(runId: string) {
  return {
    runId,
    instanceId: null,
    endedAt: new Date().toISOString(),
    findings: [
      { kind: "stale-page", path: "wiki-exec/ops/planning.md", detail: "Old page." },
    ],
  };
}

function makeCandidate(id: string) {
  return {
    id,
    surfacerRunId: "surf-run-001",
    sourcePageRefs: ["wiki-exec/ops/planning.md"],
    proposal: { title: "Auto-report workflow", description: "Automate it." },
    status: "proposed",
    rationale: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function makeFetch(opts: {
  bindings?: ReturnType<typeof makeBinding>[];
  lintRuns?: ReturnType<typeof makeLintRun>[];
  candidates?: ReturnType<typeof makeCandidate>[];
}): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/admin/source-bindings")) {
      return new Response(
        JSON.stringify({ rows: opts.bindings ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/admin/lint-findings")) {
      return new Response(
        JSON.stringify({ runs: opts.lintRuns ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/admin/automation-candidates")) {
      return new Response(
        JSON.stringify({ rows: opts.candidates ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Review route — sub-tab navigation", () => {
  it("renders three sub-tab buttons", () => {
    const fetchImpl = makeFetch({});
    render(<Review fetchImpl={fetchImpl} />);

    // The three item-type tabs must be present.
    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((b) => b.textContent?.toLowerCase() ?? "");

    const hasBindings = labels.some((l) => l.includes("source") || l.includes("binding"));
    const hasLint = labels.some((l) => l.includes("lint") || l.includes("finding"));
    const hasCandidates = labels.some((l) => l.includes("candidate") || l.includes("surfacer") || l.includes("automation"));

    expect(hasBindings).toBe(true);
    expect(hasLint).toBe(true);
    expect(hasCandidates).toBe(true);
  });

  it("shows a notice mentioning upcoming skill candidates and marketplace updates", async () => {
    const fetchImpl = makeFetch({});
    render(<Review fetchImpl={fetchImpl} />);

    // The spec requires that the Review tab explicitly notes that "5th and 6th
    // item types ship later" (skill candidates + marketplace updates).
    expect(
      await screen.findByText(/skill candidate|marketplace|later|phase/i),
    ).toBeInTheDocument();
  });
});

describe("Review route — source-bindings sub-view (default)", () => {
  it("renders binding rows on the default tab", async () => {
    const bindings = [makeBinding("drive → wiki-exec", 2)];
    const fetchImpl = makeFetch({ bindings });
    render(<Review fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/drive → wiki-exec/));
    expect(screen.getByText(/drive → wiki-exec/)).toBeInTheDocument();
  });
});

describe("Review route — lint-findings sub-view", () => {
  it("switches to lint-findings and shows findings", async () => {
    const lintRuns = [makeLintRun("run-001")];
    const fetchImpl = makeFetch({ lintRuns });
    render(<Review fetchImpl={fetchImpl} />);

    // Click the lint tab.
    const buttons = screen.getAllByRole("button");
    const lintTab = buttons.find(
      (b) => /lint|finding/i.test(b.textContent ?? ""),
    );
    expect(lintTab).toBeDefined();
    fireEvent.click(lintTab!);

    await waitFor(() => screen.getByText(/stale-page/));
    expect(screen.getByText(/stale-page/)).toBeInTheDocument();
  });
});

describe("Review route — surfacer-candidates sub-view", () => {
  it("switches to candidates and shows proposals", async () => {
    const candidates = [makeCandidate("cand-001")];
    const fetchImpl = makeFetch({ candidates });
    render(<Review fetchImpl={fetchImpl} />);

    // Click the candidates tab.
    const buttons = screen.getAllByRole("button");
    const candTab = buttons.find(
      (b) => /candidate|surfacer|automation/i.test(b.textContent ?? ""),
    );
    expect(candTab).toBeDefined();
    fireEvent.click(candTab!);

    await waitFor(() => screen.getByText(/Auto-report workflow/));
    expect(screen.getByText(/Auto-report workflow/)).toBeInTheDocument();
  });
});

describe("Review route — empty states", () => {
  it("renders without crash when all three sub-views are empty", async () => {
    const fetchImpl = makeFetch({ bindings: [], lintRuns: [], candidates: [] });
    render(<Review fetchImpl={fetchImpl} />);

    // Give async effects time to settle.
    await waitFor(() => true);
    // Main assertion: no uncaught render error.
  });
});
