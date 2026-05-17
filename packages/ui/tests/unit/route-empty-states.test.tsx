/**
 * Per-route empty-state coverage — PR-B3, wave-16.
 *
 * Asserts each of the seven covered routes renders the
 * EmptyStatePanel (title + body + optional CTA) when the
 * list endpoint returns zero rows.
 *
 * Covered routes:
 *   - Domains   — CTA "+ New domain" opens NewDomainModal
 *   - Sources   — CTA "+ New source binding" opens NewSourceBindingModal
 *   - Agents    — CTA "+ New agent instance" opens NewAgentInstanceModal
 *   - Outputs   — CTA "+ New output channel" opens NewOutputChannelModal
 *   - Activity  — no CTA, prose only
 *   - Review    — no CTA, prose only (default sub-tab)
 *   - Audit     — no CTA, prose only
 *
 * (Reports is regressed in `reports.test.tsx` separately —
 * its empty state is the chain-shaped W8 panel.)
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToastProvider, ToastRegion } from "../../src/components/Toast.js";
import { Activity } from "../../src/routes/Activity.js";
import { Agents } from "../../src/routes/Agents.js";
import { Audit } from "../../src/routes/Audit.js";
import { Domains } from "../../src/routes/Domains.js";
import { Outputs } from "../../src/routes/Outputs.js";
import { Review } from "../../src/routes/Review.js";
import { Sources } from "../../src/routes/Sources.js";

/** Outputs (PR-B7, wave-16) calls `useToast` so it must mount inside
 *  a `<ToastProvider>`. The other routes don't need it today but the
 *  wrapper is cheap and harmless — use it for every render so a
 *  future adoption doesn't silently break this suite. */
function renderRoute(node: JSX.Element): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      {node}
      <ToastRegion />
    </ToastProvider>,
  );
}

function emptyFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    // All known list endpoints return `{rows: []}`; pipelines uses
    // `{pipelines: []}`; the adapter descriptor + scheduler endpoints
    // are unused by the empty branches we're exercising.
    if (
      url.includes("/api/admin/domains") ||
      url.includes("/api/admin/source-bindings") ||
      url.includes("/api/admin/agent-instances") ||
      url.includes("/api/admin/output-channels") ||
      url.includes("/api/admin/audit-log") ||
      url.includes("/api/admin/lint") ||
      url.includes("/api/admin/automation-candidates")
    ) {
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("Route empty-state — Domains", () => {
  it("renders the EmptyStatePanel with title + CTA when no domains exist", async () => {
    const fetchImpl = emptyFetch();
    renderRoute(<Domains fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(await screen.findByText(/no domains yet/i)).toBeInTheDocument();
    // The CTA in the empty state — there are two "+ New domain" buttons
    // on the page (header + empty state); both lead to the same modal.
    const buttons = await screen.findAllByRole("button", {
      name: /new domain/i,
    });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });

  it("clicking the empty-state CTA opens the NewDomainModal", async () => {
    const fetchImpl = emptyFetch();
    const user = userEvent.setup();
    renderRoute(<Domains fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await screen.findByText(/no domains yet/i);
    // Find the CTA inside the empty-state panel specifically.
    const panel = document.querySelector("[data-empty-state-panel]");
    expect(panel).not.toBeNull();
    const cta = panel?.querySelector("button") as HTMLButtonElement;
    expect(cta).not.toBeNull();
    expect(cta.textContent).toMatch(/new domain/i);
    await user.click(cta);
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toBeInTheDocument(),
    );
  });
});

describe("Route empty-state — Sources", () => {
  it("renders the EmptyStatePanel with title + CTA when no bindings exist", async () => {
    const fetchImpl = emptyFetch();
    renderRoute(<Sources fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(
      await screen.findByText(/no source bindings yet/i),
    ).toBeInTheDocument();
    const buttons = await screen.findAllByRole("button", {
      name: /new source binding/i,
    });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Route empty-state — Agents", () => {
  it("renders the EmptyStatePanel with title + CTA when no instances exist", async () => {
    const fetchImpl = emptyFetch();
    renderRoute(<Agents fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(
      await screen.findByText(/no agent instances yet/i),
    ).toBeInTheDocument();
    const buttons = await screen.findAllByRole("button", {
      name: /new agent instance/i,
    });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Route empty-state — Outputs", () => {
  it("renders the EmptyStatePanel with title + CTA when no channels exist", async () => {
    const fetchImpl = emptyFetch();
    renderRoute(<Outputs fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(
      await screen.findByText(/no output channels yet/i),
    ).toBeInTheDocument();
    const buttons = await screen.findAllByRole("button", {
      name: /new output channel/i,
    });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Route empty-state — Review", () => {
  it("renders the EmptyStatePanel on the default sub-tab when no review items", async () => {
    const fetchImpl = emptyFetch();
    renderRoute(<Review fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(
      await screen.findByText(/no review items pending/i),
    ).toBeInTheDocument();
  });
});

describe("Route empty-state — Audit", () => {
  it("renders the EmptyStatePanel when the audit log is empty", async () => {
    const fetchImpl = emptyFetch();
    renderRoute(<Audit fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(
      await screen.findByText(/no audit entries yet/i),
    ).toBeInTheDocument();
  });
});

describe("Route empty-state — Activity", () => {
  it("renders the EmptyStatePanel on the feed when no events have streamed", async () => {
    const fetchImpl = emptyFetch();
    renderRoute(<Activity fetchImpl={fetchImpl} />);
    // Feed is the default sub-tab; SSE is stubbed (no connection
    // → entries stay empty), so the panel surfaces immediately.
    expect(
      await screen.findByText(/no activity yet/i),
    ).toBeInTheDocument();
  });
});
