/**
 * Root App — Sidebar + TopBar + active tab + global flows
 * (PAT entry, debug banner, logout, Cmd-K palette).
 *
 * PR-B2 (wave-16, phase-a appendix #16) — every route is loaded
 * via `React.lazy`. The Vite default chunker emits one chunk per
 * `import()` boundary, so the entry chunk shipped to a cold
 * operator carries only the React runtime + i18n bootstrap +
 * Chrome shell + the Skeleton + RouteSkeleton primitives. Route
 * bodies stream in when needed. Sidebar buttons additionally
 * fire a prefetch on `onMouseEnter` / `onFocus` so the chunk
 * lands before the click — the operator never sees a fallback
 * unless they navigate via Cmd-K (where prefetch can't help).
 *
 * Each lazy adapter wraps the named export (`X`) into a default
 * one — the routes keep their named-export shape so the existing
 * unit tests under tests/unit/<route>.test.tsx don't drift.
 */
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CommandPalette,
  type CommandPaletteTarget,
} from "./components/CommandPalette.js";
import { DebugBanner } from "./components/DebugBanner.js";
import { Sidebar, TopBar } from "./components/Chrome.js";
import { LiveRegions } from "./components/LiveRegions.js";
import { PatEntryModal } from "./components/PatEntryModal.js";
import { PerfPanel } from "./components/PerfPanel.js";
import { RouteSkeleton } from "./components/RouteSkeleton.js";
import { ToastProvider, ToastRegion } from "./components/Toast.js";
import {
  ApiAuthError,
  fetchAdmin,
} from "./lib/api.js";
import {
  reconcileLocaleAtLogin,
  type SupportedLocale,
} from "./lib/i18n.js";
import { clearPat, getPat, setPat } from "./lib/pat-store.js";
import {
  markRouteClick,
  markRouteImportEnd,
  markRouteImportStart,
} from "./lib/perf-marks.js";
import type { Tab } from "./types.js";

// ─── Route lazy boundaries ──────────────────────────────────
// Each `lazy(...)` adapter wraps the named export into the
// default-export shape React.lazy requires. Source routes keep
// their named exports intact so existing route unit tests
// continue to pass unchanged.
//
// PR-B8 (wave-16) — each adapter brackets the dynamic `import()`
// with `markRouteImportStart` / `markRouteImportEnd` so the
// chunk-load duration lands on `window.opencoo_perf`. Vite still
// emits one chunk per `import()` URL, so the side effect doesn't
// regress B2's code-splitting.
function tracedImport<T>(
  tab: Tab,
  factory: () => Promise<T>,
): () => Promise<T> {
  return (): Promise<T> => {
    markRouteImportStart(tab);
    return factory().then((mod) => {
      markRouteImportEnd(tab);
      return mod;
    });
  };
}

const Activity = lazy(
  tracedImport("activity", () =>
    import("./routes/Activity.js").then((m) => ({ default: m.Activity })),
  ),
);
const Agents = lazy(
  tracedImport("agents", () =>
    import("./routes/Agents.js").then((m) => ({ default: m.Agents })),
  ),
);
const Audit = lazy(
  tracedImport("audit", () =>
    import("./routes/Audit.js").then((m) => ({ default: m.Audit })),
  ),
);
const Cost = lazy(
  tracedImport("cost", () =>
    import("./routes/Cost.js").then((m) => ({ default: m.Cost })),
  ),
);
const Domains = lazy(
  tracedImport("domains", () =>
    import("./routes/Domains.js").then((m) => ({ default: m.Domains })),
  ),
);
const LlmPolicy = lazy(
  tracedImport("llmPolicy", () =>
    import("./routes/LlmPolicy.js").then((m) => ({ default: m.LlmPolicy })),
  ),
);
const Outputs = lazy(
  tracedImport("outputs", () =>
    import("./routes/Outputs.js").then((m) => ({ default: m.Outputs })),
  ),
);
const Prompts = lazy(
  tracedImport("prompts", () =>
    import("./routes/Prompts.js").then((m) => ({ default: m.Prompts })),
  ),
);
const Reports = lazy(
  tracedImport("reports", () =>
    import("./routes/Reports.js").then((m) => ({ default: m.Reports })),
  ),
);
const Review = lazy(
  tracedImport("review", () =>
    import("./routes/Review.js").then((m) => ({ default: m.Review })),
  ),
);
const Sources = lazy(
  tracedImport("sources", () =>
    import("./routes/Sources.js").then((m) => ({ default: m.Sources })),
  ),
);

