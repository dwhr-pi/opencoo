/**
 * perf-marks coverage walker — PR-B8+ (wave-17 follow-up to
 * wave-16 PR-B8).
 *
 * Wave-16 B8 (`8130111` / #176) shipped the
 * `markRouteFetchStart` / `markRouteFetchEnd` instrumentation
 * library + dev-only PerfPanel and wired ONE representative
 * route (`Domains.tsx`). This wave-17 follow-up extends the
 * bracket to the other 10 routes so the wave-end Lighthouse
 * runner sees a `route:<tab>:fetch-start` /
 * `route:<tab>:fetch-end` pair for every operator-facing tab.
 *
 * Test job — one walking pin: render each of the 11 routes with
 * a minimal mocked admin payload and assert both
 * `markRouteFetchStart(tab)` and `markRouteFetchEnd(tab)` were
 * invoked during the mount → data-resolved cycle.
 *
 * Notes:
 *  - We `vi.mock` the perf-marks module rather than `vi.spyOn`
 *    a live binding — the routes statically import the helpers,
 *    so a module-level spy installed AFTER import wouldn't
 *    intercept their captured references. Replacing the module
 *    with spy wrappers around the originals keeps the
 *    side-channel + `performance.mark` behaviour intact for any
 *    downstream consumer while still letting us assert call
 *    counts.
 *  - For routes whose primary data lives in a sub-tab (Reports,
 *    Review, Activity), the bracket lives in the default sub-
 *    view's fetch (`HeartbeatView`, `SourceBindingsReview`,
 *    `RunsView` — the latter is selected explicitly here since
 *    Activity's default tab is the SSE-only feed). For the
 *    Activity case we render the `runs` tab so a fetchAdmin call
 *    actually fires.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("../../src/lib/perf-marks.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib/perf-marks.js")>();
  return {
    ...mod,
    markRouteFetchStart: vi.fn(mod.markRouteFetchStart),
    markRouteFetchEnd: vi.fn(mod.markRouteFetchEnd),
    measureRouteNav: vi.fn(mod.measureRouteNav),
  };
});

import { ToastProvider } from "../../src/components/Toast.js";
import * as perfMarks from "../../src/lib/perf-marks.js";
import { Activity } from "../../src/routes/Activity.js";
import { Agents } from "../../src/routes/Agents.js";
import { Audit } from "../../src/routes/Audit.js";
import { Cost } from "../../src/routes/Cost.js";
import { Domains } from "../../src/routes/Domains.js";
import { LlmPolicy } from "../../src/routes/LlmPolicy.js";
import { Outputs } from "../../src/routes/Outputs.js";
import { Prompts } from "../../src/routes/Prompts.js";
import { Reports } from "../../src/routes/Reports.js";
import { Review } from "../../src/routes/Review.js";
import { Sources } from "../../src/routes/Sources.js";

const markRouteFetchStartSpy = perfMarks.markRouteFetchStart as unknown as ReturnType<
  typeof vi.fn
>;
const markRouteFetchEndSpy = perfMarks.markRouteFetchEnd as unknown as ReturnType<
  typeof vi.fn
>;

/** Build a fetch impl that returns the given JSON for URLs that
 *  match the configured prefixes and `{ ok: true }` for anything
 *  else. The default branch keeps incidental fetchers (CSRF,
 *  adapters, secondary endpoints) from 404'ing and tripping a
 *  route's error path before the perf-mark fires. */
