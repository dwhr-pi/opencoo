/**
 * Perf instrumentation helpers — PR-B8 (wave-16, phase-a appendix
 * #16). Thin wrappers around `performance.mark` /
 * `performance.measure` so the wave-end Lighthouse run can read
 * structured route-navigation timings without each consumer
 * re-deriving the mark name.
 *
 * Naming schema (one place, here):
 *
 *   route:<tab>:click         — sidebar / palette dispatched a nav
 *   route:<tab>:import-start  — React.lazy chunk started loading
 *   route:<tab>:import-end    — chunk resolved, component mountable
 *   route:<tab>:fetch-start   — route's data fetch begins
 *   route:<tab>:fetch-end     — route's data fetch resolves
 *   route:<tab>:nav           — measure: click → fetch-end
 *
 * Every mark / measure ALSO appends a structured entry to
 * `window.opencoo_perf` so a dev-only PerfPanel and an external
 * Lighthouse runner (`page.evaluate(() => window.opencoo_perf)`)
 * both read from the same source. The browser already maintains
 * a buffer for `performance.getEntries()`, but Safari truncates
 * after 250 entries and the buffer is shared with other libs;
 * the side-channel keeps opencoo's entries isolated.
 *
 * Lib is intentionally tiny — it owns naming, ordering and the
 * side-channel array. Nothing else.
 */

/**
 * Public entry shape on `window.opencoo_perf`. `time` is a
 * `performance.now()` reading (DOMHighResTimeStamp, ms since
 * navigationStart). `duration` is only present on measure entries.
 */
export interface OpencooPerfEntry {
  readonly name: string;
  readonly type: "mark" | "measure";
  readonly time: number;
  readonly duration?: number;
}

declare global {
  interface Window {
    /** Side-channel for opencoo's perf entries. Populated lazily
     *  on first mark. External readers (PerfPanel, Lighthouse
     *  runners) must tolerate `undefined` until the first call. */
    opencoo_perf?: OpencooPerfEntry[];
  }
}

/**
 * Maximum entries retained on `window.opencoo_perf`. Past this,
 * the oldest entries are dropped FIFO — the side-channel is for
 * recent timings, not historical telemetry. Without a cap a
 * long-lived SPA session would leak memory; with a cap, the
 * trailing N entries are always available to a Lighthouse
 * runner or the dev PerfPanel (Copilot triage on PR-B8).
 */
const MAX_ENTRIES = 200;

/**
 * Route key tag — narrowed to the routes' `Tab` union so
 * `markRoute*` consumers can't pass a typoed slug that no
 * Lighthouse / PerfPanel consumer would recognize. Duplicated
 * literal-union rather than importing `../types.js` to keep this
 * lib free of cross-module deps (it is the lowest-level lib in
 * the UI package; everything imports it, it imports nothing).
 * (Copilot triage on PR-B8.)
 */
export type PerfRouteKey =
  | "domains"
  | "sources"
  | "agents"
  | "outputs"
  | "llmPolicy"
  | "prompts"
  | "activity"
  | "review"
  | "reports"
  | "audit"
  | "cost";

/**
 * Append a single entry to `window.opencoo_perf`, creating the
 * array on first use. Caps retention at `MAX_ENTRIES` (FIFO eviction)
 * so a long-lived session can't leak memory. Exported so
 * consumers that emit custom non-route marks (e.g. agent-runs
 * SSE) can share the channel without re-importing the array.
 */
export function pushPerfEntry(entry: OpencooPerfEntry): void {
  if (typeof window === "undefined") return;
  if (!Array.isArray(window.opencoo_perf)) {
    window.opencoo_perf = [];
  }
  window.opencoo_perf.push(entry);
  // FIFO trim — keep the trailing MAX_ENTRIES so the cap is
  // both predictable and cheap (no allocation when under cap).
  if (window.opencoo_perf.length > MAX_ENTRIES) {
    window.opencoo_perf.splice(0, window.opencoo_perf.length - MAX_ENTRIES);
  }
}

function safeMark(name: string): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") {
    return;
  }
  try {
    performance.mark(name);
  } catch {
    // performance.mark can throw on duplicate names in some
    // engines under strict modes; swallowing keeps the lib
    // side-effect-only.
    return;
  }
  pushPerfEntry({ name, type: "mark", time: performance.now() });
}

/** Mark the moment a sidebar / palette click dispatches a nav. */
export function markRouteClick(tab: PerfRouteKey): void {
  safeMark(`route:${tab}:click`);
}

/** Mark the start of the `React.lazy` chunk load for `tab`. */
export function markRouteImportStart(tab: PerfRouteKey): void {
  safeMark(`route:${tab}:import-start`);
}

/** Mark the moment the lazy chunk has resolved. */
export function markRouteImportEnd(tab: PerfRouteKey): void {
  safeMark(`route:${tab}:import-end`);
}

/** Mark the start of the route's data fetch. */
export function markRouteFetchStart(tab: PerfRouteKey): void {
  safeMark(`route:${tab}:fetch-start`);
}

/** Mark the resolution of the route's data fetch. */
export function markRouteFetchEnd(tab: PerfRouteKey): void {
  safeMark(`route:${tab}:fetch-end`);
}

/**
 * Bracket-measure: click → fetch-end. Swallows the DOMException
 * that fires if the bracket marks aren't present (operator bailed
 * mid-nav). The measure also lands on `window.opencoo_perf` for
 * the dev panel.
 *
 * Important: callers MUST only invoke this once per nav (i.e. on
 * the FIRST fetch following a click). The function does NOT
 * deduplicate — if a route's data effect re-runs for a non-nav
 * reason (toggle, refresh-nonce), calling `measureRouteNav` again
 * would re-measure from the stale click mark and inflate the
 * side-channel with non-navigation timings. The route is
 * responsible for the gating (typically: capture a "did-mount"
 * ref and only measure on the first effect run). (Copilot triage
 * on PR-B8.)
 */
export function measureRouteNav(tab: PerfRouteKey): void {
  if (
    typeof performance === "undefined" ||
    typeof performance.measure !== "function"
  ) {
    return;
  }
  const startName = `route:${String(tab)}:click`;
  const endName = `route:${String(tab)}:fetch-end`;
  const measureName = `route:${String(tab)}:nav`;
  let duration: number | undefined;
  try {
    const m = performance.measure(measureName, startName, endName);
    // Older browsers (and jsdom) return `undefined` from measure
    // even on success; pull the duration off the buffer instead.
    if (m !== undefined && typeof m.duration === "number") {
      duration = m.duration;
    } else {
      const entries = performance.getEntriesByName(measureName, "measure");
      const last = entries[entries.length - 1];
      if (last !== undefined) duration = last.duration;
    }
  } catch {
    // Bracket marks missing — operator bailed mid-nav.
    return;
  }
  pushPerfEntry({
    name: measureName,
    type: "measure",
    time: performance.now(),
    ...(duration !== undefined ? { duration } : {}),
  });
}