/**
 * Prefetch map — sidebar buttons call the matching function
 * `onMouseEnter` + `onFocus` to warm the lazy import before the
 * click lands. The same dynamic `import()` Vite already split
 * into a chunk above is referenced verbatim so the module
 * record is shared (Vite's import map dedupes on URL identity);
 * a hovered chunk that subsequently gets clicked resolves
 * synchronously.
 *
 * Exported so tests can assert the map is exhaustive over
 * `Tab` — the `Record<Tab, …>` type makes a missing entry a TS
 * compile error.
 */
/**
 * PR-B8 (wave-16) — prefetch entries are wrapped in the same
 * tracedImport helper as the lazy adapters so the real chunk
 * download time lands on `window.opencoo_perf` regardless of
 * whether the chunk was warmed by hover/focus or pulled
 * synchronously from the React.lazy adapter. Vite dedupes the
 * dynamic-import URL across both call sites, so a hovered chunk
 * + a subsequent click resolves the lazy adapter against the
 * already-resolved promise; the import-start/end emitted from
 * the prefetch path represents the ACTUAL download (Copilot
 * triage on PR-B8).
 */
export const ROUTE_PREFETCH: Readonly<Record<Tab, () => Promise<unknown>>> = {
  domains: tracedImport("domains", () => import("./routes/Domains.js")),
  sources: tracedImport("sources", () => import("./routes/Sources.js")),
  agents: tracedImport("agents", () => import("./routes/Agents.js")),
  outputs: tracedImport("outputs", () => import("./routes/Outputs.js")),
  llmPolicy: tracedImport("llmPolicy", () => import("./routes/LlmPolicy.js")),
  prompts: tracedImport("prompts", () => import("./routes/Prompts.js")),
  activity: tracedImport("activity", () => import("./routes/Activity.js")),
  review: tracedImport("review", () => import("./routes/Review.js")),
  reports: tracedImport("reports", () => import("./routes/Reports.js")),
  audit: tracedImport("audit", () => import("./routes/Audit.js")),
  cost: tracedImport("cost", () => import("./routes/Cost.js")),
};

interface CsrfResponse {
  readonly csrfToken: string;
  readonly username: string | null;
  readonly _llmDebugLogActive?: boolean;
  /** PR-C2 wave-16: operator's persisted locale preference from
   *  `users.locale_preference`. NULL means "no preference, fall
   *  back to the client-side detector default" — the SPA leaves
   *  localStorage alone in that case so the in-session SoT on
   *  this device persists. */
  readonly localePreference?: string | null;
}

/** Prompt roster surfaced by the Cmd-K palette. Mirrors the
 *  `PROMPT_NAMES` tuple in `packages/shared/src/prompts/loader.ts`.
 *  Duplicated here per the same rationale as `routes/Prompts.tsx`:
 *  the UI package keeps no `@opencoo/shared` runtime dependency,
 *  and adding a prompt is a one-line edit either way. The literal
 *  union is the source of truth for the `initialPromptName` prop
 *  the Prompts route accepts. */
const PALETTE_PROMPT_NAMES = [
  "classifier",
  "compiler",
  "heartbeat",
  "lint",
  "chat",
  "surfacer",
  "builder",
  "worldview-domain",
  "worldview-company",
] as const;
type PaletteName = (typeof PALETTE_PROMPT_NAMES)[number];

function isPaletteName(s: string): s is PaletteName {
  return (PALETTE_PROMPT_NAMES as readonly string[]).includes(s);
}

/**
 * Top-level export. Wraps the inner App in `<ToastProvider>` so
 * the entire tree — including the gating PatEntryModal — can
 * call `useToast()`, and mounts `<ToastRegion>` once. The region
 * portals to `document.body` so it survives auth-flow renders
 * without dropping queued toasts (the provider's state is held
 * on a single React root, above the auth gate). PR-B7, wave-16.
 *
 * PR-A4 (wave-16) — mounts `<LiveRegions />` once at the App
 * root. The two SR-only `<div aria-live>` regions subscribe to
 * `lib/announce.ts` and narrate any `pushAnnouncement(...)`
 * call (and, by extension, every Toast — the Toast bridge calls
 * pushAnnouncement when a toast is added). Mounting at the top
 * of the tree (above the auth gate) means the gating PatEntryModal
 * can also push announcements (e.g. an auth-failure error) and
 * have them narrated.
 */