function makeFetch(
  routes: ReadonlyArray<{ readonly prefix: string; readonly body: unknown }>,
): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const r of routes) {
      if (url.startsWith(r.prefix)) {
        return new Response(JSON.stringify(r.body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

interface RouteCase {
  readonly tab: string;
  readonly render: () => void;
}

const ROUTE_CASES: ReadonlyArray<RouteCase> = [
  {
    tab: "domains",
    render: () => {
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/domains", body: { rows: [] } },
      ]);
      render(<Domains fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "sources",
    render: () => {
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/source-bindings", body: { rows: [] } },
      ]);
      render(<Sources fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "agents",
    render: () => {
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/agent-instances", body: { rows: [] } },
      ]);
      render(<Agents fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "outputs",
    render: () => {
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/output-channels", body: { rows: [] } },
      ]);
      // Outputs uses useToast() and must be mounted under
      // <ToastProvider> the same way App.tsx mounts it.
      render(
        <ToastProvider>
          <Outputs fetchImpl={fetchImpl} />
        </ToastProvider>,
      );
    },
  },
  {
    tab: "prompts",
    render: () => {
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/prompts", body: { entries: [] } },
        { prefix: "/api/admin/domains", body: { rows: [] } },
      ]);
      render(<Prompts fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "reports",
    render: () => {
      const fetchImpl = makeFetch([
        {
          prefix: "/api/admin/heartbeat/preconditions",
          body: {
            heartbeatInstanceCount: 0,
            enabledHeartbeatInstanceCount: 0,
            instancesWithoutOutputChannels: 0,
            mostRecentRun: null,
            mostRecentDispatchedAt: null,
          },
        },
        { prefix: "/api/admin/heartbeat", body: { reports: [] } },
        {
          prefix: "/api/admin/redaction-events",
          body: { events: [], total: 0 },
        },
      ]);
      render(<Reports fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "activity",
    render: () => {
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/agent-runs", body: { rows: [], total: 0 } },
        { prefix: "/api/admin/pipelines", body: { pipelines: [] } },
        { prefix: "/api/admin/scheduler", body: { schedules: [] } },
      ]);
      // Activity's default tab is the SSE-only `feed`, so the
      // route emits its perf bracket synthetically on mount
      // (no fetchAdmin to wrap). Rendering the default surface
      // is sufficient — no sub-tab navigation required.
      render(<Activity fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "audit",
    render: () => {
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/audit-log", body: { rows: [] } },
      ]);
      render(<Audit fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "review",
    render: () => {
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/source-bindings", body: { rows: [] } },
      ]);
      render(<Review fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "cost",
    render: () => {
      const fetchImpl = makeFetch([
        {
          prefix: "/api/admin/cost-summary",
          body: {
            totalUsd: 0,
            period: "month",
            rangeFrom: "2026-05-01T00:00:00Z",
            rangeTo: "2026-05-09T00:00:00Z",
            byBucket: [],
            budgetState: [],
          },
        },
      ]);
      render(<Cost fetchImpl={fetchImpl} />);
    },
  },
  {
    tab: "llmPolicy",
    render: () => {
      // LlmPolicy doesn't accept a `fetchImpl` test seam — it
      // calls `fetchAdmin` against `globalThis.fetch` directly.
      // Stub the global for the duration of the assertion.
      const fetchImpl = makeFetch([
        { prefix: "/api/admin/domains", body: { rows: [] } },
      ]);
      vi.stubGlobal("fetch", fetchImpl);
      render(<LlmPolicy />);
    },
  },
];

describe("perf-marks coverage — 11 operator-facing routes", () => {
  // LlmPolicy doesn't accept a `fetchImpl` test seam — it calls
  // `fetchAdmin` against `globalThis.fetch` directly, so the test
  // stubs the global. Without this cleanup, Vitest's module
  // ordering can leak the mocked fetch into later test files
  // (Copilot triage on PR-B8+).
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const c of ROUTE_CASES) {
    it(`route ${c.tab}: emits markRouteFetchStart(${c.tab}) + markRouteFetchEnd(${c.tab})`, async () => {
      markRouteFetchStartSpy.mockClear();
      markRouteFetchEndSpy.mockClear();

      c.render();

      await waitFor(() => {
        expect(markRouteFetchStartSpy).toHaveBeenCalledWith(c.tab);
        expect(markRouteFetchEndSpy).toHaveBeenCalledWith(c.tab);
      });
    });
  }
});
