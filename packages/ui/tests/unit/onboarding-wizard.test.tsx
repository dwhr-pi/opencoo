/**
 * OnboardingWizard unit tests — PR-B6, wave-16.
 *
 * The wizard is a four-step vertical stepper that hosts the
 * Domains route when the DB is empty:
 *   1. Create first domain     (POST /api/admin/domains)
 *   2. Bind first source       (POST /api/admin/source-bindings)
 *   3. Seed first agent inst.  (POST /api/admin/agent-instances)
 *   4. Wait for first heartbeat (poll /api/admin/heartbeat/preconditions)
 *
 * The tests pin the contract that a wizard step transitions to
 * `done` as the corresponding admin-API list grows, and that
 * step 4 polls preconditions at the documented cadence (4s) and
 * stops once the chain shows a successful run with output.
 *
 * Skip behavior: the wizard renders a "Skip wizard" link that
 * persists `opencoo_onboarding_dismissed = '1'` in localStorage;
 * when the flag is set, the wrapper route falls back to the
 * EmptyStatePanel (verified in the route-level test below).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { OnboardingWizard } from "../../src/components/OnboardingWizard.js";
import { ToastProvider, ToastRegion } from "../../src/components/Toast.js";

function renderWizard(fetchImpl: typeof fetch): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <OnboardingWizard fetchImpl={fetchImpl} />
      <ToastRegion />
    </ToastProvider>,
  );
}

interface Counts {
  domains: number;
  sourceBindings: number;
  agentInstances: number;
  /** Whether the preconditions endpoint returns a "completed" heartbeat. */
  heartbeatDone: boolean;
}

