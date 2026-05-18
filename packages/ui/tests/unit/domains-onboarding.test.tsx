/**
 * Domains route × OnboardingWizard host shell — PR-B6, wave-16.
 *
 * Pins:
 *   - Empty domains + no dismissal flag → wizard renders.
 *   - Empty domains + dismissal flag → original EmptyStatePanel
 *     renders (B3's behavior preserved verbatim).
 *   - Non-empty domains → neither wizard nor EmptyStatePanel
 *     renders.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { Domains } from "../../src/routes/Domains.js";

function fetchWithDomains(rows: ReadonlyArray<unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/domains")) {
      return new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.startsWith("/api/admin/source-bindings") ||
      url.startsWith("/api/admin/agent-instances")
    ) {
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("/api/admin/heartbeat/preconditions")) {
      return new Response(
        JSON.stringify({
          heartbeatInstanceCount: 0,
          enabledHeartbeatInstanceCount: 0,
          instancesWithoutOutputChannels: 0,
          mostRecentRun: null,
          mostRecentDispatchedAt: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("Domains × OnboardingWizard (PR-B6)", () => {
  beforeEach(() => {
    localStorage.removeItem("opencoo_onboarding_dismissed");
  });

  it("renders the OnboardingWizard when domains list is empty and not dismissed", async () => {
    const fetchImpl = fetchWithDomains([]);
    render(<Domains fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const wizard = await screen.findByTestId("onboarding-wizard");
    expect(wizard).toBeInTheDocument();
    // EmptyStatePanel is not rendered alongside the wizard.
    expect(document.querySelector("[data-empty-state-panel]")).toBeNull();
  });

  it("renders the original EmptyStatePanel when the wizard is dismissed", async () => {
    localStorage.setItem("opencoo_onboarding_dismissed", "1");
    const fetchImpl = fetchWithDomains([]);
    render(<Domains fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(await screen.findByText(/no domains yet/i)).toBeInTheDocument();
    const panel = document.querySelector("[data-empty-state-panel]");
    expect(panel).not.toBeNull();
    expect(screen.queryByTestId("onboarding-wizard")).toBeNull();
  });

  it("renders neither the wizard nor the empty-state panel when domains exist", async () => {
    const fetchImpl = fetchWithDomains([
      {
        id: "d-1",
        slug: "wiki-executive",
        name: "Executive",
        class: "knowledge",
        locale: "en",
        isAggregator: false,
        disabledAt: null,
      },
    ]);
    render(<Domains fetchImpl={fetchImpl} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText("wiki-executive")).toBeInTheDocument(),
    );
    expect(document.querySelector("[data-empty-state-panel]")).toBeNull();
    expect(screen.queryByTestId("onboarding-wizard")).toBeNull();
  });
});
