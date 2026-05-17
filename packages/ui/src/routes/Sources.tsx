/**
 * Sources tab — list of source-binding rows (PR 28 read-only) +
 * `+ New binding` create flow (phase-a appendix #2 — closes
 * the regression PR 29 introduced).
 *
 * Phase-a appendix #4 PR-A: enriched row with server-computed status,
 * human-readable name, lastEventAt relative time, and lastError.
 * The old client-side `b.enabled ? "ok" : "paused"` derivation is
 * removed — the server now owns the 3-state health signal.
 *
 * PR-W11 design-system audit (accent budgets, compliant):
 * `--alert` on lastError mono line only; Badge tone mapping
 * (`advisory` for unbound) is the documented opt-in.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge, type BadgeTone } from "../components/Badge.js";
import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { EmptyStatePanel } from "../components/EmptyStatePanel.js";
import { NewSourceBindingModal } from "../components/NewSourceBindingModal.js";
import { SourceBindingDetail } from "../components/SourceBindingDetail.js";
import { fetchAdmin } from "../lib/api.js";
import type { SourceBinding } from "../types.js";

interface SourcesResponse {
  readonly rows: ReadonlyArray<SourceBinding>;
}

/** Server `status` → Badge tone. `null` is unreachable here (caller
 *  short-circuits before rendering a Badge) but kept for exhaustiveness. */
const STATUS_TONE: Record<NonNullable<SourceBinding["status"]>, BadgeTone> = {
  alert: "alert",
  advisory: "advisory",
  healthy: "ok",
};

/** Format an ISO timestamp as a locale-aware relative time string.
 *  Uses i18n keys under `sources.relativeTime.*` so PL locale doesn't
 *  mix English strings with Polish UI. */
function formatRelativeTime(isoString: string, t: ReturnType<typeof useTranslation>["t"]): string {
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 60) return t("sources.relativeTime.justNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("sources.relativeTime.minutesAgo", { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("sources.relativeTime.hoursAgo", { n: diffHr });
  return t("sources.relativeTime.daysAgo", { n: Math.floor(diffHr / 24) });
}

export interface SourcesProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** PR-W10 — Cmd-K palette pre-select. When set, the route
   *  auto-opens SourceBindingDetail for the matching row once
   *  the binding list resolves. Consumed once via
   *  `onInitialOpenIdConsumed`; subsequent route remounts
   *  without a fresh palette dispatch will NOT re-open the
   *  old row. (Copilot triage on PR-W10.) */
  readonly initialOpenId?: string;
  /** PR-W10 — Consume signal. Fired once the route has used
   *  `initialOpenId`; the parent clears its `sourcesOpenId`. */
  readonly onInitialOpenIdConsumed?: () => void;
  /** PR-W10 — Breadcrumb publisher. The route calls this with
   *  the selected binding's `name` whenever the drill-down opens
   *  and `null` when it closes. */
  readonly onCrumbChange?: (value: string | null) => void;
}

