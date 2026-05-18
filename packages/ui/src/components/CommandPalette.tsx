/**
 * CommandPalette — Cmd-K navigation overlay (PR-W10, phase-a
 * appendix #15 wave-15).
 *
 * Fetches four admin-API result lists on open (domains, source
 * bindings, agent instances) plus the hard-coded prompt-name
 * roster, dedupes/scores them against the operator's query,
 * and dispatches a navigation callback when the operator hits
 * Enter (or clicks a row).
 *
 * Threat-model invariants:
 *   - read-only: the palette dispatches only navigation
 *     callbacks; no mutations cross this surface.
 *   - admin-only: the underlying GETs already sit behind the
 *     admin-team gate; the palette adds no new endpoints.
 *
 * Search algorithm (hand-rolled, no fuzzy lib):
 *   1. Case-insensitive substring match against the result's
 *      display label.
 *   2. Score = `0` if label starts with the query (prefix
 *      match), else `1` for a substring hit. Lower scores rank
 *      higher.
 *   3. Stable tie-break on the original list order so the same
 *      query renders the same list across opens.
 *
 * Keyboard contract:
 *   - Up / Down arrows move the highlighted index, wrapping at
 *     both ends (`(idx + delta + n) % n`).
 *   - Enter dispatches the navigation for the highlighted row.
 *   - Esc closes the palette (handled by the parent because the
 *     Modal shell owns the document-level keydown listener).
 *
 * Design-system: reuses Modal's backdrop shell so the palette
 * inherits the no-shadow, no-blur, paper card aesthetic. No
 * emoji. Highlighted matched chars render as `<b>` with
 * `color: var(--ink)` + `fontWeight: 600` — the palette spans
 * multiple result classes (domains, agents, sources, …), so we
 * cannot tint matches with `--wiki` without violating the
 * "Wiki Teal only on compiled-knowledge chrome" budget rule
 * (PR-W11 audit). Bold-on-ink is sufficient differentiation
 * without the tint.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import type {
  AgentInstance,
  Domain,
  SourceBinding,
  Tab,
} from "../types.js";

/** Result-target shape — the palette emits one of these via
 *  `onNavigate` when the operator selects a row. App.tsx maps it
 *  to `setTab(target.tab)` plus an optional drill-down hint
 *  (domain id for Domains/Prompts, binding id for Sources,
 *  instance id for Agents). The shape is deliberately narrow:
 *  the palette knows nothing about which routes render which
 *  modals, only the tab + entity id pair to dispatch. */
export interface CommandPaletteTarget {
  readonly tab: Tab;
  readonly entityId?: string;
  readonly promptName?: string;
}

type ResultKind = "domain" | "binding" | "agent" | "prompt" | "command";

interface CommandResult {
  readonly id: string;
  readonly kind: ResultKind;
  readonly label: string;
  readonly target: CommandPaletteTarget;
  /** PR-B6: an optional side-effect run before the navigation
   *  callback fires. Used by the "Run onboarding wizard"
   *  command to clear the localStorage dismissal flag so the
   *  Domains route re-renders the wizard. */
  readonly onSelect?: () => void;
}

/** PR-B6 — localStorage key + custom event name kept in sync with
 *  the OnboardingWizard component. Duplicated here (rather than
 *  imported) to avoid a circular component-level dep; the contract
 *  is asserted by the `command-palette-onboarding.test.tsx` suite. */
const ONBOARDING_DISMISSED_KEY = "opencoo_onboarding_dismissed";
const ONBOARDING_SUMMON_EVENT = "opencoo:onboarding-summon";

interface DomainsResponse {
  readonly rows: ReadonlyArray<Domain>;
}
interface BindingsResponse {
  readonly rows: ReadonlyArray<SourceBinding>;
}
interface AgentsResponse {
  readonly rows: ReadonlyArray<AgentInstance>;
}

