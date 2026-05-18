/**
 * Route-level code splitting tests — PR-B2 (wave-16, phase-a
 * appendix #16).
 *
 * Pin matrix:
 *   1. **Lazy boundary** — each route is loaded via `React.lazy`,
 *      so the initial render evaluates ONE route module (the
 *      active tab) plus the small route-skeleton primitives.
 *      Concretely: with tab='domains', the Activity / Audit /
 *      Cost / Reports / Review / Outputs / LlmPolicy / Prompts /
 *      Sources / Agents modules MUST NOT execute their
 *      top-level bodies on first render. We pin this by mocking
 *      every other route module with a factory that records
 *      "evaluated" the first time it runs.
 *
 *   2. **Suspense fallback** — while the lazy import is in
 *      flight, the Suspense boundary renders the matching
 *      `<RouteSkeleton route={tab} />`. The skeleton announces
 *      via `role="status"` (composed of B1 Skeleton primitives).
 *
 *   3. **Prefetch on hover/focus** — sidebar buttons fire
 *      `onMouseEnter` and `onFocus` handlers that warm the
 *      matching lazy import. The Chrome.Sidebar accepts a
 *      `prefetch(tab)` callback; App wires it to dynamic
 *      `import()` calls. The pin asserts the callback fires
 *      with the right Tab key for both mouseEnter and focus.
 *
 * Mocking strategy:
 *   `vi.mock` HOISTS to the top of the file, runs BEFORE the
 *   App import, and replaces the route modules. Each mock
 *   factory captures into the shared `MODULE_EVALUATIONS`
 *   record so we can assert which modules were touched.
 *   `lazy()` calls `import('./routes/X')` — vitest's mock
 *   resolver returns the mock synchronously, but the Suspense
 *   boundary still suspends on the first render because
 *   `lazy` wraps the import in a thenable promise.
 *
 *   The real route bodies are NOT executed by the mocks; the
 *   counter assertions therefore measure exactly what we want:
 *   "would the production bundle have parsed this route's
 *   code?" maps to "did the module's factory fire?".
 *
 * Off-scope:
 *   - The PAT entry flow (auth gate). We pre-seed sessionStorage
 *     with a sentinel PAT so `App` short-circuits past the gate.
 *   - The CSRF + username fetch. Mocked at the api module level.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

import type { Tab } from "../../src/types.js";

// ─── Module-evaluation counters ─────────────────────────────
//
// Vitest hoists vi.mock above all imports. Factories can write
// to globalThis (no hoist-rule constraint there), and the test
// file reads counters via the same slot.
declare global {
  var __ROUTE_EVAL_COUNTERS__: Record<string, number> | undefined;
}

function resetCounters(): void {
  globalThis.__ROUTE_EVAL_COUNTERS__ = {
    Activity: 0,
    Agents: 0,
    Audit: 0,
    Cost: 0,
    Domains: 0,
    LlmPolicy: 0,
    Outputs: 0,
    Prompts: 0,
    Reports: 0,
    Review: 0,
    Sources: 0,
  };
}

function counters(): Record<string, number> {
  return globalThis.__ROUTE_EVAL_COUNTERS__ ?? {};
}

// Each mock factory bumps its counter and returns a stub
// component matching the real route's named export. Stubs
// render a unique `data-testid` so post-suspense assertions
// can confirm the right route mounted.

vi.mock("../../src/routes/Activity.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Activity = (c.Activity ?? 0) + 1;
  return {
    Activity: (): JSX.Element => <div data-testid="route-activity">Activity</div>,
  };
});
vi.mock("../../src/routes/Agents.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Agents = (c.Agents ?? 0) + 1;
  return {
    Agents: (): JSX.Element => <div data-testid="route-agents">Agents</div>,
  };
});
vi.mock("../../src/routes/Audit.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Audit = (c.Audit ?? 0) + 1;
  return {
    Audit: (): JSX.Element => <div data-testid="route-audit">Audit</div>,
  };
});
vi.mock("../../src/routes/Cost.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Cost = (c.Cost ?? 0) + 1;
  return {
    Cost: (): JSX.Element => <div data-testid="route-cost">Cost</div>,
  };
});
vi.mock("../../src/routes/Domains.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Domains = (c.Domains ?? 0) + 1;
  return {
    Domains: (): JSX.Element => <div data-testid="route-domains">Domains</div>,
  };
});
vi.mock("../../src/routes/LlmPolicy.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.LlmPolicy = (c.LlmPolicy ?? 0) + 1;
  return {
    LlmPolicy: (): JSX.Element => (
      <div data-testid="route-llmPolicy">LlmPolicy</div>
    ),
  };
});
vi.mock("../../src/routes/Outputs.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Outputs = (c.Outputs ?? 0) + 1;
  return {
    Outputs: (): JSX.Element => <div data-testid="route-outputs">Outputs</div>,
  };
});
vi.mock("../../src/routes/Prompts.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Prompts = (c.Prompts ?? 0) + 1;
  return {
    Prompts: (): JSX.Element => <div data-testid="route-prompts">Prompts</div>,
  };
});
vi.mock("../../src/routes/Reports.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Reports = (c.Reports ?? 0) + 1;
  return {
    Reports: (): JSX.Element => <div data-testid="route-reports">Reports</div>,
  };
});
vi.mock("../../src/routes/Review.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Review = (c.Review ?? 0) + 1;
  return {
    Review: (): JSX.Element => <div data-testid="route-review">Review</div>,
  };
});
vi.mock("../../src/routes/Sources.js", () => {
  const c = (globalThis.__ROUTE_EVAL_COUNTERS__ ??= {});
  c.Sources = (c.Sources ?? 0) + 1;
  return {
    Sources: (): JSX.Element => <div data-testid="route-sources">Sources</div>,
  };
});

// Stub the admin-API fetch so App.tsx's post-auth CSRF+user
// resolve doesn't try to hit a real port. The CSRF response
// shape is what App.tsx reads.
vi.mock("../../src/lib/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/api.js")>(
      "../../src/lib/api.js",
    );
  return {
    ...actual,
    fetchAdmin: vi.fn(async (url: string) => {
      if (url.includes("/_csrf")) {
        return {
          csrfToken: "test-csrf",
          username: "tester",
          _llmDebugLogActive: false,
        };
      }
      return {};
    }),
  };
});

// Pre-authenticate by stashing a PAT in sessionStorage before
// App reads getPat().
beforeEach(() => {
  resetCounters();
  window.sessionStorage.setItem("opencoo_pat", "test-pat");
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.resetModules();
});

// Dynamic App import — keep AFTER mocks so the lazy()
// factories observe the mocked routes.
async function loadApp(): Promise<typeof import("../../src/App.js")> {
  return await import("../../src/App.js");
}

describe("App route lazy-loading (PR-B2)", () => {
  it("with tab='domains' (default), only the Domains module is evaluated initially", async () => {
    const { App } = await loadApp();
    render(<App />);
    // The active tab's module evaluates as soon as React resolves
    // the lazy thenable, so we wait for the stub to mount.
    await waitFor(() => {
      expect(screen.queryByTestId("route-domains")).not.toBeNull();
    });

    const c = counters();
    expect(c.Domains).toBeGreaterThanOrEqual(1);
    // None of the non-active routes should have been loaded.
    for (const key of [
      "Activity",
      "Agents",
      "Audit",
      "Cost",
      "LlmPolicy",
      "Outputs",
      "Prompts",
      "Reports",
      "Review",
      "Sources",
    ]) {
      expect(c[key], `${key} module must NOT eval on first render`).toBe(0);
    }
  });

  it("RouteSkeleton component is exported and addressable for fallbacks", async () => {
    const mod = await import("../../src/components/RouteSkeleton.js");
    expect(mod.RouteSkeleton).toBeDefined();
    // The shape map is exhaustive over Tab — TypeScript pins
    // this at compile time via Record<Tab, …>; the runtime
    // assertion catches anyone who silently widens it.
    const tabs: ReadonlyArray<Tab> = [
      "domains",
      "sources",
      "agents",
      "outputs",
      "llmPolicy",
      "prompts",
      "activity",
      "review",
      "reports",
      "audit",
      "cost",
    ];
    for (const tab of tabs) {
      expect(
        (mod.ROUTE_SKELETON_SHAPES as Record<string, string>)[tab],
      ).toBeDefined();
    }
  });

  it("switching tab evaluates the new module and does not re-evaluate the old one", async () => {
    const { App } = await loadApp();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId("route-domains")).not.toBeNull();
    });

    expect(counters().Agents).toBe(0);

    // Click the Agents sidebar button to switch tabs.
    const operate = document.querySelector('[data-group="operate"]');
    expect(operate).not.toBeNull();
    const agentsBtn = Array.from(operate!.querySelectorAll("button")).find(
      (b) => b.textContent?.toLowerCase().includes("agent"),
    );
    expect(agentsBtn, "Agents sidebar button").not.toBeUndefined();
    await act(async () => {
      fireEvent.click(agentsBtn!);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("route-agents")).not.toBeNull();
    });

    expect(counters().Agents).toBeGreaterThanOrEqual(1);
    // Domains was already evaluated once; vitest's hoisted
    // module mocks evaluate their factory only the first time
    // a given path resolves (subsequent `import()`s return the
    // cached module record), so Domains stays at 1.
    expect(counters().Domains).toBeLessThanOrEqual(1);
  });

  it("prefetches the matching module on sidebar onMouseEnter (warm import before click)", async () => {
    const { App } = await loadApp();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId("route-domains")).not.toBeNull();
    });

    // Activity is in the Operate group; before any hover its
    // module is unevaluated.
    expect(counters().Activity).toBe(0);
    const operate = document.querySelector('[data-group="operate"]');
    expect(operate).not.toBeNull();
    const activityBtn = Array.from(operate!.querySelectorAll("button")).find(
      (b) => b.textContent?.toLowerCase().includes("activity"),
    );
    expect(activityBtn).not.toBeUndefined();
    await act(async () => {
      fireEvent.mouseEnter(activityBtn!);
    });
    await waitFor(() => {
      expect(counters().Activity).toBeGreaterThanOrEqual(1);
    });
  });

  it("prefetches the matching module on sidebar onFocus (keyboard warm-up)", async () => {
    const { App } = await loadApp();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId("route-domains")).not.toBeNull();
    });

    expect(counters().Cost).toBe(0);
    const governance = document.querySelector('[data-group="governance"]');
    expect(governance).not.toBeNull();
    const costBtn = Array.from(governance!.querySelectorAll("button")).find(
      (b) => b.textContent?.toLowerCase().includes("cost"),
    );
    expect(costBtn).not.toBeUndefined();
    await act(async () => {
      fireEvent.focus(costBtn!);
    });
    await waitFor(() => {
      expect(counters().Cost).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("Tab type coverage (prefetch map is exhaustive)", () => {
  it("App exposes a tab→prefetch map covering every Tab key", async () => {
    const tabs: ReadonlyArray<Tab> = [
      "domains",
      "sources",
      "agents",
      "outputs",
      "llmPolicy",
      "prompts",
      "activity",
      "review",
      "reports",
      "audit",
      "cost",
    ];
    const mod = await import("../../src/App.js");
    expect(mod.ROUTE_PREFETCH).toBeDefined();
    for (const tab of tabs) {
      expect(
        (mod.ROUTE_PREFETCH as Record<string, unknown>)[tab],
        `ROUTE_PREFETCH missing for "${tab}"`,
      ).toBeTypeOf("function");
    }
  });
});

// PR-B8 (wave-16) — sidebar nav fires a `route:<tab>:click`
// perf mark, and each lazy `import()` is bracketed by
// `route:<tab>:import-start` / `route:<tab>:import-end`. Tests
// read entries from `window.opencoo_perf` — the side-channel
// `lib/perf-marks.ts` writes to. That's the same channel the
// dev PerfPanel and the wave-end Lighthouse runner read from,
// so pinning that path keeps the test close to the production
// contract.
describe("App perf instrumentation (PR-B8)", () => {
  beforeEach(() => {
    delete (window as { opencoo_perf?: unknown }).opencoo_perf;
  });

  it("emits 'route:agents:click' on sidebar Agents click", async () => {
    const { App } = await loadApp();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId("route-domains")).not.toBeNull();
    });
    // Clear entries accumulated by the initial Domains render so
    // the post-click assertion is unambiguous.
    window.opencoo_perf = [];

    const operate = document.querySelector('[data-group="operate"]');
    expect(operate).not.toBeNull();
    const agentsBtn = Array.from(operate!.querySelectorAll("button")).find(
      (b) => b.textContent?.toLowerCase().includes("agent"),
    );
    expect(agentsBtn).not.toBeUndefined();
    await act(async () => {
      fireEvent.click(agentsBtn!);
    });

    const names = (window.opencoo_perf ?? []).map((e) => e.name);
    expect(names).toContain("route:agents:click");
  });

  it("brackets each lazy import with import-start / import-end marks", async () => {
    const { App } = await loadApp();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId("route-domains")).not.toBeNull();
    });
    // Initial render evaluates the Domains lazy adapter; both
    // import-start and import-end marks should land on the
    // side-channel.
    const names = (window.opencoo_perf ?? []).map((e) => e.name);
    expect(names).toContain("route:domains:import-start");
    expect(names).toContain("route:domains:import-end");
  });
});
