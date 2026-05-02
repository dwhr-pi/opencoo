/**
 * Activity tab — five-tab navigation: Feed (live SSE), Runs (list +
 * detail), Pipelines (per-queue cards).
 *
 * Phase-a appendix #4 PR-B.
 *
 * Three sub-views accessible via buttons at the top:
 *   feed       — live SSE-driven event stream from the engine
 *   runs       — paginated reverse-chrono list of agent_runs
 *   pipelines  — per-BullMQ-queue cards (depth, failed, DLQ count)
 *
 * Design constraints (CLAUDE.md + THREAT-MODEL):
 *   - Feed tab never renders prompt content (invariant 11). Token events
 *     carry only runId + token. Output is shown in run detail only when
 *     the server-returned `output` field is non-null (which requires
 *     LLM_DEBUG_LOG=1 on the server side).
 *   - Run list does NOT include `output` — only the detail view does.
 *   - StatusPill (PR-E) is used for run status indicators.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { StatusPill, type StatusTone } from "../components/StatusPill.js";
import { fetchAdmin } from "../lib/api.js";
import { openSseClient } from "../lib/sse.js";
import type { AgentRun, Pipeline } from "../types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FeedEntry {
  readonly id: string;
  readonly type: string;
  readonly at: string;
  readonly text: string;
  /** Optional tone override. `undefined` = neutral (default ink-2 color).
   *  `'alert'` = alert-red, used for output_delivery_dlq events (PR-L). */
  readonly tone?: "alert";
  /** Full delivery UUID for DLQ entries — shown truncated in the feed but
   *  available as a tooltip and `data-delivery-id` attr for audit lookup. */
  readonly deliveryId?: string;
}

interface AgentRunsResponse {
  readonly rows: readonly AgentRun[];
  readonly total: number;
}

interface PipelinesResponse {
  readonly pipelines: readonly Pipeline[];
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ActivityProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Sub-tab type ─────────────────────────────────────────────────────────────

type ActivityTab = "feed" | "runs" | "pipelines";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runStatusTone(status: string): StatusTone | null {
  switch (status) {
    case "success": return "healthy";
    case "running": return "advisory";
    case "failed":
    case "timeout": return "alert";
    default: return null;
  }
}

/** Build fetchAdmin's options object only when an override is provided —
 *  passing `{ fetchImpl: undefined }` would shadow the default. */
function fetchOptsFor(
  fetchImpl: typeof fetch | undefined,
): { fetchImpl?: typeof fetch } {
  return fetchImpl !== undefined ? { fetchImpl } : {};
}

/** Single-line status / empty / error row used by the runs + pipelines views. */
function NoticeRow(props: {
  tone: "alert" | "muted";
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        color: props.tone === "alert" ? "var(--alert)" : "var(--ink-3)",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        padding: "16px 0",
      }}
    >
      {props.children}
    </div>
  );
}

// ─── Feed sub-view ────────────────────────────────────────────────────────────

