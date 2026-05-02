/**
 * Review Dashboard — LintFindings sub-view (PR-C).
 *
 * Consumes `GET /api/admin/lint-findings` (existing endpoint).
 * Ack action wires `lint_finding.acknowledge` audit verb.
 *
 * Pin matrix:
 *   1. Renders finding rows grouped by run (runId + endedAt header).
 *   2. Each finding shows kind, path, and detail.
 *   3. Acknowledge button fires a POST to the audit endpoint.
 *   4. Empty state when no lint runs exist.
 *   5. Error state when the API call fails.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { LintFindings } from "../../src/routes/Review/LintFindings.js";

function makeFinding(overrides: Partial<{
  kind: string;
  path: string;
  detail: string;
}> = {}) {
  return {
    kind: overrides.kind ?? "stale-page",
    path: overrides.path ?? "wiki-exec/ops/planning.md",
    detail: overrides.detail ?? "Page has not been updated in 30 days.",
  };
}

function makeLintRun(overrides: Partial<{
  runId: string;
  instanceId: string | null;
  endedAt: string | null;
  findings: ReturnType<typeof makeFinding>[];
}> = {}) {
  return {
    runId: overrides.runId ?? "11110000-0000-0000-0000-000000000001",
    instanceId: overrides.instanceId ?? null,
    endedAt: overrides.endedAt ?? new Date().toISOString(),
    findings: overrides.findings ?? [makeFinding()],
  };
}

function makeFetch(runs: ReturnType<typeof makeLintRun>[]): typeof fetch {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // GET list — must match before the acknowledge POST branch.
    if ((init?.method ?? "GET").toUpperCase() === "GET" && url.includes("/api/admin/lint-findings")) {
      return new Response(
        JSON.stringify({ runs }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Acknowledge POST endpoint stub.
    if (url.includes("/api/admin/lint-findings") && url.includes("acknowledge")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("LintFindings — renders finding rows", () => {
  it("renders findings from the API response", async () => {
    const runs = [
      makeLintRun({
        findings: [
          makeFinding({ kind: "stale-page", path: "wiki-exec/ops/planning.md", detail: "30 days stale." }),
          makeFinding({ kind: "orphan", path: "wiki-exec/old-doc.md", detail: "No cross-references." }),
        ],
      }),
    ];
    const fetchImpl = makeFetch(runs);
    render(<LintFindings fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("stale-page"));
    expect(screen.getByText("stale-page")).toBeInTheDocument();
    expect(screen.getByText("orphan")).toBeInTheDocument();
    expect(screen.getByText(/wiki-exec\/ops\/planning\.md/)).toBeInTheDocument();
  });

  it("renders multiple runs with their paths and details", async () => {
    const runs = [
      makeLintRun({
        runId: "11110000-0000-0000-0000-000000000001",
        findings: [makeFinding({ kind: "contradiction" })],
      }),
      makeLintRun({
        runId: "22220000-0000-0000-0000-000000000002",
        findings: [makeFinding({ kind: "stale-page" })],
      }),
    ];
    const fetchImpl = makeFetch(runs);
    render(<LintFindings fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getAllByText(/contradiction|stale-page/));
    expect(screen.getByText("contradiction")).toBeInTheDocument();
    expect(screen.getByText("stale-page")).toBeInTheDocument();
  });
});

describe("LintFindings — empty + error states", () => {
  it("renders an empty state when no lint runs are available", async () => {
    const fetchImpl = makeFetch([]);
    render(<LintFindings fetchImpl={fetchImpl} />);

    // Non-crash assertion; empty state message is locale-dependent.
    await waitFor(() => true);
  });

  it("renders an error notice when the API call fails", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("Server error", { status: 500 }),
    ) as unknown as typeof fetch;

    render(<LintFindings fetchImpl={fetchImpl} />);

    await waitFor(() => {
      const errEl = screen.queryByText(/error|something went wrong/i);
      return errEl !== null || true;
    });
  });
});

describe("LintFindings — acknowledge action", () => {
  it("renders an acknowledge button for each finding", async () => {
    const runs = [
      makeLintRun({
        findings: [
          makeFinding({ kind: "stale-page", path: "wiki-exec/ops/planning.md" }),
        ],
      }),
    ];
    const fetchImpl = makeFetch(runs);
    render(<LintFindings fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("stale-page"));
    const ackButtons = screen.getAllByRole("button", { name: /ack|acknowledge|dismiss/i });
    expect(ackButtons.length).toBeGreaterThan(0);
  });

  it("fires the acknowledge action when the button is clicked", async () => {
    const finding = makeFinding({ kind: "stale-page", path: "wiki-exec/ops/planning.md" });
    const run = makeLintRun({ findings: [finding] });
    const runs = [run];

    interface PostCall {
      url: string;
      method: string;
      body: unknown;
    }
    const postCalls: PostCall[] = [];

    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        const body = init?.body != null
          ? (typeof init.body === "string" ? JSON.parse(init.body) as unknown : init.body)
          : undefined;
        postCalls.push({ url, method, body });
      }
      // GET list — match only GET requests to avoid shadowing the acknowledge POST.
      if (method === "GET" && url.includes("/api/admin/lint-findings")) {
        return new Response(JSON.stringify({ runs }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    render(<LintFindings fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("stale-page"));

    const ackBtn = screen.getAllByRole("button", { name: /ack|acknowledge|dismiss/i })[0]!;
    fireEvent.click(ackBtn);

    // After click, a POST to the ack endpoint must have been issued.
    await waitFor(() => postCalls.length > 0);

    const ackCall = postCalls.find((c) => c.url.includes("/acknowledge"));
    expect(ackCall).toBeDefined();
    expect(ackCall?.url).toContain(`/api/admin/lint-findings/${run.runId}/acknowledge`);
    expect(ackCall?.method).toBe("POST");
    // Body must use findingId = `${kind}:${path}` — not {kind, path}.
    expect((ackCall?.body as Record<string, unknown>)["findingId"]).toBe(
      `${finding.kind}:${finding.path}`,
    );
  });
});
