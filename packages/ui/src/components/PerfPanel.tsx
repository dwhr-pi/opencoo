/**
 * PerfPanel — dev-only floating debug strip showing the latest
 * `window.opencoo_perf` entries. PR-B8 (wave-16, phase-a appendix
 * #16).
 *
 * Mounted unconditionally from `App.tsx`; the body short-circuits
 * to `null` unless `import.meta.env.DEV` is true OR the URL carries
 * `?perfDebug=1`. The component IS retained in the production
 * bundle (because of the runtime `?perfDebug=1` escape hatch),
 * but the polling effect short-circuits on `!enabled` so a
 * normal prod operator pays only the cost of one boolean check
 * per App render. (Originally claimed to tree-shake out; revised
 * after Copilot triage on PR-B8 — the runtime URL check holds
 * the path alive for the production-debugging use case.)
 *
 * The panel polls `window.opencoo_perf` on a 1-second interval
 * (entries don't arrive on a React-state cycle — they're pushed
 * by `lib/perf-marks.ts`) and renders the trailing 12 rows. Each
 * row carries name + age + (for measure entries) duration. No
 * animation, no loop besides the heartbeat — re-renders are
 * data-driven, not motion-driven.
 *
 * Design-system honors:
 *   - paper-2 background + paper-3 border (depth via tone, not
 *     shadow/blur)
 *   - mono micro-label header ("PERF · DEV")
 *   - JetBrains Mono for entry rows (these ARE technical
 *     identifiers; treat them like log lines)
 *   - no emoji, no advisory amber, no alert red (this is
 *     diagnostic chrome, not advisory)
 *   - radius-s, no shadow, no gradient, no fully-rounded pills
 *
 * Operator escape hatch: `?perfDebug=1` flips the panel on
 * regardless of build mode — useful for ad-hoc partner-deployment
 * debugging without needing a dev rebuild.
 */
import { useEffect, useState, type CSSProperties } from "react";

import type { OpencooPerfEntry } from "../lib/perf-marks.js";

export interface PerfPanelProps {
  /** @internal Test seam — forces the gating boolean. Production
   *  callers MUST NOT pass this; the panel decides on its own
   *  based on `import.meta.env.DEV || ?perfDebug=1`. The runtime
   *  URL check means the render path is RETAINED in the prod
   *  bundle (a small fixed cost, since the panel is mounted once
   *  at App root and short-circuits to `null` on `!enabled`). */
  readonly enabledOverride?: boolean;
}

function isEnabled(): boolean {
  // `import.meta.env.DEV` is replaced at build time. The
  // `?perfDebug=1` fallback lets operators flip the panel on
  // against the built bundle during a partner deployment without
  // rebuilding — there's no exfiltration risk because the entries
  // are client-side perf timings.
  const dev = import.meta.env.DEV === true;
  const search =
    typeof window !== "undefined" && typeof window.location !== "undefined"
      ? window.location.search
      : "";
  const flagged = search.includes("perfDebug=1");
  return dev || flagged;
}

const PANEL_STYLE: CSSProperties = {
  position: "fixed",
  bottom: 12,
  left: 12,
  zIndex: 90,
  width: 360,
  maxHeight: 240,
  overflow: "auto",
  background: "var(--paper-2)",
  border: "1px solid var(--paper-3)",
  borderRadius: "var(--radius-s)",
  padding: "var(--space-3) var(--space-4)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  color: "var(--ink-2)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  fontSize: "var(--fs-mono)",
  color: "var(--ink-3)",
};

const LIST_STYLE: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto",
  gap: "var(--space-3)",
  alignItems: "baseline",
  color: "var(--ink-2)",
};

const NAME_STYLE: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const META_STYLE: CSSProperties = {
  color: "var(--ink-3)",
  fontWeight: 500,
};

const EMPTY_STYLE: CSSProperties = {
  color: "var(--ink-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
};

const POLL_MS = 1000;
const TAIL_LIMIT = 12;

export function PerfPanel(props: PerfPanelProps = {}): JSX.Element | null {
  const enabled = props.enabledOverride ?? isEnabled();
  const [entries, setEntries] = useState<OpencooPerfEntry[]>(
    () => (typeof window !== "undefined" ? window.opencoo_perf ?? [] : []),
  );
  const [now, setNow] = useState<number>(() =>
    typeof performance !== "undefined" ? performance.now() : 0,
  );

  useEffect((): (() => void) | void => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      setEntries(window.opencoo_perf ? [...window.opencoo_perf] : []);
      setNow(performance.now());
    }, POLL_MS);
    return (): void => window.clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;

  const tail = entries.slice(-TAIL_LIMIT).reverse();

  return (
    <aside
      role="complementary"
      aria-label="opencoo performance entries (dev only)"
      style={PANEL_STYLE}
      data-testid="opencoo-perf-panel"
    >
      <div style={HEADER_STYLE}>
        <span>PERF · DEV</span>
        <span aria-hidden="true">{entries.length}</span>
      </div>
      {tail.length === 0 ? (
        <div
          style={EMPTY_STYLE}
          data-testid="opencoo-perf-panel-empty"
        >
          No entries yet. Navigate a route to populate.
        </div>
      ) : (
        <ul style={LIST_STYLE}>
          {tail.map((entry, idx) => {
            const ageMs = Math.max(0, now - entry.time);
            return (
              <li
                key={`${entry.name}-${idx}-${entry.time}`}
                style={ROW_STYLE}
                data-testid="opencoo-perf-panel-row"
              >
                <span style={NAME_STYLE} title={entry.name}>
                  {entry.name}
                </span>
                <span style={META_STYLE}>
                  {entry.duration !== undefined
                    ? `${entry.duration.toFixed(1)}ms`
                    : "—"}
                </span>
                <span style={META_STYLE}>{formatAge(ageMs)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms ago`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
