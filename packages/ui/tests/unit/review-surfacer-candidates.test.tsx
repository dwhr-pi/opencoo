/**
 * Review Dashboard — SurfacerCandidates sub-view (PR-C).
 *
 * Consumes `GET /api/admin/automation-candidates` (existing endpoint).
 * Approve/reject action flips `status: 'proposed' → 'approved'/'rejected'`
 * via `POST /api/admin/automation-candidates/:id/decision`.
 *
 * Pin matrix:
 *   1. Renders candidate rows from the API response.
 *   2. Shows proposal content (truncated) + source page refs.
 *   3. Approve button fires POST with `{decision: 'approve'}`.
 *   4. Reject button fires POST with `{decision: 'reject'}`.
 *   5. A 409 (illegal transition) shows an inline conflict notice.
 *   6. Empty state when no proposed candidates exist.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { SurfacerCandidates } from "../../src/routes/Review/SurfacerCandidates.js";

function makeCandidate(overrides: Partial<{
  id: string;
  surfacerRunId: string;
  sourcePageRefs: unknown;
  proposal: unknown;
  status: string;
  rationale: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}> = {}) {
  return {
    id: overrides.id ?? "cccc0000-0000-0000-0000-000000000001",
    surfacerRunId: overrides.surfacerRunId ?? "dddd0000-0000-0000-0000-000000000001",
    sourcePageRefs: overrides.sourcePageRefs ?? ["wiki-exec/ops/planning.md"],
    proposal: overrides.proposal ?? { title: "Automate weekly status report", description: "Build a workflow to compile status." },
    status: overrides.status ?? "proposed",
    rationale: overrides.rationale ?? null,
    reviewedBy: overrides.reviewedBy ?? null,
    reviewedAt: overrides.reviewedAt ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

function makeFetch(
  candidates: ReturnType<typeof makeCandidate>[],
  decisionStatus = 200,
): typeof fetch {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/admin/automation-candidates") && method === "GET") {
      return new Response(
        JSON.stringify({ rows: candidates }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/decision") && method === "POST") {
      if (decisionStatus === 409) {
        return new Response(
          JSON.stringify({ error: "illegal_transition", current_status: "approved" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      const body = JSON.parse(init?.body as string ?? "{}") as { decision: string };
      const newStatus = body.decision === "approve" ? "approved" : "rejected";
      return new Response(
        JSON.stringify({ ok: true, status: newStatus }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("SurfacerCandidates — renders candidate rows", () => {
  it("renders a row per candidate with proposal title", async () => {
    const candidates = [
      makeCandidate({ proposal: { title: "Automate weekly report", description: "Build workflow." }, id: "cccc0000-0000-0000-0000-000000000001" }),
      makeCandidate({ proposal: { title: "Another automation", description: "Build another." }, id: "cccc0000-0000-0000-0000-000000000002" }),
    ];
    const fetchImpl = makeFetch(candidates);
    render(<SurfacerCandidates fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/Automate weekly report/));
    expect(screen.getByText(/Automate weekly report/)).toBeInTheDocument();
    expect(screen.getByText(/Another automation/)).toBeInTheDocument();
  });

  it("renders approve and reject buttons for each candidate", async () => {
    const candidates = [makeCandidate()];
    const fetchImpl = makeFetch(candidates);
    render(<SurfacerCandidates fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByRole("button", { name: /approve/i }));
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });
});

describe("SurfacerCandidates — approve action", () => {
  it("fires POST with decision=approve when approve button is clicked", async () => {
    const candidates = [makeCandidate()];
    const postBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/decision") && method === "POST") {
        postBodies.push(JSON.parse(init?.body as string ?? "{}"));
        return new Response(JSON.stringify({ ok: true, status: "approved" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/admin/automation-candidates") && method === "GET") {
        return new Response(JSON.stringify({ rows: candidates }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    render(<SurfacerCandidates fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByRole("button", { name: /approve/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    await waitFor(() => postBodies.length > 0);
    expect((postBodies[0] as { decision?: string }).decision).toBe("approve");
  });

  it("fires POST with decision=reject when reject button is clicked", async () => {
    const candidates = [makeCandidate()];
    const postBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/decision") && method === "POST") {
        postBodies.push(JSON.parse(init?.body as string ?? "{}"));
        return new Response(JSON.stringify({ ok: true, status: "rejected" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/admin/automation-candidates") && method === "GET") {
        return new Response(JSON.stringify({ rows: candidates }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    render(<SurfacerCandidates fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByRole("button", { name: /reject/i }));
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    await waitFor(() => postBodies.length > 0);
    expect((postBodies[0] as { decision?: string }).decision).toBe("reject");
  });
});

describe("SurfacerCandidates — conflict handling", () => {
  it("shows an inline conflict notice on 409 illegal_transition", async () => {
    const candidates = [makeCandidate()];
    const fetchImpl = makeFetch(candidates, 409);
    render(<SurfacerCandidates fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByRole("button", { name: /approve/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(
      await screen.findByText(/conflict|already|transition/i),
    ).toBeInTheDocument();
  });
});

describe("SurfacerCandidates — empty state", () => {
  it("renders an empty state when no proposed candidates exist", async () => {
    const fetchImpl = makeFetch([]);
    render(<SurfacerCandidates fetchImpl={fetchImpl} />);

    expect(await screen.findByText(/no proposed candidates|empty|nothing/i)).toBeInTheDocument();
  });
});
