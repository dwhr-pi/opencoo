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
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentInstanceDetail } from "../components/AgentInstanceDetail.js";
import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import type { AgentInstance } from "../types.js";

interface AgentsResponse {
  readonly rows: readonly AgentInstance[];
}

export interface AgentsProps {
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
}

export function Agents(props: AgentsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly AgentInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentInstance | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const opts = fetchOptsFor(props.fetchImpl);

  useEffect((): void => {
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
      }
    })();
  }, [refreshNonce]);

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
          <h1 style={{ margin: 0 }}>{t("agents.title")}</h1>
          <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>
            {t("agents.subtitle")}
          </p>
        </div>
        {/* `+ New agent instance` — v0.1 stub: instance creation
            lives in the `opencoo agents seed` CLI verb. The button
            is rendered (so the operator sees the affordance) but
            disabled until a follow-up wires the modal. */}
        <Btn variant="primary" disabled={true}>
          {t("agents.newInstanceStub")}
        </Btn>
      </div>
      <Card>
        {error !== null ? (
          <div
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
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--ink-3)" }}>{t("agents.empty")}</div>
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
    </div>
  );
}
