/**
 * `components/PerfPanel.tsx` unit tests — PR-B8 (wave-16,
 * phase-a appendix #16).
 *
 * The panel is a dev-only side-channel for reading the perf
 * entries `lib/perf-marks.ts` writes to `window.opencoo_perf`.
 * It is wrapped in an `import.meta.env.DEV` check so it tree-
 * shakes out of the production bundle entirely; in tests we
 * bypass that gate via the `enabledOverride` prop (the prop is
 * never wired from production code — it exists so the gating
 * boolean can be driven from the test instead of from the
 * static-replaced env value).
 *
 * Tests pin:
 *   1. Gating — when `enabledOverride={false}` the panel
 *      renders nothing (mirrors the prod path where the
 *      DEV check returns false).
 *   2. Rendering — when enabled, the panel shows a row per
 *      entry in `window.opencoo_perf` with name + duration.
 *   3. Refresh — the panel polls / re-reads the array so new
 *      entries appear (operators trigger marks AFTER mount).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

import { PerfPanel } from "../../src/components/PerfPanel.js";

beforeEach(() => {
  delete (window as { opencoo_perf?: unknown }).opencoo_perf;
});

afterEach(() => {
  // Defensive: if any test in this file installs fake timers and
  // fails before its `vi.useRealTimers()` call, subsequent tests
  // can inherit the fake-timer state. Restore unconditionally so
  // a failure doesn't cascade (Copilot triage on PR-B8).
  vi.useRealTimers();
});

describe("PerfPanel — gating", () => {
  it("renders nothing when explicitly disabled (mirrors prod tree-shake)", () => {
    window.opencoo_perf = [
      { name: "route:domains:click", type: "mark", time: 10 },
    ];
    const { container } = render(<PerfPanel enabledOverride={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders when explicitly enabled (mirrors DEV / perfDebug=1 path)", () => {
    window.opencoo_perf = [
      { name: "route:domains:click", type: "mark", time: 10 },
    ];
    render(<PerfPanel enabledOverride={true} />);
    expect(screen.queryByTestId("opencoo-perf-panel")).not.toBeNull();
  });
});

describe("PerfPanel — entry rendering", () => {
  it("renders one row per entry on window.opencoo_perf", () => {
    window.opencoo_perf = [
      { name: "route:domains:click", type: "mark", time: 100 },
      {
        name: "route:domains:nav",
        type: "measure",
        time: 200,
        duration: 42,
      },
    ];
    render(<PerfPanel enabledOverride={true} />);
    expect(
      screen.getByText("route:domains:click", { exact: false }),
    ).toBeDefined();
    expect(
      screen.getByText("route:domains:nav", { exact: false }),
    ).toBeDefined();
    // Duration of the measure surfaces in ms (rounded to a
    // single decimal; the operator wants signal not precision).
    expect(screen.getByText(/42/)).toBeDefined();
  });

  it("renders a friendly placeholder when no entries exist", () => {
    render(<PerfPanel enabledOverride={true} />);
    expect(screen.getByTestId("opencoo-perf-panel-empty")).toBeDefined();
  });

  it("picks up newly-pushed entries on each tick", () => {
    vi.useFakeTimers();
    window.opencoo_perf = [];
    render(<PerfPanel enabledOverride={true} />);
    expect(screen.getByTestId("opencoo-perf-panel-empty")).toBeDefined();
    // Operator triggers a mark AFTER mount; the panel re-renders
    // on the next polling tick.
    window.opencoo_perf.push({
      name: "route:agents:click",
      type: "mark",
      time: 500,
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(
      screen.getByText("route:agents:click", { exact: false }),
    ).toBeDefined();
    vi.useRealTimers();
  });
});