export function App(): JSX.Element {
  return (
    <ToastProvider>
      <LiveRegions />
      <AppInner />
      <ToastRegion />
      {/* PR-B8 (wave-16) — perceived-performance debug panel.
          Hidden by default. Renders only if `import.meta.env.DEV`
          is true OR the URL carries `?perfDebug=1` — the runtime
          query check holds the render path alive in the prod
          bundle so a partner-deployment operator can flip the
          panel on against a built bundle without a rebuild. */}
      <PerfPanel />
    </ToastProvider>
  );
}

function AppInner(): JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("domains");
  const [authed, setAuthed] = useState<boolean>(() => getPat() !== null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [debugActive, setDebugActive] = useState<boolean>(false);
  // PR-W7a — when the operator clicks the "Prompts" affordance
  // in DomainDetail, we pre-select the domain in the Prompts
  // tab. The state is cleared once the Prompts route honors it
  // so subsequent manual selections persist.
  const [promptsInitialDomainId, setPromptsInitialDomainId] = useState<
    string | null
  >(null);
  // PR-W10 — Cmd-K palette navigation pre-selects a row inside
  // the destination tab. The Domains / Sources / Agents routes
  // accept an `initialOpenId` prop that resolves to the rows
  // table once the data lands and auto-opens the drill-down
  // modal. We track them as three separate states so a palette
  // jump to one route doesn't accidentally re-open a drill-down
  // on a different one.
  const [domainsOpenId, setDomainsOpenId] = useState<string | null>(null);
  const [sourcesOpenId, setSourcesOpenId] = useState<string | null>(null);
  const [agentsOpenId, setAgentsOpenId] = useState<string | null>(null);
  // PR-W10 — breadcrumb row-name. Each route lifts its selected
  // row's display label into this state via `onCrumbChange` so
  // the TopBar can render `<group> / <tab> / <row-name>`. Pages
  // without a drill-down (or with no row selected) pass null
  // and the bar renders the two-segment form.
  const [crumb, setCrumb] = useState<string | null>(null);
  // PR-W10 — Cmd-K palette open state. Cmd-K (mac) / Ctrl-K
  // (Linux/Win) toggles the palette; selection or Esc closes it.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // PR-W10 — Prompts route pre-select on a palette prompt-hop.
  // Distinct from `promptsInitialDomainId` (which seeds the
  // domain picker on a DomainDetail → Prompts hop); this state
  // seeds the prompt-name picker so Cmd-K → "Prompt: heartbeat"
  // lands on the heartbeat editor instead of the empty picker.
  // (Copilot triage on PR-W10.)
  const [promptsInitialName, setPromptsInitialName] = useState<string | null>(
    null,
  );

  const onNavigateToPrompts = (domainId: string): void => {
    setPromptsInitialDomainId(domainId);
    // `setTab` would unmount Domains before its `selected`-cleanup
    // effect publishes `null`, so clear the crumb inline. Same
    // crumb-clearing semantics as `navigateToTab`. (Copilot
    // triage on PR-W10.)
    setCrumb(null);
    setTab("prompts");
  };

  // Tab navigation must clear the row-level crumb — the row name
  // belongs to the route we're leaving. The destination route
  // re-publishes its own crumb (or null) once mounted.
  //
  // PR-B8 (wave-16) — emit a `route:<tab>:click` perf mark so the
  // wave-end Lighthouse run can measure the click → fetch-end
  // bracket. Same hook fires for both the sidebar (callers of
  // `navigateToTab`) and the palette dispatch below.
  const navigateToTab = useCallback((next: Tab): void => {
    markRouteClick(next);
    setTab(next);
    setCrumb(null);
  }, []);

  // Stable callback identity for child routes' effect dep lists
  // — without `useCallback` each parent re-render would re-fire
  // every route's onCrumbChange effect.
  const onCrumbChange = useCallback(
    (value: string | null): void => setCrumb(value),
    [],
  );

  // Palette dispatcher — maps a CommandPaletteTarget to the
  // existing setTab + initial-id plumbing. Domains/Sources/
  // Agents each get a dedicated pre-select state. Prompts honors
  // both the domain-hop channel (`promptsInitialDomainId`) and
  // the prompt-name channel (`promptsInitialName`) so Cmd-K →
  // "Prompt: heartbeat" actually lands on the heartbeat editor
  // rather than the empty picker (Copilot triage on PR-W10).
  const onPaletteNavigate = useCallback(
    (target: CommandPaletteTarget): void => {
      // PR-B8 — palette nav is functionally a click for perf
      // purposes (operator pressed Enter on a row); mark it the
      // same way the sidebar does so the click → fetch-end
      // bracket lands.
      markRouteClick(target.tab);
      setDomainsOpenId(null);
      setSourcesOpenId(null);
      setAgentsOpenId(null);
      setPromptsInitialName(null);
      setCrumb(null);
      if (target.tab === "domains" && target.entityId !== undefined) {
        setDomainsOpenId(target.entityId);
      } else if (target.tab === "sources" && target.entityId !== undefined) {
        setSourcesOpenId(target.entityId);
      } else if (target.tab === "agents" && target.entityId !== undefined) {
        setAgentsOpenId(target.entityId);
      } else if (target.tab === "prompts" && target.promptName !== undefined) {
        setPromptsInitialName(target.promptName);
      }
      setTab(target.tab);
    },
    [],
  );

  // Consume-once callbacks for palette pre-select. Once a route
  // applies its `initialOpenId`, App clears the corresponding
  // state — closing the modal + switching away + returning no
  // longer re-opens the stale row (Copilot triage on PR-W10).
  const onDomainsOpenIdConsumed = useCallback(
    (): void => setDomainsOpenId(null),
    [],
  );
  const onSourcesOpenIdConsumed = useCallback(
    (): void => setSourcesOpenId(null),
    [],
  );
  const onAgentsOpenIdConsumed = useCallback(
    (): void => setAgentsOpenId(null),
    [],
  );
  const onPromptsNameConsumed = useCallback(
    (): void => setPromptsInitialName(null),
    [],
  );

  // Global Cmd-K (macOS) / Ctrl-K (Linux/Windows) listener. We
  // bind it once at the root so the palette opens regardless of
  // which tab has focus. The handler short-circuits when the
  // gating PatEntryModal is up — there's nothing to navigate to
  // until the operator's authed.
  //
  // Platform gate (Copilot triage on PR-W10): only `metaKey` on
  // macOS, only `ctrlKey` elsewhere. Without this, Ctrl-K on macOS
  // would steal the standard "delete to end of line" text-editing
  // shortcut every textarea in the console relies on.
  useEffect(() => {
    if (!authed) return;
    const isMac =
      typeof navigator !== "undefined" &&
      (navigator.platform ?? "").toLowerCase().includes("mac");
    const onKey = (e: KeyboardEvent): void => {
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      if (modifier && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return (): void => document.removeEventListener("keydown", onKey);
  }, [authed]);

  useEffect((): void => {
    if (!authed) return;
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<CsrfResponse>("/api/admin/_csrf");
        setUsername(r.username);
        setDebugActive(r._llmDebugLogActive === true);
        // PR-C2 wave-16: reconcile localStorage against the DB
        // SoT at login. NULL = "no preference"; the reconciler
        // leaves localStorage alone in that case. Otherwise the
        // DB value wins (e.g. operator flipped locale on machine
        // A and is now signing into machine B).
        reconcileLocaleAtLogin(r.localePreference ?? null);
        setAuthError(null);
      } catch (err) {
        // Both auth and non-auth failures must flip `authed: false`
        // so the PatEntryModal can render the error message and let
        // the operator retry. Prior shape only flipped on
        // ApiAuthError → on a transient/network failure the error
        // string was set but the modal stayed hidden.
        if (err instanceof ApiAuthError) {
          setAuthError(
            err.status === 403
              ? t("auth.forbidden")
              : t("auth.loginFailed"),
          );
        } else {
          setAuthError(t("auth.loginFailed"));
        }
        setAuthed(false);
        clearPat();
      }
    })();
  }, [authed, t]);

  const onPatSubmit = async (pat: string): Promise<void> => {
    setPat(pat);
    setAuthed(true);
  };

  const onLogout = async (): Promise<void> => {
    try {
      await fetchAdmin("/api/admin/logout", { method: "POST" });
    } catch {
      // Server-side logout is best-effort; we always clear
      // client state regardless.
    }
    clearPat();
    setAuthed(false);
    setUsername(null);
  };

  // PR-C2 wave-16 — operator-controlled locale flip. The
  // LocaleSwitcher in TopBar calls this AFTER it has already
  // flipped i18n + localStorage (the in-session SoT); we only
  // own the DB-persistence side here. A non-2xx response throws
  // — the switcher's catch handler logs the failure but does
  // NOT regress local state.
  const onChangeLocale = useCallback(
    async (locale: SupportedLocale): Promise<void> => {
      await fetchAdmin("/api/admin/users/me/locale", {
        method: "PATCH",
        body: { locale },
      });
    },
    [],
  );

  // PR-W3 — Activity feed signals a terminal SSE 401 (operator's PAT
  // is durably stale). Re-uses the existing PAT clear + sign-out flow:
  // dropping `authed` re-renders the gating PatEntryModal so the
  // operator can paste a fresh token. NO new auth flow here.
  const onSseAuthFailed = (): void => {
    clearPat();
    setAuthed(false);
    setUsername(null);
    setAuthError(t("auth.loginFailed"));
  };

  if (!authed) {
    return (
      <PatEntryModal
        onSubmit={onPatSubmit}
        {...(authError !== null ? { error: authError } : {})}
      />
    );
  }

  const tabs: Record<Tab, JSX.Element> = {
    domains: (
      <Domains
        onNavigateToPrompts={onNavigateToPrompts}
        onCrumbChange={onCrumbChange}
        onInitialOpenIdConsumed={onDomainsOpenIdConsumed}
        {...(domainsOpenId !== null ? { initialOpenId: domainsOpenId } : {})}
      />
    ),
    sources: (
      <Sources
        onCrumbChange={onCrumbChange}
        onInitialOpenIdConsumed={onSourcesOpenIdConsumed}
        {...(sourcesOpenId !== null ? { initialOpenId: sourcesOpenId } : {})}
      />
    ),
    agents: (
      <Agents
        onCrumbChange={onCrumbChange}
        onInitialOpenIdConsumed={onAgentsOpenIdConsumed}
        {...(agentsOpenId !== null ? { initialOpenId: agentsOpenId } : {})}
      />
    ),
    outputs: <Outputs />,
    llmPolicy: <LlmPolicy />,
    prompts: (
      <Prompts
        onInitialPromptNameConsumed={onPromptsNameConsumed}
        {...(promptsInitialDomainId !== null
          ? { initialDomainId: promptsInitialDomainId }
          : {})}
        {...(promptsInitialName !== null && isPaletteName(promptsInitialName)
          ? { initialPromptName: promptsInitialName }
          : {})}
      />
    ),
    activity: <Activity onAuthFailed={onSseAuthFailed} />,
    review: <Review />,
    reports: <Reports onNavigate={navigateToTab} />,
    audit: <Audit />,
    cost: <Cost />,
  };

  // PR-B2 — prefetch handler bound to sidebar buttons. Calling
  // the matching dynamic import on hover/focus warms the lazy
  // chunk before the click lands. `void` swallows the promise
  // — React batches the import resolution into Suspense state,
  // and we don't await it here.
  const onSidebarPrefetch = (next: Tab): void => {
    void ROUTE_PREFETCH[next]();
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper)",
      }}
    >
      <DebugBanner visible={debugActive} />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Sidebar
          tab={tab}
          setTab={navigateToTab}
          prefetch={onSidebarPrefetch}
        />
        {/* PR-A2 — landmark hierarchy: TopBar (banner) and route
            content (main) are siblings, not nested. A
            `<header role="banner">` nested inside `<main>` violates
            the W3C landmark contract (banner is intended as
            top-level chrome). This wrapper splits them: TopBar
            renders OUTSIDE <main>; <main aria-labelledby="…">
            wraps only the route render. The visual layout (flex
            column with the bar above the scroll region) is
            preserved. (Copilot triage on PR-A2.) */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <TopBar
            tab={tab}
            {...(crumb !== null ? { crumb } : {})}
            username={username}
            onLogout={(): void => {
              void onLogout();
            }}
            onChangeLocale={onChangeLocale}
          />
          <main
            aria-labelledby="opencoo-page-h1"
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflow: "auto",
            }}
          >
            {/* PR-B2 — Suspense boundary per active tab. The
                `key={tab}` resets the boundary on tab switch so
                switching to an unresolved route re-shows the
                matching skeleton fallback rather than the previous
                route's resolved children. */}
            <Suspense
              key={tab}
              fallback={<RouteSkeleton route={tab} />}
            >
              {tabs[tab]}
            </Suspense>
          </main>
        </div>
      </div>
      {paletteOpen ? (
        <CommandPalette
          onClose={(): void => setPaletteOpen(false)}
          onNavigate={onPaletteNavigate}
          promptNames={PALETTE_PROMPT_NAMES}
        />
      ) : null}
    </div>
  );
}
