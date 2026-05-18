/**
 * Agents tab — list of `agent_instances` rows (PR-W2,
 * phase-a appendix #13 — closes G2).
 *
 * Mirrors `Sources.tsx`'s shape: list + per-row drill-down
 * modal. v0.1 leaves the `+ New agent instance` button as a
 * stub — instance creation already lives in the
 * `opencoo agents seed` CLI verb; surfacing it through the UI
 * is a follow-up (filed as a v0.2 candidate).
 *
 * Hard-nos honored: no gradients, no emoji, lowercase opencoo,
 * design-system tokens only.
 *
 * PR-W11 design-system audit (accent budgets, compliant):
 * `--alert` on the load-error message only; `--healthy` only on
 * the enabled-status indicator.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentInstanceDetail } from "../components/AgentInstanceDetail.js";
import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { EmptyStatePanel } from "../components/EmptyStatePanel.js";
import { NewAgentInstanceModal } from "../components/NewAgentInstanceModal.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import {
  markRouteFetchEnd,
  markRouteFetchStart,
  measureRouteNav,
} from "../lib/perf-marks.js";
import type { AgentInstance } from "../types.js";

interface AgentsResponse {
  readonly rows: readonly AgentInstance[];
}

export interface AgentsProps {
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
  /** PR-W10 — Cmd-K palette pre-select. When set, the route
   *  auto-opens AgentInstanceDetail for the matching row once
   *  the instance list resolves. Consumed once via
   *  `onInitialOpenIdConsumed`; subsequent route remounts
   *  without a fresh palette dispatch will NOT re-open the
   *  old row. (Copilot triage on PR-W10.) */
  readonly initialOpenId?: string;
  /** PR-W10 — Consume signal. Fired once the route has used
   *  `initialOpenId`; the parent clears its `agentsOpenId`. */
  readonly onInitialOpenIdConsumed?: () => void;
  /** PR-W10 — Breadcrumb publisher. Lifts the selected
   *  instance's `name` into App-level state for the TopBar
   *  third segment, and clears it on close. */
  readonly onCrumbChange?: (value: string | null) => void;
}

export function Agents(props: AgentsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly AgentInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentInstance | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const opts = fetchOptsFor(props.fetchImpl);

  // PR-B8+ (wave-17) — first-fetch-only nav measure (see Domains).
  const didMeasureNavRef = useRef(false);

  useEffect((): void => {
    markRouteFetchStart("agents");
    void (async (): Promise<void> => {
      // Clear any prior error at the start of each request so a
      // transient failure followed by a successful refetch doesn't
      // leave the stale error banner up. Copilot triage #1.
      setError(null);
      try {
        const r = await fetchAdmin<AgentsResponse>(
          "/api/admin/agent-instances",
          opts,
        );
        setRows(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        markRouteFetchEnd("agents");
        if (!didMeasureNavRef.current) {
          didMeasureNavRef.current = true;
          measureRouteNav("agents");
        }
      }
    })();
  }, [refreshNonce]);

  // PR-W10 — auto-open drill-down for a palette-dispatched id.
  // `onInitialOpenIdConsumed` fires once the match is applied so
  // the parent clears `agentsOpenId` — closing the modal and
  // returning to this tab won't re-open the old row (Copilot
  // triage on PR-W10).
  const initialOpenId = props.initialOpenId;
  const onInitialOpenIdConsumed = props.onInitialOpenIdConsumed;
  useEffect((): void => {
    if (initialOpenId === undefined || rows === null) return;
    const match = rows.find((r) => r.id === initialOpenId);
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
          <h1 id="opencoo-page-h1" style={{ margin: 0 }}>{t("agents.title")}</h1>
          <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>
            {t("agents.subtitle")}
          </p>
        </div>
        {/* `+ New agent instance` — PR-W4-UI (phase-a appendix #15)
            wires the modal. The wave-13 PR-W2 stub copy
            (`agents.newInstanceStub`) is retired; the operator now
            sees a working CTA + modal flow. */}
        <Btn
          variant="primary"
          onClick={(): void => setCreating(true)}
        >
          {t("agents.newInstance")}
        </Btn>
      </div>
      {error === null && rows !== null && rows.length === 0 ? (
        <EmptyStatePanel
          title={t("agents.emptyState.title")}
          body={t("agents.emptyState.body")}
          cta={{
            label: t("agents.emptyState.ctaLabel"),
            onClick: (): void => setCreating(true),
          }}
        />
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
              gridTemplateColumns: "1.4fr 1fr 1fr 0.7fr 1fr 1.2fr",
              gap: 12,
            }}
          >
            <div className="t-micro">{t("agents.columns.name")}</div>
            <div className="t-micro">{t("agents.columns.definitionSlug")}</div>
            <div className="t-micro">{t("agents.columns.schedule")}</div>
            <div className="t-micro">{t("agents.columns.enabled")}</div>
            <div className="t-micro">{t("agents.columns.boundChannels")}</div>
            <div className="t-micro">{t("agents.columns.lastRun")}</div>
            {rows.map((r) => {
              const onRowClick = (): void => setSelected(r);
              const onRowKey = (e: React.KeyboardEvent): void => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(r);
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
                "aria-label": t("agents.openAriaLabel", { name: r.name }),
              } as const;
              return (
                <div
                  key={r.id}
                  style={{ display: "contents" }}
                  data-instance-id={r.id}
                >
                  <div
                    style={{
                      ...cellStyle,
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-mono)",
                    }}
                    {...cellProps}
                  >
                    {r.name}
                  </div>
                  <div
                    style={{ ...cellStyle, color: "var(--ink-3)" }}
                    {...cellProps}
                  >
                    {r.definitionSlug}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: "var(--ink-2)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-micro)",
                    }}
                    {...cellProps}
                  >
                    {r.scheduleCron ?? "—"}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: r.enabled ? "var(--healthy)" : "var(--ink-3)",
                    }}
                    {...cellProps}
                  >
                    {r.enabled
                      ? t("outputs.enabledYes")
                      : t("outputs.enabledNo")}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: "var(--ink-2)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-mono)",
                    }}
                    {...cellProps}
                  >
                    {r.outputChannelCount}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: "var(--ink-3)",
                      fontSize: "var(--fs-micro)",
                      fontFamily: "var(--font-mono)",
                    }}
                    {...cellProps}
                  >
                    {r.lastRunStartedAt ?? "—"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      )}
      {selected !== null ? (
        <AgentInstanceDetail
          instance={selected}
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl as typeof fetch }
            : {})}
          onClose={(): void => setSelected(null)}
          onChanged={(): void => {
            setSelected(null);
            setRefreshNonce((n) => n + 1);
          }}
        />
      ) : null}
      {creating ? (
        <NewAgentInstanceModal
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl as typeof fetch }
            : {})}
          onClose={(): void => setCreating(false)}
          onCreated={(): void => {
            setCreating(false);
            setRefreshNonce((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}