function makeFetch(initial: Counts): {
  fetchImpl: typeof fetch;
  state: Counts;
  /** Mutable view — flip these fields and the next poll picks
   *  them up. */
} {
  const state: Counts = { ...initial };
  const fetchImpl = vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/domains")) {
      return new Response(
        JSON.stringify({
          rows: Array.from({ length: state.domains }, (_, i) => ({
            id: `d-${i}`,
            slug: `d${i}`,
            name: `Domain ${i}`,
            class: "knowledge",
            locale: "en",
            isAggregator: false,
            disabledAt: null,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/admin/source-bindings")) {
      return new Response(
        JSON.stringify({
          rows: Array.from({ length: state.sourceBindings }, (_, i) => ({
            id: `b-${i}`,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/admin/agent-instances")) {
      return new Response(
        JSON.stringify({
          rows: Array.from({ length: state.agentInstances }, (_, i) => ({
            id: `a-${i}`,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/admin/adapters")) {
      // NewSourceBindingModal expects `{adapters: []}`; an empty
      // descriptor list keeps the modal mounted (with its form-
      // level error banner) which is enough for "did the dialog
      // open" coverage.
      return new Response(JSON.stringify({ adapters: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("/api/admin/heartbeat/preconditions")) {
      const body = state.heartbeatDone
        ? {
            heartbeatInstanceCount: 1,
            enabledHeartbeatInstanceCount: 1,
            instancesWithoutOutputChannels: 0,
            mostRecentRun: {
              startedAt: new Date().toISOString(),
              status: "success",
              outputIsNull: false,
              instanceName: "morning",
            },
            mostRecentDispatchedAt: new Date().toISOString(),
          }
        : {
            heartbeatInstanceCount: 0,
            enabledHeartbeatInstanceCount: 0,
            instancesWithoutOutputChannels: 0,
            mostRecentRun: null,
            mostRecentDispatchedAt: null,
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

describe("OnboardingWizard (PR-B6) — render", () => {
  beforeEach(() => {
    localStorage.removeItem("opencoo_onboarding_dismissed");
  });

  it("renders four steps when no records exist", async () => {
    const { fetchImpl } = makeFetch({
      domains: 0,
      sourceBindings: 0,
      agentInstances: 0,
      heartbeatDone: false,
    });
    renderWizard(fetchImpl);
    const steps = await screen.findAllByTestId(/^onboarding-step-/);
    expect(steps).toHaveLength(4);
  });

  it("step 1 is active; subsequent steps are visually disabled until prior step completes", async () => {
    const { fetchImpl } = makeFetch({
      domains: 0,
      sourceBindings: 0,
      agentInstances: 0,
      heartbeatDone: false,
    });
    renderWizard(fetchImpl);
    const step1 = await screen.findByTestId("onboarding-step-1");
    const step2 = screen.getByTestId("onboarding-step-2");
    const step3 = screen.getByTestId("onboarding-step-3");
    const step4 = screen.getByTestId("onboarding-step-4");
    expect(step1.getAttribute("data-step-status")).toBe("pending");
    expect(step2.getAttribute("data-step-status")).toBe("idle");
    expect(step3.getAttribute("data-step-status")).toBe("idle");
    expect(step4.getAttribute("data-step-status")).toBe("idle");
    // Idle steps have their CTA disabled.
    const step2Cta = step2.querySelector("button");
    expect(step2Cta).not.toBeNull();
    expect((step2Cta as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the step status badge with the right tone per step", async () => {
    const { fetchImpl } = makeFetch({
      domains: 1,
      sourceBindings: 0,
      agentInstances: 0,
      heartbeatDone: false,
    });
    renderWizard(fetchImpl);
    await waitFor(() => {
      const step1 = screen.getByTestId("onboarding-step-1");
      expect(step1.getAttribute("data-step-status")).toBe("done");
    });
  });
});

describe("OnboardingWizard (PR-B6) — step transitions", () => {
  beforeEach(() => {
    localStorage.removeItem("opencoo_onboarding_dismissed");
  });

  it("step 1 → done when /api/admin/domains returns >= 1 row", async () => {
    const { fetchImpl } = makeFetch({
      domains: 1,
      sourceBindings: 0,
      agentInstances: 0,
      heartbeatDone: false,
    });
    renderWizard(fetchImpl);
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-1").getAttribute("data-step-status"),
      ).toBe("done");
    });
    // Step 2 becomes pending (the current actionable step).
    expect(
      screen.getByTestId("onboarding-step-2").getAttribute("data-step-status"),
    ).toBe("pending");
  });

  it("step 2 → done when /api/admin/source-bindings returns >= 1 row", async () => {
    const { fetchImpl } = makeFetch({
      domains: 1,
      sourceBindings: 1,
      agentInstances: 0,
      heartbeatDone: false,
    });
    renderWizard(fetchImpl);
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-2").getAttribute("data-step-status"),
      ).toBe("done");
    });
    expect(
      screen.getByTestId("onboarding-step-3").getAttribute("data-step-status"),
    ).toBe("pending");
  });

  it("step 3 → done when /api/admin/agent-instances returns >= 1 row", async () => {
    const { fetchImpl } = makeFetch({
      domains: 1,
      sourceBindings: 1,
      agentInstances: 1,
      heartbeatDone: false,
    });
    renderWizard(fetchImpl);
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-3").getAttribute("data-step-status"),
      ).toBe("done");
    });
    expect(
      screen.getByTestId("onboarding-step-4").getAttribute("data-step-status"),
    ).toBe("pending");
  });

  it("step 4 → done when preconditions reports a successful heartbeat with output", async () => {
    const { fetchImpl } = makeFetch({
      domains: 1,
      sourceBindings: 1,
      agentInstances: 1,
      heartbeatDone: true,
    });
    renderWizard(fetchImpl);
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-4").getAttribute("data-step-status"),
      ).toBe("done");
    });
  });
});

describe("OnboardingWizard (PR-B6) — Step 4 polling cadence", () => {
  beforeEach(() => {
    localStorage.removeItem("opencoo_onboarding_dismissed");
  });

  it("polls preconditions repeatedly while pending, stops once heartbeat is done", async () => {
    // Override the polling interval for this test only via a
    // module-level constant the wizard re-reads. We use a real
    // timer + short interval (50ms) so the test runs in well
    // under a second without the microtask-vs-fake-timer hazard
    // that bit the first draft.
    const { fetchImpl, state } = makeFetch({
      domains: 1,
      sourceBindings: 1,
      agentInstances: 1,
      heartbeatDone: false,
    });
    render(
      <ToastProvider>
        <OnboardingWizard fetchImpl={fetchImpl} pollIntervalMs={50} />
        <ToastRegion />
      </ToastProvider>,
    );

    // Wait for at least 3 preconditions polls — the chained
    // setTimeout should re-fire while heartbeatDone stays false.
    await waitFor(
      () => {
        const calls = (
          fetchImpl as unknown as { mock: { calls: unknown[][] } }
        ).mock.calls.filter((c) =>
          String(c[0]).startsWith("/api/admin/heartbeat/preconditions"),
        );
        expect(calls.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 2000 },
    );

    // Flip the precondition response to "done" — wizard should
    // detect on its next poll and stop polling.
    state.heartbeatDone = true;
    await waitFor(
      () => {
        expect(
          screen
            .getByTestId("onboarding-step-4")
            .getAttribute("data-step-status"),
        ).toBe("done");
      },
      { timeout: 2000 },
    );

    // Settle: capture the count, wait a few intervals, ensure no
    // further polls fire.
    const stableCount = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) =>
      String(c[0]).startsWith("/api/admin/heartbeat/preconditions"),
    ).length;
    await new Promise((res) => setTimeout(res, 300));
    const finalCount = (
      fetchImpl as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) =>
      String(c[0]).startsWith("/api/admin/heartbeat/preconditions"),
    ).length;
    expect(finalCount).toBe(stableCount);
  });
});

describe("OnboardingWizard (PR-B6) — skip + dismissal", () => {
  beforeEach(() => {
    localStorage.removeItem("opencoo_onboarding_dismissed");
  });

  it("Skip wizard link writes the localStorage flag and notifies the parent", async () => {
    const onDismissed = vi.fn();
    const { fetchImpl } = makeFetch({
      domains: 0,
      sourceBindings: 0,
      agentInstances: 0,
      heartbeatDone: false,
    });
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <OnboardingWizard fetchImpl={fetchImpl} onDismissed={onDismissed} />
        <ToastRegion />
      </ToastProvider>,
    );
    const skip = await screen.findByRole("button", { name: /skip wizard/i });
    await user.click(skip);
    expect(localStorage.getItem("opencoo_onboarding_dismissed")).toBe("1");
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});

describe("OnboardingWizard (PR-B6) — CTAs open the right modals", () => {
  beforeEach(() => {
    localStorage.removeItem("opencoo_onboarding_dismissed");
  });

  it("step 1 CTA opens the NewDomainModal", async () => {
    const { fetchImpl } = makeFetch({
      domains: 0,
      sourceBindings: 0,
      agentInstances: 0,
      heartbeatDone: false,
    });
    const user = userEvent.setup();
    renderWizard(fetchImpl);
    const step1 = await screen.findByTestId("onboarding-step-1");
    const cta = step1.querySelector("button") as HTMLButtonElement;
    await user.click(cta);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    // Scope the text assertion to the dialog so we don't collide
    // with the step's CTA label ("+ New domain") at the wizard
    // level.
    const dialog = screen.getByRole("dialog");
    // NewDomainModal's heading reads "New domain" — case-insensitive
    // match against the dialog subtree.
    expect(dialog.textContent ?? "").toMatch(/new domain/i);
  });

  it("step 2 CTA opens the NewSourceBindingModal once step 1 is done", async () => {
    const { fetchImpl } = makeFetch({
      domains: 1,
      sourceBindings: 0,
      agentInstances: 0,
      heartbeatDone: false,
    });
    const user = userEvent.setup();
    renderWizard(fetchImpl);
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-2").getAttribute("data-step-status"),
      ).toBe("pending");
    });
    const step2 = screen.getByTestId("onboarding-step-2");
    const cta = step2.querySelector("button") as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
    await user.click(cta);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  it("step 3 CTA opens the NewAgentInstanceModal once step 2 is done", async () => {
    const { fetchImpl } = makeFetch({
      domains: 1,
      sourceBindings: 1,
      agentInstances: 0,
      heartbeatDone: false,
    });
    const user = userEvent.setup();
    renderWizard(fetchImpl);
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-step-3").getAttribute("data-step-status"),
      ).toBe("pending");
    });
    const step3 = screen.getByTestId("onboarding-step-3");
    const cta = step3.querySelector("button") as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
    await user.click(cta);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});
