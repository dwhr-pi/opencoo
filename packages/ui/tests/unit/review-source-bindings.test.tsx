/**
 * Review Dashboard — SourceBindingsReview sub-view (PR-C).
 *
 * Consumes `GET /api/admin/source-bindings` with the new
 * `pendingEventsCount` field added in PR-C.
 *
 * Pin matrix:
 *   1. Renders a row per binding with name, status pill, and pending count.
 *   2. Bindings with pendingEventsCount > 0 show the count prominently.
 *   3. Approve action fires a PUT/POST to the existing audited endpoint
 *      (with CSRF token from cookie).
 *   4. A sovereignty-diff confirmation is shown if the binding's review
 *      action would affect LLM policy scope (different domain provider).
 *   5. Empty state when no bindings need attention.
 *   6. Error state when the API call fails.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { SourceBindingsReview } from "../../src/routes/Review/SourceBindingsReview.js";

function makeBinding(overrides: Partial<{
  id: string;
  name: string;
  adapterSlug: string;
  domainSlug: string;
  reviewMode: string;
  enabled: boolean;
  status: "healthy" | "advisory" | "alert" | null;
  lastEventAt: string | null;
  lastError: string | null;
  pendingEventsCount: number;
  notes: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "aaaa0000-0000-0000-0000-000000000001",
    name: overrides.name ?? "drive → wiki-exec",
    adapterSlug: overrides.adapterSlug ?? "drive",
    domainSlug: overrides.domainSlug ?? "wiki-exec",
    reviewMode: overrides.reviewMode ?? "review",
    enabled: overrides.enabled ?? true,
    status: overrides.status ?? null,
    lastEventAt: overrides.lastEventAt ?? null,
    lastError: overrides.lastError ?? null,
    pendingEventsCount: overrides.pendingEventsCount ?? 0,
    notes: overrides.notes ?? null,
  };
}

function makeFetch(bindings: ReturnType<typeof makeBinding>[]): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/admin/source-bindings")) {
      return new Response(
        JSON.stringify({ rows: bindings }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("SourceBindingsReview — renders binding rows", () => {
  it("renders a row per binding with its name", async () => {
    const bindings = [
      makeBinding({ name: "drive → wiki-exec", pendingEventsCount: 3 }),
      makeBinding({ id: "bbbb0000-0000-0000-0000-000000000002", name: "asana → wiki-ops", pendingEventsCount: 0 }),
    ];
    const fetchImpl = makeFetch(bindings);
    render(<SourceBindingsReview fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("drive → wiki-exec"));
    expect(screen.getByText("drive → wiki-exec")).toBeInTheDocument();
    expect(screen.getByText("asana → wiki-ops")).toBeInTheDocument();
  });

  it("shows pendingEventsCount > 0 prominently", async () => {
    const bindings = [
      makeBinding({ name: "drive → wiki-exec", pendingEventsCount: 5 }),
    ];
    const fetchImpl = makeFetch(bindings);
    render(<SourceBindingsReview fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("drive → wiki-exec"));
    // The count "5" should be visible somewhere in the row.
    expect(screen.getByText(/5/)).toBeInTheDocument();
  });

  it("renders a status pill for bindings with a non-null status", async () => {
    const bindings = [
      makeBinding({ status: "alert", name: "fireflies → wiki-exec" }),
    ];
    const fetchImpl = makeFetch(bindings);
    render(<SourceBindingsReview fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("fireflies → wiki-exec"));
    // StatusPill renders the status text.
    expect(screen.getByText(/alert/i)).toBeInTheDocument();
  });
});

describe("SourceBindingsReview — empty + error states", () => {
  it("renders an empty state when no bindings exist", async () => {
    const fetchImpl = makeFetch([]);
    render(<SourceBindingsReview fetchImpl={fetchImpl} />);

    expect(await screen.findByText(/no bindings need review|empty|nothing to review/i)).toBeInTheDocument();
  });

  it("renders an error state when the API call fails", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("Server error", { status: 500 }),
    ) as unknown as typeof fetch;

    render(<SourceBindingsReview fetchImpl={fetchImpl} />);

    expect(await screen.findByText(/error|something went wrong/i)).toBeInTheDocument();
  });
});

describe("SourceBindingsReview — sovereignty-diff confirmation", () => {
  it("shows a confirmation prompt when a review action could affect LLM policy", async () => {
    // A binding in 'review' mode with a pending count signals that the operator
    // may need to confirm the LLM policy scope before approving. The component
    // must surface a confirmation step when the binding has a review_mode that
    // would change effective LLM routing.
    const binding = makeBinding({ reviewMode: "review", pendingEventsCount: 2, name: "drive → wiki-hr" });
    const bindings = [binding];

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
      if (url.includes("/api/admin/source-bindings")) {
        return new Response(
          JSON.stringify({ rows: bindings }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    render(<SourceBindingsReview fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("drive → wiki-hr"));

    // Find and click the approve action for this binding.
    const approveButtons = screen.getAllByRole("button", { name: /approve|enable|auto/i });
    expect(approveButtons.length).toBeGreaterThan(0);

    // Clicking approve on a 'review' mode binding surfaces the sovereignty
    // confirmation dialog before committing.
    fireEvent.click(approveButtons[0]!);

    // Clicking approve on a 'review' mode binding must surface the
    // sovereignty-diff dialog before committing.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // The dialog must mention sovereignty / LLM policy in its title text.
    const { within } = await import("@testing-library/react");
    expect(within(dialog).getByText(/sovereignty|llm policy/i)).toBeInTheDocument();

    // Click the confirm button inside the dialog to fire the POST.
    const confirmBtn = within(dialog).getByRole("button", { name: /confirm|approve|yes/i });
    fireEvent.click(confirmBtn);

    // After confirming, a POST to the review-mode endpoint must have been issued
    // with camelCase reviewMode body (not snake_case review_mode).
    await waitFor(() => postCalls.length > 0);

    const approveCall = postCalls.find((c) => c.url.includes("/review-mode"));
    expect(approveCall).toBeDefined();
    expect(approveCall?.url).toContain(`/api/admin/source-bindings/${binding.id}/review-mode`);
    expect(approveCall?.method).toBe("POST");
    // Body must use camelCase reviewMode — not snake_case review_mode.
    expect((approveCall?.body as Record<string, unknown>)["reviewMode"]).toBe("auto");
    expect((approveCall?.body as Record<string, unknown>)["review_mode"]).toBeUndefined();
  });
});
