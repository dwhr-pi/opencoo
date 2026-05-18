/**
 * Domains tab — listing + `+ New domain` create flow + per-row
 * drill-down (PR-R1, phase-a appendix #10).
 *
 * Phase-a appendix #2 closed the read-only-listing regression by
 * adding the create button + modal; PR-R1 layers on the row drill-
 * down (DomainDetail) for edit / soft-disable / hard-delete, the
 * "Show disabled" toggle (?include_disabled=1), and the disabled
 * badge on retired rows.
 *
 * PR-W11 design-system audit (accent budgets, compliant):
 * `--alert` on the load-error message only; `--healthy` only on
 * the enabled-status indicator.
 */
import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { Display } from "../components/Display.js";
import { DomainDetail } from "../components/DomainDetail.js";
import { EmptyStatePanel } from "../components/EmptyStatePanel.js";
import { NewDomainModal } from "../components/NewDomainModal.js";
import {
  ONBOARDING_DISMISSED_KEY,
  OnboardingWizard,
} from "../components/OnboardingWizard.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import {
  markRouteFetchEnd,
  markRouteFetchStart,
  measureRouteNav,
} from "../lib/perf-marks.js";
import type { Domain } from "../types.js";

interface DomainsResponse {
  readonly rows: ReadonlyArray<Domain>;
}

export interface DomainsProps {
  /** @internal Test seam — defaults to globalThis.fetch.
   *  Threaded through fetchAdmin so the page's calls are
   *  driven by the same mock the modal uses. */
  readonly fetchImpl?: typeof fetch;
  /** PR-W7a — opens the Prompts tab pre-selected to the given
   *  domain. Threaded down to DomainDetail's "Prompts"
   *  affordance. */
  readonly onNavigateToPrompts?: (domainId: string) => void;
  /** PR-W10 — Cmd-K palette pre-select. When set, the route
   *  auto-opens DomainDetail for the matching row once the
   *  domains list resolves. Consumed once via
   *  `onInitialOpenIdConsumed`; subsequent route remounts
   *  without a fresh palette dispatch will NOT re-open the
   *  old row. (Copilot triage on PR-W10.) */
  readonly initialOpenId?: string;
  /** PR-W10 — Consume signal. Fired once the route has used
   *  `initialOpenId` to open the matching drill-down. App.tsx
   *  clears its `domainsOpenId` state so closing the modal +
   *  navigating away + returning doesn't re-open the same row. */
  readonly onInitialOpenIdConsumed?: () => void;
  /** PR-W10 — Breadcrumb publisher. The route calls this with
   *  the selected domain's slug whenever the drill-down opens,
   *  and with `null` when it closes. App.tsx renders the value
   *  as the third breadcrumb segment. */
  readonly onCrumbChange?: (value: string | null) => void;
}

const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-3)",
};