function FeedView(): JSX.Element {
  const { t } = useTranslation();
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState<FeedEntry[]>([]);

  useEffect(() => {
    const client = openSseClient("/api/admin/events");

    // Connected acknowledgement.
    const offConnected = client.on<{ connectedAt: string }>("connected", () => {
      setConnected(true);
    });

    // Agent run lifecycle events — all statuses (running, success, failed).
    // The original spec mentioned filtering to status='running' only, but
    // operators want to see completions in the feed too. No status filter
    // is applied here: the Activity feed shows every lifecycle transition.
    // (I5 decision — PR-B observability review.)
    const offRun = client.on<{
      runId: string;
      definitionSlug: string;
      status: string;
      startedAt: string;
    }>("agent_run", (evt) => {
      const d = evt.data;
      setEntries((prev) => [
        {
          id: d.runId,
          type: "run",
          at: d.startedAt,
          text: `${d.definitionSlug} → ${d.status}`,
        },
        ...prev.slice(0, 99), // keep last 100 entries
      ]);
    });

    // PR-L: output-delivery DLQ alerts — permanent delivery failures
    // surface in the Activity feed as alert-toned entries.
    const offDlq = client.on<{
      type: string;
      outputBindingId: string;
      deliveryId: string;
      error: string;
      occurredAt: string;
    }>("output_delivery_dlq", (evt) => {
      const d = evt.data;
      // deliveryId shown truncated (first 8 chars) for readability; full UUID
      // is accessible via the `data-delivery-id` attribute for audit lookup.
      const shortId = d.deliveryId.slice(0, 8);
      setEntries((prev) => [
        {
          id: d.deliveryId,
          type: "output_delivery_dlq",
          at: d.occurredAt,
          text: `${t("activity.feed.dlqAlert")} binding=${d.outputBindingId} ${t("activity.feed.dlqDeliveryId")}=${shortId} — ${d.error}`,
          tone: "alert" as const,
          deliveryId: d.deliveryId,
        },
        ...prev.slice(0, 99),
      ]);
    });

    // In test environments EventSource is not available and the client
    // marks itself as "open" immediately — treat that as connected.
    if (client.readyState === "open") {
      setConnected(true);
    }

    return () => {
      offConnected();
      offRun();
      offDlq();
      client.close();
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "16px 0",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: connected ? "var(--healthy)" : "var(--ink-3)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {connected ? t("activity.feed.live") : t("activity.feed.connecting")}
      </div>
      {entries.length === 0 && (
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            color: "var(--ink-3)",
          }}
        >
          {t("activity.feed.empty")}
        </div>
      )}
      {entries.map((e) => (
        <div
          key={e.id}
          data-delivery-id={e.deliveryId}
          title={e.deliveryId !== undefined ? `${t("activity.feed.dlqDeliveryId")}: ${e.deliveryId}` : undefined}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: e.tone === "alert" ? "var(--alert)" : "var(--ink-2)",
            borderLeft: `2px solid ${e.tone === "alert" ? "var(--alert)" : "var(--rule)"}`,
            paddingLeft: 10,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ color: "var(--ink-3)" }}>{e.at}</span>
          {e.tone === "alert" && (
            <StatusPill tone="alert">{t("activity.feed.dlq")}</StatusPill>
          )}
          <span>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Runs sub-view ────────────────────────────────────────────────────────────

function RunsView(props: { fetchImpl?: typeof fetch }): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<AgentRunsResponse>(
          "/api/admin/agent-runs?limit=50",
          fetchOptsFor(props.fetchImpl),
        );
        setRows(r.rows);
      } catch {
        setError(t("common.error"));
      }
    })();
  }, []);

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (rows === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;
  if (rows.length === 0) return <NoticeRow tone="muted">{t("activity.runs.empty")}</NoticeRow>;

  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
      }}
    >
      <thead>
        <tr style={{ borderBottom: "1px solid var(--rule)" }}>
          {["agent", "status", "tokens", "cost", "latency", "started"].map((col) => (
            <th
              key={col}
              style={{
                textAlign: "left",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                padding: "6px 8px",
              }}
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((run) => {
          const tone = runStatusTone(run.status);
          return (
            <tr key={run.id} style={{ borderBottom: "1px solid var(--rule)" }}>
              <td style={{ padding: "8px 8px", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {run.definitionSlug}
              </td>
              <td style={{ padding: "8px 8px" }}>
                {tone !== null ? (
                  <StatusPill tone={tone}>{run.status}</StatusPill>
                ) : (
                  <span style={{ color: "var(--ink-3)" }}>{run.status}</span>
                )}
              </td>
              <td style={{ padding: "8px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)" }}>
                {run.tokensIn}↑ {run.tokensOut}↓
              </td>
              <td style={{ padding: "8px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)" }}>
                ${Number(run.costUsd).toFixed(4)}
              </td>
              <td style={{ padding: "8px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)" }}>
                {run.latencyMs}ms
              </td>
              <td style={{ padding: "8px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>
                {run.startedAt !== null ? new Date(run.startedAt).toLocaleTimeString() : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Pipelines sub-view ───────────────────────────────────────────────────────

function PipelinesView(props: { fetchImpl?: typeof fetch }): JSX.Element {
  const { t } = useTranslation();
  const [pipelines, setPipelines] = useState<readonly Pipeline[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<PipelinesResponse>(
          "/api/admin/pipelines",
          fetchOptsFor(props.fetchImpl),
        );
        setPipelines(r.pipelines);
      } catch {
        setError(t("common.error"));
      }
    })();
  }, []);

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (pipelines === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;
  if (pipelines.length === 0) return <NoticeRow tone="muted">{t("activity.pipelines.empty")}</NoticeRow>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 0" }}>
      {pipelines.map((p) => (
        <div
          key={p.name}
          style={{
            border: "1px solid var(--rule)",
            borderRadius: 6,
            padding: "16px 20px",
            background: "var(--paper-2)",
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto",
            gap: 24,
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "var(--ink)",
            }}
          >
            {p.name}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)" }}>
            depth: {p.depth}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: p.failedCount > 0 ? "var(--alert)" : "var(--ink-2)" }}>
            failed: {p.failedCount}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: p.dlqCount > 0 ? "var(--alert)" : "var(--ink-2)" }}>
            DLQ: {p.dlqCount}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Activity component ──────────────────────────────────────────────────

export function Activity(props: ActivityProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ActivityTab>("feed");

  const tabs: Array<{ key: ActivityTab; label: string }> = [
    { key: "feed", label: t("activity.tabs.feed") },
    { key: "runs", label: t("activity.tabs.runs") },
    { key: "pipelines", label: t("activity.tabs.pipelines") },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        padding: "0 24px",
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Sub-tab navigation */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "16px 0 0",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={(): void => setActiveTab(tab.key)}
            style={{
              font: "inherit",
              fontSize: 13,
              padding: "6px 14px",
              background: activeTab === tab.key ? "var(--paper)" : "transparent",
              border: "1px solid",
              borderColor: activeTab === tab.key ? "var(--rule)" : "transparent",
              borderRadius: "4px 4px 0 0",
              color: activeTab === tab.key ? "var(--ink)" : "var(--ink-2)",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active sub-view. The ternary satisfies
          `exactOptionalPropertyTypes` — passing `fetchImpl={undefined}`
          would shadow the prop's optional default. */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {activeTab === "feed" && <FeedView />}
        {activeTab === "runs" && (
          props.fetchImpl !== undefined
            ? <RunsView fetchImpl={props.fetchImpl} />
            : <RunsView />
        )}
        {activeTab === "pipelines" && (
          props.fetchImpl !== undefined
            ? <PipelinesView fetchImpl={props.fetchImpl} />
            : <PipelinesView />
        )}
      </div>
    </div>
  );
}
