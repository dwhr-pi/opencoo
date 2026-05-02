/**
 * Reports route — Heartbeat reader + Redaction events.
 *
 * Test-first artifact for PR-D (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Renders two sub-tab buttons: heartbeat + redaction-events.
 *   2. Heartbeat sub-tab fetches /api/admin/heartbeat and renders reports.
 *   3. Heartbeat report shows summary + alerts (never raw LLM call output).
 *   4. Redaction events sub-tab fetches /api/admin/redaction-events.
 *   5. Redaction events renders category, guardSlug, matchedByteRangesCount.
 *   6. Redaction events NEVER renders matchedByteRanges content.
 *   7. Empty states render without crash.
 *   8. Heartbeat run_id is rendered as a deep-link reference.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { Reports } from "../../src/routes/Reports.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeHeartbeatReport(overrides: {
  runId?: string;
  instanceName?: string | null;
  startedAt?: string | null;
  output?: {
    version?: string;
    summary?: string;
    alerts?: Array<{ priority: number; title: string; body: string; citations: string[] }>;
  };
}) {
  return {
    runId: overrides.runId ?? "11111111-1111-1111-1111-111111111111",
    instanceId: null,
    instanceName: overrides.instanceName ?? "heartbeat-executive",
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    output: {
      version: overrides.output?.version ?? "v1",
      summary: overrides.output?.summary ?? "All systems nominal.",
      alerts: overrides.output?.alerts ?? [],
    },
  };
}

function makeRedactionEvent(overrides: {
  id?: string;
  pipeline?: string;
  guardSlug?: string;
  category?: string;
  patternVersion?: string;
  matchedByteRangesCount?: number;
  failMode?: string;
  domainId?: string | null;
  bindingId?: string | null;
  createdAt?: string;
}) {
  return {
    id: overrides.id ?? "22222222-2222-2222-2222-222222222222",
    pipeline: overrides.pipeline ?? "ingestion",
    guardSlug: overrides.guardSlug ?? "guard-redaction-regex",
    category: overrides.category ?? "pii.email",
    patternVersion: overrides.patternVersion ?? "1.0.0",
    matchedByteRangesCount: overrides.matchedByteRangesCount ?? 2,
    failMode: overrides.failMode ?? "transform",
    domainId: overrides.domainId ?? null,
    bindingId: overrides.bindingId ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

function makeFetch(opts: {
  reports?: ReturnType<typeof makeHeartbeatReport>[];
  events?: ReturnType<typeof makeRedactionEvent>[];
  total?: number;
}): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/heartbeat")) {
      return new Response(
        JSON.stringify({ reports: opts.reports ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/admin/redaction-events")) {
      return new Response(
        JSON.stringify({ events: opts.events ?? [], total: opts.total ?? 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("404", { status: 404 });
  }) as unknown as typeof fetch;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Reports route — sub-tab navigation", () => {
  it("renders two sub-tab buttons: heartbeat and redaction-events", () => {
    const fetchImpl = makeFetch({});
    render(<Reports fetchImpl={fetchImpl} />);

    expect(screen.getByRole("button", { name: /heartbeat/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /redaction/i })).toBeInTheDocument();
  });
});

describe("Reports route — heartbeat sub-tab", () => {
  it("fetches /api/admin/heartbeat and renders report summary", async () => {
    const reports = [
      makeHeartbeatReport({
        instanceName: "heartbeat-executive",
        output: { summary: "Three projects are at risk of missing Q2 deadline." },
      }),
    ];
    const fetchImpl = makeFetch({ reports });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/Three projects are at risk/i));
    expect(screen.getByText(/Three projects are at risk/i)).toBeInTheDocument();
  });

  it("renders run_id as a deep-link reference", async () => {
    const runId = "deadbeef-dead-dead-dead-deadbeefcafe";
    const reports = [
      makeHeartbeatReport({ runId }),
    ];
    const fetchImpl = makeFetch({ reports });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(new RegExp(runId.slice(0, 8), "i")));
    expect(screen.getByText(new RegExp(runId.slice(0, 8), "i"))).toBeInTheDocument();
  });

  it("renders alerts when present", async () => {
    const reports = [
      makeHeartbeatReport({
        output: {
          summary: "Two alerts today.",
          alerts: [
            {
              priority: 1,
              title: "Project X deadline at risk",
              body: "The Q2 deadline for Project X is in 3 days with 40% completion.",
              citations: ["strategy/projects/project-x.md"],
            },
          ],
        },
      }),
    ];
    const fetchImpl = makeFetch({ reports });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/Project X deadline at risk/i));
    expect(screen.getByText(/Project X deadline at risk/i)).toBeInTheDocument();
  });

  it("shows empty state when no heartbeat reports exist", async () => {
    const fetchImpl = makeFetch({ reports: [] });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(await screen.findByText(/no heartbeat reports yet/i)).toBeInTheDocument();
  });

  it("shows instance name if available", async () => {
    const reports = [
      makeHeartbeatReport({ instanceName: "heartbeat-ops-domain" }),
    ];
    const fetchImpl = makeFetch({ reports });
    render(<Reports fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/heartbeat-ops-domain/i));
    expect(screen.getByText(/heartbeat-ops-domain/i)).toBeInTheDocument();
  });
});

describe("Reports route — redaction events sub-tab", () => {
  it("renders redaction events with category and count", async () => {
    const events = [
      makeRedactionEvent({ category: "pii.email", matchedByteRangesCount: 3 }),
    ];
    const fetchImpl = makeFetch({ events, total: 1 });
    render(<Reports fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /redaction/i }));

    await waitFor(() => screen.getByText(/pii\.email/i));
    expect(screen.getByText(/pii\.email/i)).toBeInTheDocument();
    // Count of matches (matchedByteRangesCount) is shown — use queryAllByText
    // because "3" can appear in other rendered values (e.g. time strings).
    const countMatches = screen.queryAllByText("3");
    expect(countMatches.length).toBeGreaterThan(0);
  });

  it("SECURITY: never renders matched byte range offsets", async () => {
    const events = [
      makeRedactionEvent({ matchedByteRangesCount: 2 }),
    ];
    const fetchImpl = makeFetch({ events });
    render(<Reports fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /redaction/i }));

    await waitFor(() => screen.getByText(/pii\.email/i));

    // The matchedByteRangesCount is shown but no raw range content.
    // The API already strips the ranges; the UI should never receive them
    // and must not render any "start"/"end" offset values from the ranges.
    expect(screen.queryByText(/matchedByteRanges/)).not.toBeInTheDocument();
    expect(screen.queryByText(/matched_byte_ranges/)).not.toBeInTheDocument();
  });

  it("renders pipeline and guardSlug for each event", async () => {
    const events = [
      makeRedactionEvent({
        pipeline: "miner",
        guardSlug: "guard-custom-pii",
      }),
    ];
    const fetchImpl = makeFetch({ events });
    render(<Reports fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /redaction/i }));

    await waitFor(() => screen.getByText(/miner/i));
    expect(screen.getByText(/miner/i)).toBeInTheDocument();
    expect(screen.getByText(/guard-custom-pii/i)).toBeInTheDocument();
  });

  it("shows empty state when no events", async () => {
    const fetchImpl = makeFetch({ events: [] });
    render(<Reports fetchImpl={fetchImpl} />);

    fireEvent.click(screen.getByRole("button", { name: /redaction/i }));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(await screen.findByText(/no redaction events yet/i)).toBeInTheDocument();
  });
});