export interface CommandPaletteProps {
  readonly onClose: () => void;
  readonly onNavigate: (target: CommandPaletteTarget) => void;
  /** Prompt names from `packages/shared` — passed in as a prop
   *  rather than imported directly so the UI doesn't reach into
   *  shared at build time and the test can pin the list. */
  readonly promptNames: ReadonlyArray<string>;
  /** @internal Test seam — overrides the admin-API fetch.
   *  Defaults to `globalThis.fetch` via `fetchAdmin`. */
  readonly fetchImpl?: typeof fetch;
  /** @internal Test seam — pre-seeds the result list so the
   *  test doesn't have to wait on the async load. */
  readonly initialResults?: ReadonlyArray<CommandResult>;
}

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(18, 18, 16, 0.32)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "var(--space-5)",
  paddingTop: "10vh",
  zIndex: 200,
};

const SHEET_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 560,
  background: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-xl)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  maxHeight: "70vh",
};

const SEARCH_ROW_STYLE: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  borderBottom: "1px solid var(--rule)",
  background: "var(--paper)",
};

const SEARCH_INPUT_STYLE: CSSProperties = {
  width: "100%",
  font: "inherit",
  fontFamily: "var(--font-sans)",
  fontSize: 15,
  background: "transparent",
  border: "none",
  outline: "none",
  color: "var(--ink)",
};

const RESULTS_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-2) 0",
};

const ROW_STYLE_BASE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-3)",
  padding: "8px 20px",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--ink)",
  // Don't let active highlight cause a layout shift — pin
  // background swap, not a border that pushes content.
  background: "transparent",
};

const ROW_STYLE_ACTIVE: CSSProperties = {
  ...ROW_STYLE_BASE,
  background: "var(--paper-2)",
};

const KIND_TAG_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  // Pin a min-width so labels align in a column regardless of
  // kind length ("Domain" vs "Binding" vs "Prompt").
  minWidth: 56,
};

const HINT_ROW_STYLE: CSSProperties = {
  padding: "8px var(--space-5)",
  borderTop: "1px solid var(--rule)",
  background: "var(--paper-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--ink-3)",
  textAlign: "center",
};

/** Highlight the matched substring with bold ink so the
 *  operator can see which characters resolved the query.
 *  Pure text walk — `q` is a literal substring, no regex.
 *  Tinting was ruled out (PR-W11 audit) — the palette spans
 *  non-knowledge entities, so `--wiki` would violate the
 *  "compiled-knowledge chrome only" budget. */
function highlight(label: string, q: string): JSX.Element {
  if (q === "") return <>{label}</>;
  const idx = label.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{label}</>;
  const before = label.slice(0, idx);
  const match = label.slice(idx, idx + q.length);
  const after = label.slice(idx + q.length);
  return (
    <>
      {before}
      <b style={{ color: "var(--ink)", fontWeight: 600 }}>{match}</b>
      {after}
    </>
  );
}

/** Score a result against the query — lower is better.
 *  Returns `null` if the result doesn't match at all. */
function scoreResult(label: string, q: string): number | null {
  if (q === "") return 2;
  const lc = label.toLowerCase();
  const ql = q.toLowerCase();
  if (lc.startsWith(ql)) return 0;
  if (lc.includes(ql)) return 1;
  return null;
}

/** PR-B6 — clear the wizard-dismissal flag and notify the
 *  Domains route (storage events don't fire same-tab, so we
 *  bridge with a custom event). The navigation dispatcher
 *  takes care of switching to the `domains` tab + scrolling. */
function clearOnboardingDismissal(): void {
  try {
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
  } catch {
    // ignore — localStorage can throw under quota / private-mode
  }
  try {
    window.dispatchEvent(new Event(ONBOARDING_SUMMON_EVENT));
  } catch {
    // ignore — no window (SSR) means there's nothing to notify
  }
  // Best-effort scroll-to-top — the wizard sits at the top of
  // Domains so the operator sees step 1 immediately.
  //
  // App.tsx renders the route inside a `<main>` element that
  // owns the scrollable viewport (`overflow: auto`, see
  // `packages/ui/src/App.tsx:487-494`) — `window.scrollTo`
  // alone does not move that container. We scroll both the
  // window (covers static-height layouts / future refactors)
  // and the live `<main>` (covers the current chrome). The
  // attribute selector matches the same node `aria-labelledby`
  // anchors the route h1 to, so we don't depend on a brittle
  // ref or DOM id. (Copilot triage on PR-B6.)
  if (typeof window !== "undefined") {
    try {
      window.scrollTo({ top: 0, behavior: "auto" });
    } catch {
      // ignore — degraded environment (jsdom etc.)
    }
  }
  if (typeof document !== "undefined") {
    const main = document.querySelector(
      'main[aria-labelledby="opencoo-page-h1"]',
    );
    if (main !== null) {
      try {
        (main as HTMLElement).scrollTop = 0;
      } catch {
        // ignore
      }
    }
  }
}