export function Domains(props: DomainsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReadonlyArray<Domain> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showDisabled, setShowDisabled] = useState(false);
  const [selected, setSelected] = useState<Domain | null>(null);
  // PR-B6 (wave-16): wizard dismissal is persisted client-side
  // via `opencoo_onboarding_dismissed`. Read once on mount;
  // Cmd-K → "Run onboarding wizard" clears the flag and emits a
  // `storage` event so this route re-renders the wizard
  // immediately. The state is initialized lazily so SSR /
  // jsdom-less environments don't blow up on the read.
  const [wizardDismissed, setWizardDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Re-read the dismissal flag when the storage event fires
  // (cross-tab or via the palette re-summon below). Storage
  // events don't fire in the same window that wrote the value,
  // so the palette also calls a window-level custom event to
  // notify the same-tab listener.
  useEffect((): (() => void) => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== ONBOARDING_DISMISSED_KEY) return;
      setWizardDismissed(e.newValue === "1");
    };
    const onCustom = (): void => {
      try {
        setWizardDismissed(
          localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1",
        );
      } catch {
        setWizardDismissed(false);
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("opencoo:onboarding-summon", onCustom);
    return (): void => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("opencoo:onboarding-summon", onCustom);
    };
  }, []);

  const fetchOpts = fetchOptsFor(props.fetchImpl);

  // PR-B8 (wave-16) — only the FIRST fetch following mount is a
  // route-navigation event. Subsequent refetches (showDisabled
  // toggle, refreshNonce after a create / detail commit) are
  // intra-route operations — they share the route's "click" mark
  // but they aren't the nav. Without this gate, measureRouteNav
  // would re-measure click → fetch-end for every refetch and
  // pollute `window.opencoo_perf` with non-navigation timings
  // (Copilot triage on PR-B8).
  const didMeasureNavRef = useRef(false);

  useEffect((): void => {
    // PR-B8 (wave-16) — bracket the data-fetch with perf marks
    // so the click → fetch-end measure lands on
    // `window.opencoo_perf`. The Domains route is the
    // representative wave-end Lighthouse target; the same
    // pattern applies one-import-one-bracket to every other
    // route (follow-up: instrument Sources / Agents / Activity
    // / Review the same way once B8 lands).
    markRouteFetchStart("domains");
    void (async (): Promise<void> => {
      try {
        const path = showDisabled
          ? "/api/admin/domains?include_disabled=1"
          : "/api/admin/domains";
        const r = await fetchAdmin<DomainsResponse>(path, fetchOpts);
        setRows(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        markRouteFetchEnd("domains");
        if (!didMeasureNavRef.current) {
          didMeasureNavRef.current = true;
          measureRouteNav("domains");
        }
      }
    })();
    // refetch when the create modal flips refreshNonce, when the
    // detail modal commits a change, or when the disabled-toggle
    // flips.
  }, [refreshNonce, showDisabled]);

  // PR-W10 — auto-open drill-down for a palette-dispatched id.
  // The effect is gated on `rows` arrival so the matching domain
  // is in scope; once it fires `onInitialOpenIdConsumed` the
  // parent clears its `domainsOpenId` and this effect won't
  // re-trigger on subsequent remounts / refetches (Copilot
  // triage on PR-W10).
  const initialOpenId = props.initialOpenId;
  const onInitialOpenIdConsumed = props.onInitialOpenIdConsumed;
  useEffect((): void => {
    if (initialOpenId === undefined || rows === null) return;
    const match = rows.find((d) => d.id === initialOpenId);
    if (match !== undefined) {
      setSelected(match);
      onInitialOpenIdConsumed?.();
    }
  }, [initialOpenId, rows, onInitialOpenIdConsumed]);

  // PR-W10 — publish row-name to the App's breadcrumb on
  // selection changes.
  const onCrumbChange = props.onCrumbChange;
  useEffect((): void => {
    onCrumbChange?.(selected !== null ? selected.slug : null);
  }, [selected, onCrumbChange]);

  return (
    <div
      style={{
        padding: "24px 28px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <h1 id="opencoo-page-h1" style={{ margin: 0 }}>{t("domains.title")}</h1>
          {/* Editorial lede — PR-C4 (wave-16). Replaces the muted-
              gray <p> subtitle with the Instrument Serif italic
              lede; the existing `domains.subtitle` key is left in
              the locale file for now in case a future copy-pass
              wants it back. */}
          <Display level={2} as="p">
            {t("routes.domains.lede")}
          </Display>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <label style={TOGGLE_ROW_STYLE}>
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(e): void => setShowDisabled(e.target.checked)}
            />
            {t("domains.showDisabled")}
          </label>
          <Btn variant="primary" onClick={(): void => setCreateOpen(true)}>
            {t("domains.newDomain")}
          </Btn>
        </div>
      </div>
      {error === null && rows !== null && rows.length === 0 ? (
        wizardDismissed ? (
          <EmptyStatePanel
            title={t("domains.emptyState.title")}
            body={t("domains.emptyState.body")}
            cta={{
              label: t("domains.emptyState.ctaLabel"),
              onClick: (): void => setCreateOpen(true),
            }}
          />
        ) : (
          <OnboardingWizard
            {...fetchOpts}
            onDismissed={(): void => setWizardDismissed(true)}
          />
        )
      ) : (
      <Card>
        {error !== null ? (
          <div
            role="alert"
            style={{
              color: "var(--alert)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
            }}
          >
            {error}
          </div>
        ) : rows === null ? (
          <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 0.6fr 0.6fr",
              gap: 12,
            }}
          >
            <div className="t-micro">{t("domains.columns.slug")}</div>
            <div className="t-micro">{t("domains.columns.name")}</div>
            <div className="t-micro">{t("domains.columns.class")}</div>
            <div className="t-micro">{t("domains.columns.locale")}</div>
            <div className="t-micro">{t("domains.columns.aggregator")}</div>
            {rows.map((d) => {
              const disabled =
                d.disabledAt !== null && d.disabledAt !== undefined;
              // PR-R1 Copilot triage: Sources.tsx-shaped row
              // affordance. The previous `<button style={display:
              // contents}>` killed the focus outline because the
              // button generated no box. Each cell now gets
              // `role="button" tabIndex={0} onKeyDown` so the
              // browser draws the standard focus ring per cell and
              // every column is a click/Enter/Space target. The
              // i18n'd aria-label spells out the action for screen
              // readers (en/pl interpolate the slug). Disabled
              // badge is informational — `--ink-3` (muted), NOT
              // `--alert`.
              const onRowClick = (): void => setSelected(d);
              const onRowKey = (e: KeyboardEvent): void => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(d);
                }
              };
              const cellStyle: CSSProperties = {
                cursor: "pointer",
                padding: "4px 0",
              };
              const cellProps = {
                role: "button",
                tabIndex: 0,
                onClick: onRowClick,
                onKeyDown: onRowKey,
                "aria-label": t("domains.openDetail", { slug: d.slug }),
              } as const;
              return (
                <div
                  key={d.id}
                  style={{ display: "contents" }}
                  data-domain-id={d.id}
                >
                  <div
                    style={{
                      ...cellStyle,
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-mono)",
                      display: "flex",
                      gap: "var(--space-2)",
                      alignItems: "baseline",
                    }}
                    {...cellProps}
                  >
                    {d.slug}
                    {disabled ? (
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--fs-micro)",
                          color: "var(--ink-3)",
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                        }}
                      >
                        · {t("domains.disabledBadge")}
                      </span>
                    ) : null}
                  </div>
                  <div style={cellStyle} {...cellProps}>{d.name}</div>
                  <div
                    style={{ ...cellStyle, color: "var(--ink-3)" }}
                    {...cellProps}
                  >
                    {d.class}
                  </div>
                  <div
                    style={{ ...cellStyle, color: "var(--ink-3)" }}
                    {...cellProps}
                  >
                    {d.locale}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: d.isAggregator
                        ? "var(--healthy)"
                        : "var(--ink-3)",
                    }}
                    {...cellProps}
                  >
                    {d.isAggregator ? t("common.yes") : t("common.no")}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      )}
      {createOpen ? (
        <NewDomainModal
          {...fetchOpts}
          onCreated={(): void => {
            setCreateOpen(false);
            setRefreshNonce((n) => n + 1);
          }}
          onClose={(): void => setCreateOpen(false)}
        />
      ) : null}
      {selected !== null ? (
        <DomainDetail
          domain={selected}
          {...fetchOpts}
          onClose={(): void => setSelected(null)}
          onChanged={(): void => setRefreshNonce((n) => n + 1)}
          {...(props.onNavigateToPrompts !== undefined
            ? {
                onNavigateToPrompts: (id: string): void => {
                  setSelected(null);
                  props.onNavigateToPrompts?.(id);
                },
              }
            : {})}
        />
      ) : null}
    </div>
  );
}
