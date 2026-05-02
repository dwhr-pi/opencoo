/**
 * Reports tab — Heartbeat reader + Redaction events.
 *
 * Phase-a appendix #4 PR-D.
 *
 * Two sub-views:
 *   heartbeat — read-only mirror of the OutputAdapter's Heartbeat delivery,
 *     grouped by instance, latest first. Deep-links to agent_runs.id.
 *   redaction — last N redaction_events rows with metadata only.
 *     Content is NEVER logged or rendered per THREAT-MODEL §3.3.
 *
 * Design constraints (CLAUDE.md + THREAT-MODEL):
 *   - Heartbeat output is read from agent_runs.output — no LLM re-call.
 *   - Redaction view shows matchedByteRangesCount (count) only — never
 *     the byte ranges, never the source bytes. §3.3.
 *   - Read-only tab: append-only invariant §2 invariant 8.
 */
import { useEffect, useState, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { fetchAdmin } from "../lib/api.js";
import type { HeartbeatReport, RedactionEvent } from "../types.js";

// ─── Sub-tab type ─────────────────────────────────────────────────────────────

type ReportsTab = "heartbeat" | "redaction";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ReportsProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build fetchAdmin's options object only when an override is provided. */
function fetchOptsFor(
  fetchImpl: typeof fetch | undefined,
): { fetchImpl?: typeof fetch } {
  return fetchImpl !== undefined ? { fetchImpl } : {};
}

/** Single-line status / empty / error row. */
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

// ─── Heartbeat sub-view ───────────────────────────────────────────────────────

interface HeartbeatResponse {
  readonly reports: readonly HeartbeatReport[];
}

function HeartbeatView(props: { fetchImpl?: typeof fetch }): JSX.Element {
  const { t } = useTranslation();
  const [reports, setReports] = useState<readonly HeartbeatReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<HeartbeatResponse>(
          "/api/admin/heartbeat",
          fetchOptsFor(props.fetchImpl),
        );
        setReports(r.reports);
      } catch {
        setError(t("common.error"));
      }
    })();
  }, []);

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (reports === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;
  if (reports.length === 0) {
    return <NoticeRow tone="muted">{t("reports.heartbeat.empty")}</NoticeRow>;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: "16px 0",
      }}
    >
      {reports.map((report) => (
        <HeartbeatCard key={report.runId} report={report} />
      ))}
    </div>
  );
}

function CopyButton(props: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(props.value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [props.value]);
  return (
    <button
      onClick={handleCopy}
      title={copied ? props.value : `Copy run ID: ${props.value}`}
      aria-label={`Copy run ID ${props.value}`}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: copied ? "var(--healthy)" : "var(--ink-3)",
        background: "transparent",
        border: "1px solid var(--rule)",
        borderRadius: 3,
        padding: "1px 6px",
        cursor: "pointer",
      }}
    >
      {props.label}
    </button>
  );
}

function HeartbeatCard(props: { report: HeartbeatReport }): JSX.Element {
  const { t } = useTranslation();
  const { report } = props;
  const instanceLabel = report.instanceName ?? t("reports.heartbeat.noInstance");
  const runIdShort = report.runId.slice(0, 8);

  return (
    <div
      style={{
        border: "1px solid var(--rule)",
        borderRadius: 6,
        padding: "16px 20px",
        background: "var(--paper-2)",
      }}
    >
      {/* Header: instance name + run id deep-link + timestamp */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            color: "var(--ink)",
          }}
        >
          {instanceLabel}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--ink-3)",
            display: "flex",
            gap: 12,
          }}
        >
          {/* Copy the full run UUID to clipboard (Activity runs route is a PR-B addition). */}
          <CopyButton value={report.runId} label={runIdShort} />
          {report.startedAt !== null && (
            <span>{new Date(report.startedAt).toLocaleString()}</span>
          )}
        </span>
      </div>

      {/* Summary */}
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          color: "var(--ink-2)",
          marginBottom: report.output.alerts.length > 0 ? 12 : 0,
          lineHeight: 1.5,
        }}
      >
        {report.output.summary}
      </div>

      {/* Alerts */}
      {report.output.alerts.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {report.output.alerts.map((alert, idx) => (
            <div
              key={idx}
              style={{
                borderLeft: "2px solid var(--advisory)",
                paddingLeft: 12,
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--ink)",
                  marginBottom: 4,
                }}
              >
                {t("reports.heartbeat.priorityLabel", { n: alert.priority })}{" "}
                {alert.title}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  color: "var(--ink-2)",
                  lineHeight: 1.4,
                }}
              >
                {alert.body}
              </div>
              {alert.citations.length > 0 && (
                <div
                  style={{
                    marginTop: 4,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  {alert.citations.map((c) => (
                    <span
                      key={c}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color: "var(--wiki)",
                        background: "var(--paper)",
                        border: "1px solid var(--rule)",
                        borderRadius: 3,
                        padding: "1px 6px",
                      }}
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Redaction events sub-view ────────────────────────────────────────────────

interface RedactionEventsResponse {
  readonly events: readonly RedactionEvent[];
  readonly total: number;
}

function RedactionEventsView(props: { fetchImpl?: typeof fetch }): JSX.Element {
  const { t } = useTranslation();
  const [events, setEvents] = useState<readonly RedactionEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<RedactionEventsResponse>(
          "/api/admin/redaction-events?limit=100",
          fetchOptsFor(props.fetchImpl),
        );
        setEvents(r.events);
      } catch {
        setError(t("common.error"));
      }
    })();
  }, []);

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (events === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;
  if (events.length === 0) {
    return (
      <NoticeRow tone="muted">{t("reports.redaction.empty")}</NoticeRow>
    );
  }

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
          {["category", "pipeline", "guard", "matches", "fail mode", "time"].map((col) => (
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
        {events.map((event) => (
          <tr key={event.id} style={{ borderBottom: "1px solid var(--rule)" }}>
            <td
              style={{
                padding: "8px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--alert)",
              }}
            >
              {event.category}
            </td>
            <td
              style={{
                padding: "8px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--ink-2)",
              }}
            >
              {event.pipeline}
            </td>
            <td
              style={{
                padding: "8px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--ink-2)",
              }}
            >
              {event.guardSlug}
            </td>
            <td
              style={{
                padding: "8px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--ink)",
                textAlign: "right",
              }}
            >
              {/* matchedByteRangesCount — count only, never the ranges */}
              {event.matchedByteRangesCount}
            </td>
            <td
              style={{
                padding: "8px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--ink-3)",
              }}
            >
              {event.failMode}
            </td>
            <td
              style={{
                padding: "8px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--ink-3)",
              }}
            >
              {event.createdAt !== null
                ? new Date(event.createdAt).toLocaleTimeString()
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Main Reports component ───────────────────────────────────────────────────

export function Reports(props: ReportsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ReportsTab>("heartbeat");

  const tabs: Array<{ key: ReportsTab; label: string }> = [
    { key: "heartbeat", label: t("reports.tabs.heartbeat") },
    { key: "redaction", label: t("reports.tabs.redaction") },
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

      {/* Active sub-view */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {activeTab === "heartbeat" && (
          props.fetchImpl !== undefined
            ? <HeartbeatView fetchImpl={props.fetchImpl} />
            : <HeartbeatView />
        )}
        {activeTab === "redaction" && (
          props.fetchImpl !== undefined
            ? <RedactionEventsView fetchImpl={props.fetchImpl} />
            : <RedactionEventsView />
        )}
      </div>
    </div>
  );
}