/** PR-B6 — the always-present "Run onboarding wizard" entry.
 *  Built lazily so each render of the palette gets a fresh
 *  closure (the side effect is idempotent; the closure carries
 *  no state). */
function buildOnboardingCommand(label: string): CommandResult {
  return {
    id: "command:onboarding",
    kind: "command",
    label,
    target: { tab: "domains" },
    onSelect: clearOnboardingDismissal,
  };
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  // PR-B6: the static "Run onboarding wizard" entry is the last
  // result regardless of source. It's appended both to the
  // pre-seeded `initialResults` (test path) and to the async
  // `collected` list (production path).
  const onboardingCommand = useMemo(
    () => buildOnboardingCommand(t("onboarding.palette.label")),
    [t],
  );
  const [results, setResults] = useState<ReadonlyArray<CommandResult>>(
    props.initialResults !== undefined
      ? [...props.initialResults, onboardingCommand]
      : [onboardingCommand],
  );
  const [loading, setLoading] = useState<boolean>(
    props.initialResults === undefined,
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const onClose = props.onClose;
  const onNavigate = props.onNavigate;

  // Esc-to-close + focus on mount. Listen on document so the
  // handler fires regardless of where focus sits (the input gets
  // initial focus but operators may tab away). Captured at the
  // capture phase + `stopImmediatePropagation` so an underlying
  // Modal's document Esc listener doesn't ALSO close — without
  // this, opening the palette while a domain detail is open and
  // pressing Esc closed both surfaces (Copilot triage on PR-W10).
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return (): void =>
      document.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  // Async load of admin-API result lists. Skipped when the test
  // pre-seeds `initialResults`.
  const fetchImpl = props.fetchImpl;
  useEffect(() => {
    if (props.initialResults !== undefined) return;
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        // Use the shared `fetchOptsFor` helper so optional
        // `fetchImpl` threading matches every other route under
        // `exactOptionalPropertyTypes` (Copilot triage on PR-W10).
        const fetchOpts = fetchOptsFor(fetchImpl);
        const [domainsResp, bindingsResp, agentsResp] = await Promise.all([
          fetchAdmin<DomainsResponse>("/api/admin/domains", fetchOpts),
          fetchAdmin<BindingsResponse>(
            "/api/admin/source-bindings",
            fetchOpts,
          ),
          fetchAdmin<AgentsResponse>("/api/admin/agent-instances", fetchOpts),
        ]);
        if (cancelled) return;
        const collected: CommandResult[] = [];
        for (const d of domainsResp.rows ?? []) {
          collected.push({
            id: `domain:${d.id}`,
            kind: "domain",
            label: d.slug,
            target: { tab: "domains", entityId: d.id },
          });
        }
        for (const b of bindingsResp.rows ?? []) {
          // Label by `name` (the same property Sources renders +
          // breadcrumbs publish) so what the operator sees in the
          // palette matches what opens in Sources. The
          // `adapterSlug → domainSlug` form is appended as the
          // searchable subtitle so adapter/domain queries still
          // resolve. (Copilot triage on PR-W10.)
          collected.push({
            id: `binding:${b.id}`,
            kind: "binding",
            label: `${b.name} (${b.adapterSlug} → ${b.domainSlug})`,
            target: { tab: "sources", entityId: b.id },
          });
        }
        for (const a of agentsResp.rows ?? []) {
          collected.push({
            id: `agent:${a.id}`,
            kind: "agent",
            label: `${a.definitionSlug} (${a.name})`,
            target: { tab: "agents", entityId: a.id },
          });
        }
        for (const name of props.promptNames) {
          collected.push({
            id: `prompt:${name}`,
            kind: "prompt",
            label: name,
            target: { tab: "prompts", promptName: name },
          });
        }
        // PR-B6: static command entries last in the list. The
        // onboarding entry is always present even if every
        // admin-API list above came back empty.
        collected.push(onboardingCommand);
        setResults(collected);
      } catch {
        // Read-only navigation surface — a failed load just
        // renders the empty state; operator can close and retry
        // by re-opening the palette. Even on load failure, the
        // static onboarding entry is still useful (operators
        // who dismissed the wizard early can re-summon it).
        if (!cancelled) setResults([onboardingCommand]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [fetchImpl, props.initialResults, props.promptNames, onboardingCommand]);

  // Filter + sort. Memoize so arrow-key navigation doesn't
  // re-score on every render.
  const ranked = useMemo<ReadonlyArray<CommandResult>>(() => {
    const scored: Array<{
      result: CommandResult;
      score: number;
      idx: number;
    }> = [];
    results.forEach((r, idx) => {
      const s = scoreResult(r.label, query);
      if (s !== null) scored.push({ result: r, score: s, idx });
    });
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.idx - b.idx;
    });
    return scored.map((s) => s.result);
  }, [results, query]);

  // Clamp activeIdx into range whenever the ranked list shrinks
  // below the current cursor. Without this the operator can land
  // on a phantom row after typing characters that narrow the
  // result set.
  useEffect(() => {
    if (activeIdx >= ranked.length) {
      setActiveIdx(ranked.length === 0 ? 0 : ranked.length - 1);
    }
  }, [activeIdx, ranked.length]);

  // PR-B6: invoke the optional `onSelect` side-effect before
  // navigation so command-class entries (e.g. "Run onboarding
  // wizard") can clear localStorage flags or fire window events
  // before the route swaps.
  const dispatchSelection = (chosen: CommandResult): void => {
    if (chosen.onSelect !== undefined) chosen.onSelect();
    onNavigate(chosen.target);
    onClose();
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (ranked.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % ranked.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + ranked.length) % ranked.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = ranked[activeIdx];
      if (chosen) dispatchSelection(chosen);
    }
  };

  return (
    <div
      style={BACKDROP_STYLE}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      data-component="command-palette"
      onClick={(e): void => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={SHEET_STYLE}
        className="opencoo-dialog-enter"
        onClick={(e): void => e.stopPropagation()}
        onKeyDown={onListKeyDown}
      >
        <div style={SEARCH_ROW_STYLE}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e): void => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            placeholder={t("commandPalette.placeholder")}
            style={SEARCH_INPUT_STYLE}
            aria-label={t("commandPalette.placeholder")}
            data-testid="command-palette-input"
          />
        </div>
        <div style={RESULTS_STYLE} role="listbox">
          {loading && ranked.length === 0 ? (
            <div style={EMPTY_STYLE}>{t("commandPalette.loading")}</div>
          ) : ranked.length === 0 ? (
            <div style={EMPTY_STYLE}>{t("commandPalette.empty")}</div>
          ) : (
            ranked.map((r, idx) => {
              const active = idx === activeIdx;
              return (
                <div
                  key={r.id}
                  role="option"
                  aria-selected={active}
                  data-result-id={r.id}
                  data-result-kind={r.kind}
                  data-result-active={active ? "true" : "false"}
                  style={active ? ROW_STYLE_ACTIVE : ROW_STYLE_BASE}
                  onMouseEnter={(): void => setActiveIdx(idx)}
                  onClick={(): void => dispatchSelection(r)}
                >
                  <span style={KIND_TAG_STYLE}>
                    {t(`commandPalette.kind.${r.kind}`)}
                  </span>
                  <span>{highlight(r.label, query)}</span>
                </div>
              );
            })
          )}
        </div>
        <div style={HINT_ROW_STYLE} data-testid="command-palette-hint">
          {t("commandPalette.hint")}
        </div>
      </div>
    </div>
  );
}