export function Sources(props: SourcesProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReadonlyArray<SourceBinding> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  /** PR-Q10 — when a row is clicked the binding lands here and the
   *  drill-down modal opens. `null` keeps the modal closed. */
  const [selected, setSelected] = useState<SourceBinding | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const fetchOpts =
    props.fetchImpl !== undefined
      ? { fetchImpl: props.fetchImpl as typeof fetch }
      : {};

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<SourcesResponse>(
          "/api/admin/source-bindings",
          fetchOpts,
        );
        setRows(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    // refetch when the create modal flips refreshNonce.
  }, [refreshNonce]);

  // PR-W10 — auto-open drill-down for a palette-dispatched id.
  // `onInitialOpenIdConsumed` fires once the match is applied so
  // the parent clears `sourcesOpenId` — closing the modal and
  // returning to this tab won't re-open the old row (Copilot
  // triage on PR-W10).
  const initialOpenId = props.initialOpenId;
  const onInitialOpenIdConsumed = props.onInitialOpenIdConsumed;
  useEffect((): void => {
    if (initialOpenId === undefined || rows === null) return;
    const match = rows.find((b) => b.id === initialOpenId);
    if (match !== undefined) {
      setSelected(match);
      onInitialOpenIdConsumed?.();
    }
  }, [initialOpenId, rows, onInitialOpenIdConsumed]);

  // PR-W10 — publish row-name to the App's breadcrumb.
  const onCrumbChange = props.onCrumbChange;
  useEffect((): void => {
    onCrumbChange?.(selected !== null ? selected.name : null);
  }, [selected, onCrumbChange]);

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <h1 id="opencoo-page-h1" style={{ margin: 0 }}>{t("sources.title")}</h1>
          <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>{t("sources.subtitle")}</p>
        </div>
        <Btn variant="primary" onClick={(): void => setCreateOpen(true)}>
          {t("sources.newBinding")}
        </Btn>
      </div>
      {error === null && rows !== null && rows.length === 0 ? (
        <EmptyStatePanel
          title={t("sources.emptyState.title")}
          body={t("sources.emptyState.body")}
          cta={{
            label: t("sources.emptyState.ctaLabel"),
            onClick: (): void => setCreateOpen(true),
          }}
        />
      ) : (
      <Card>
        {error !== null ? (
          <div style={{ color: "var(--alert)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}>
            {error}
          </div>
        ) : rows === null ? (
          <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.2fr 1fr 1fr 1.2fr auto", gap: 12 }}>
            <div className="t-micro">{t("sources.columns.name")}</div>
            <div className="t-micro">{t("sources.columns.type")}</div>
            <div className="t-micro">{t("sources.columns.domain")}</div>
            <div className="t-micro">{t("sources.columns.reviewMode")}</div>
            <div className="t-micro">{t("sources.columns.lastEvent")}</div>
            <div className="t-micro">{t("sources.columns.lastError")}</div>
            <div className="t-micro">{t("sources.columns.status")}</div>
            {rows.map((b) => {
              // PR-Q10 — every cell shares the same row-level click target
              // so the operator can drill in from any column. The grid
              // uses `display: contents` so we can't wrap the cells in a
              // single clickable element without breaking the layout.
              // Adding the handler on each cell is the simplest path that
              // preserves the existing 7-column grid.
              const onRowClick = (): void => setSelected(b);
              const onRowKey = (e: React.KeyboardEvent): void => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(b);
                }
              };
              const cellStyle: React.CSSProperties = {
                cursor: "pointer",
                padding: "4px 0",
              };
              const cellProps = {
                role: "button",
                tabIndex: 0,
                onClick: onRowClick,
                onKeyDown: onRowKey,
                "aria-label": t("sources.detail.title") + " " + b.name,
              } as const;
              return (
                <div key={b.id} style={{ display: "contents" }} data-binding-id={b.id}>
                  <div style={{ ...cellStyle, fontFamily: "var(--font-mono)", fontSize: "var(--fs-mono)" }} {...cellProps}>{b.name}</div>
                  <div style={{ ...cellStyle, color: "var(--ink-3)" }} {...cellProps}>{b.adapterSlug}</div>
                  <div style={cellStyle} {...cellProps}>{b.domainSlug}</div>
                  <div style={{ ...cellStyle, color: "var(--ink-2)" }} {...cellProps}>{b.reviewMode}</div>
                  <div style={{ ...cellStyle, color: "var(--ink-3)", fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)" }} {...cellProps}>
                    {b.lastEventAt !== null ? formatRelativeTime(b.lastEventAt, t) : "—"}
                  </div>
                  <div style={{ ...cellStyle, color: "var(--ink-3)", fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} {...cellProps}>
                    {b.lastError ?? ""}
                  </div>
                  <div style={cellStyle} {...cellProps}>
                    {b.status !== null
                      ? <Badge tone={STATUS_TONE[b.status]}>{t(`sources.status.${b.status}`)}</Badge>
                      : <span />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      )}
      {createOpen ? (
        <NewSourceBindingModal
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl as typeof fetch }
            : {})}
          onCreated={(): void => {
            setCreateOpen(false);
            setRefreshNonce((n) => n + 1);
          }}
          onClose={(): void => setCreateOpen(false)}
        />
      ) : null}
      {selected !== null ? (
        <SourceBindingDetail
          binding={selected}
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl as typeof fetch }
            : {})}
          onClose={(): void => setSelected(null)}
          onChanged={(): void => {
            // Refetch the rows so a Disable/Delete action surfaces
            // immediately. The modal closes itself once onChanged
            // returns; clearing `selected` here keeps the Sources
            // tab in a consistent post-action state.
            setSelected(null);
            setRefreshNonce((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}
