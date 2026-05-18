/**
 * `lib/perf-marks.ts` unit tests — PR-B8 (wave-16, phase-a appendix #16).
 *
 * The lib is a thin wrapper around the browser's `performance.mark`
 * / `performance.measure` calls so the wave-end Lighthouse run can
 * read structured "click → import-end → fetch-end" sequences for
 * each operator-facing route. Every mark/measure additionally
 * appends a JSON entry to `window.opencoo_perf` so a dev-only
 * PerfPanel and an external collector (Lighthouse runner reading
 * `window.opencoo_perf` via `page.evaluate`) can both consume the
 * same data without a second source-of-truth.
 *
 * The lib is intentionally tiny — it owns naming, ordering, and
 * the side-channel array, nothing else. Tests pin:
 *
 *   1. Names match the spec'd schema (`route:<tab>:<phase>`).
 *   2. `measureRouteNav` only emits if the bracket marks exist,
 *      and falls back gracefully (no throw) if they don't — the
 *      operator may bail mid-navigation.
 *   3. `pushPerfEntry` appends to `window.opencoo_perf`,
 *      creating the array on first use so the lib doesn't need
 *      external bootstrap.
 *   4. Each public `markRoute*` call ALSO pushes a matching entry
 *      (single source of truth — anyone reading the array sees
 *      every mark, not just measures).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PerfEntry {
  readonly name: string;
  readonly type: "mark" | "measure";
  readonly time: number;
  readonly duration?: number;
}

declare global {
  interface Window {
    opencoo_perf?: PerfEntry[];
  }
}

beforeEach(() => {
  // Reset the side-channel and the underlying buffer per test
  // so mark counts are deterministic.
  performance.clearMarks();
  performance.clearMeasures();
  delete (window as { opencoo_perf?: unknown }).opencoo_perf;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markRouteClick", () => {
  it("calls performance.mark with `route:<tab>:click`", async () => {
    const spy = vi.spyOn(performance, "mark");
    const { markRouteClick } = await import("../../src/lib/perf-marks.js");
    markRouteClick("domains");
    expect(spy).toHaveBeenCalledWith("route:domains:click");
  });

  it("pushes a matching entry to window.opencoo_perf", async () => {
    const { markRouteClick } = await import("../../src/lib/perf-marks.js");
    markRouteClick("agents");
    const entries = window.opencoo_perf;
    expect(entries).toBeDefined();
    expect(entries!.some((e) => e.name === "route:agents:click")).toBe(true);
    const entry = entries!.find((e) => e.name === "route:agents:click")!;
    expect(entry.type).toBe("mark");
    expect(typeof entry.time).toBe("number");
  });
});

describe("markRouteImportStart / markRouteImportEnd", () => {
  it("emit the spec'd names", async () => {
    const spy = vi.spyOn(performance, "mark");
    const { markRouteImportStart, markRouteImportEnd } = await import(
      "../../src/lib/perf-marks.js"
    );
    markRouteImportStart("cost");
    markRouteImportEnd("cost");
    expect(spy).toHaveBeenCalledWith("route:cost:import-start");
    expect(spy).toHaveBeenCalledWith("route:cost:import-end");
  });
});

describe("markRouteFetchStart / markRouteFetchEnd", () => {
  it("emit the spec'd names", async () => {
    const spy = vi.spyOn(performance, "mark");
    const { markRouteFetchStart, markRouteFetchEnd } = await import(
      "../../src/lib/perf-marks.js"
    );
    markRouteFetchStart("review");
    markRouteFetchEnd("review");
    expect(spy).toHaveBeenCalledWith("route:review:fetch-start");
    expect(spy).toHaveBeenCalledWith("route:review:fetch-end");
  });
});

describe("measureRouteNav", () => {
  it("creates a measure between the click and fetch-end marks", async () => {
    const spy = vi.spyOn(performance, "measure");
    const {
      markRouteClick,
      markRouteFetchEnd,
      measureRouteNav,
    } = await import("../../src/lib/perf-marks.js");
    markRouteClick("domains");
    markRouteFetchEnd("domains");
    measureRouteNav("domains");
    expect(spy).toHaveBeenCalledWith(
      "route:domains:nav",
      "route:domains:click",
      "route:domains:fetch-end",
    );
  });

  it("pushes a measure entry with a numeric duration", async () => {
    const {
      markRouteClick,
      markRouteFetchEnd,
      measureRouteNav,
    } = await import("../../src/lib/perf-marks.js");
    markRouteClick("audit");
    markRouteFetchEnd("audit");
    measureRouteNav("audit");
    const measureEntry = window.opencoo_perf!.find(
      (e) => e.name === "route:audit:nav",
    );
    expect(measureEntry).toBeDefined();
    expect(measureEntry!.type).toBe("measure");
    expect(typeof measureEntry!.duration).toBe("number");
  });

  it("does not throw if the bracket marks are missing", async () => {
    // Operator bails mid-nav: click fired but no fetch-end. The
    // measure should swallow the DOMException so callers (route
    // unmount cleanups) don't need a try/catch.
    const { measureRouteNav } = await import("../../src/lib/perf-marks.js");
    expect(() => measureRouteNav("prompts")).not.toThrow();
  });
});

describe("pushPerfEntry", () => {
  it("appends to window.opencoo_perf, creating the array on first use", async () => {
    const { pushPerfEntry } = await import("../../src/lib/perf-marks.js");
    expect(window.opencoo_perf).toBeUndefined();
    pushPerfEntry({ name: "test:custom", type: "mark", time: 42 });
    expect(window.opencoo_perf).toEqual([
      { name: "test:custom", type: "mark", time: 42 },
    ]);
    pushPerfEntry({
      name: "test:custom-2",
      type: "measure",
      time: 50,
      duration: 8,
    });
    expect(window.opencoo_perf).toHaveLength(2);
    expect(window.opencoo_perf![1]?.duration).toBe(8);
  });

  it("preserves any existing entries on the array (additive)", async () => {
    window.opencoo_perf = [
      { name: "pre-existing", type: "mark", time: 1 },
    ];
    const { pushPerfEntry } = await import("../../src/lib/perf-marks.js");
    pushPerfEntry({ name: "new", type: "mark", time: 2 });
    expect(window.opencoo_perf).toHaveLength(2);
    expect(window.opencoo_perf[0]?.name).toBe("pre-existing");
    expect(window.opencoo_perf[1]?.name).toBe("new");
  });

  it("caps the side-channel at 200 entries (FIFO eviction)", async () => {
    const { pushPerfEntry } = await import("../../src/lib/perf-marks.js");
    // Push 250 entries — the oldest 50 should be evicted, the
    // trailing 200 retained.
    for (let i = 0; i < 250; i++) {
      pushPerfEntry({ name: `entry-${i}`, type: "mark", time: i });
    }
    expect(window.opencoo_perf).toHaveLength(200);
    expect(window.opencoo_perf![0]?.name).toBe("entry-50");
    expect(window.opencoo_perf![199]?.name).toBe("entry-249");
  });
});
