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
 *
 * PR-W11 design-system audit (accent budgets, compliant):
 *   - `--advisory`: heartbeat report-card left-rail + advisory-ink tone
 *     on the cap-pct cells; agent-layer only (heartbeat IS the agent
 *     layer). Well under 10% per viewport.
 *   - `--wiki`: citation badges (mono path tokens) only — compiled-
 *     knowledge chrome, textbook fit.
 *   - `--alert`: over-limit cell colors only — flagged items.
 *   - `--healthy`: copy-to-clipboard success indicator + ok status —
 *     compliant.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { AgentsRunNowButton } from "../components/AgentsRunNowButton.js";
import { SR_ONLY_STYLE } from "../components/Chrome.js";
import { Display } from "../components/Display.js";
import {
  EmptyStatePanel,
  type EmptyStateChainStatus,
} from "../components/EmptyStatePanel.js";
import { Table, type TableColumn } from "../components/Table.js";
import {
  createAgentRunsSubscription,
  type SubscribeToAgentRuns,
} from "../lib/agent-runs-subscription.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import { formatDateTime, formatTime } from "../lib/intl-format.js";
import { safeErrorMessage } from "../lib/safe-error.js";
import { extractDomainSlugFromPath } from "../lib/wiki-path.js";
import type {
  HeartbeatPreconditions,
  HeartbeatReport,
  RedactionEvent,
  Tab,
} from "../types.js";

// ─── Sub-tab type ─────────────────────────────────────────────────────────────

type ReportsTab = "heartbeat" | "redaction";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ReportsProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** @internal Test seam — per-listener subscribe callable for
   *  the per-card "Refresh now" buttons. When omitted, the route
   *  builds ONE shared subscription via
   *  `createAgentRunsSubscription` per mount and hands its
   *  `subscribe` down. Tests inject a stub directly so SSE wiring
   *  is bypassed. */
  readonly subscribeToAgentRuns?: SubscribeToAgentRuns;
  /** PR-W8 (phase-a appendix #15) — navigation callback wired by
   *  `App.tsx` so the empty-state diagnostic panel can deep-link to
   *  the relevant tab (Agents / Activity). When omitted (tests,
   *  isolated previews), the CTAs render as static text rather than
   *  links — the panel still surfaces the diagnostic; only the
   *  navigation affordance degrades. */
  readonly onNavigate?: (tab: Tab) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/** PR-R3 — extract a domain slug from the first valid citation in
 *  a heartbeat report. Returns null when the report has no
 *  citations or none yield a kebab-case slug; the caller
 *  suppresses the "Refresh now" button rather than dispatching
 *  against a guessed domain. */
function extractDomainSlugFromHeartbeat(
  report: HeartbeatReport,
): string | null {
  for (const alert of report.output.alerts) {
    for (const citation of alert.citations) {
      const slug = extractDomainSlugFromPath(citation);
      if (slug !== null) return slug;
    }
  }
  return null;
}

function HeartbeatView(props: {
  fetchImpl?: typeof fetch;
  /** @internal Test seam — see LintFindings for the same pattern. */
  subscribeToAgentRuns?: SubscribeToAgentRuns;
  onNavigate?: (tab: Tab) => void;
}): JSX.Element {
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
      } catch (err) {
        // PR-W8 — surface the real error (401 / 504 / etc.) via
        // `safeErrorMessage` so the operator sees what actually
        // happened instead of a generic "Error". The helper scrubs
        // Bearer-token bytes defensively in case the message echoes
        // a request header — see lib/safe-error.ts.
        setError(safeErrorMessage(err));
      }
    })();
  }, []);

  // Stable SSE subscription — ONE underlying client per
  // HeartbeatView mount; each "Refresh now" button calls
  // `subscription.subscribe(handler)` to add a listener without
  // re-opening the SSE pipe. Tests inject a stub `subscribe`
  // callable directly via the `subscribeToAgentRuns` prop and
  // skip the subscription object entirely (no SSE client
  // constructed in that case — `injectedSubscribe` is non-null
  // exactly when `subscription` is null).
  const injectedSubscribe = props.subscribeToAgentRuns;
  const subscription = useMemo(
    () =>
      injectedSubscribe !== undefined
        ? null
        : createAgentRunsSubscription(),
    [injectedSubscribe],
  );
  useEffect(
    () => (): void => {
      subscription?.close();
    },
    [subscription],
  );
  const subscribeToAgentRuns: SubscribeToAgentRuns =
    injectedSubscribe ?? subscription!.subscribe;

  // Editorial lede — PR-C4 (wave-16). Scoped to the heartbeat
  // sub-view only (NOT visible on the redaction-events tab, whose
  // copy describes a different surface). Wraps every internal
  // branch (loading / error / empty diagnostics / populated cards)
  // so the lede reads as the heartbeat tab's top-line summary.
  const lede = (
    <div style={{ padding: "20px 0 4px" }}>
      <Display level={2}>{t("routes.reports.lede")}</Display>
    </div>
  );

  if (error !== null) {
    return (
      <>
        {lede}
        <NoticeRow tone="alert">
          <div>
            <strong>{t("reports.heartbeat.errorPrefix")}</strong> {error}
          </div>
          <div style={{ marginTop: 4, color: "var(--ink-3)" }}>
            {t("reports.heartbeat.errorHelp")}
          </div>
        </NoticeRow>
      </>
    );
  }
  if (reports === null) {
    return (
      <>
        {lede}
        <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>
      </>
    );
  }
  if (reports.length === 0) {
    // PR-W8 — drill down the precondition chain so the operator
    // sees WHY the list is empty (no instance / disabled / no
    // channels / no runs / output IS NULL / failed status).
    return (
      <>
        {lede}
        <HeartbeatDiagnosticsPanel
          {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
          {...(props.onNavigate !== undefined ? { onNavigate: props.onNavigate } : {})}
        />
      </>
    );
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
      {lede}
      {reports.map((report) => (
        <HeartbeatCard
          key={report.runId}
          report={report}
          subscribeToAgentRuns={subscribeToAgentRuns}
          {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
        />
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

function HeartbeatCard(props: {
  report: HeartbeatReport;
  /** PR-R3 — SSE subscription factory shared across cards on
   *  the page. Required by the inline "Refresh now" button. */
  subscribeToAgentRuns: SubscribeToAgentRuns;
  fetchImpl?: typeof fetch;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const { report } = props;
  const instanceLabel = report.instanceName ?? t("reports.heartbeat.noInstance");
  const runIdShort = report.runId.slice(0, 8);
  // Resolve the dispatch domain from any citation in the report.
  // When citations are absent/malformed, suppress the button.
  const dispatchDomain = extractDomainSlugFromHeartbeat(report);

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
            alignItems: "center",
          }}
        >
          {/* PR-R3 — "Refresh now" CTA per heartbeat card. Suppressed
              when no domain can be inferred from the report's
              citations. */}
          {dispatchDomain !== null && (
            <AgentsRunNowButton
              agentSlug="heartbeat"
              domainSlug={dispatchDomain}
              {...(report.instanceName !== null
                ? { instanceSlug: report.instanceName }
                : {})}
              idleLabel={t("agentsRunNow.labels.refreshNow")}
              queuedLabelFormat={t("agentsRunNow.labels.queued")}
              runningLabelFormat={t("agentsRunNow.labels.running")}
              rateLimitedTooltipFormat={t("agentsRunNow.tooltips.rateLimited")}
              subscribeToAgentRuns={props.subscribeToAgentRuns}
              {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
            />
          )}
          {/* Copy the full run UUID to clipboard (Activity runs route is a PR-B addition). */}
          <CopyButton value={report.runId} label={runIdShort} />
          {report.startedAt !== null && (
            <span>{formatDateTime(report.startedAt, i18n.language)}</span>
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

// ─── PR-W8 — Heartbeat diagnostics empty-state panel ─────────────────────────
//
// Renders when the heartbeat list is empty. Walks the precondition chain
// top-to-bottom and surfaces the FIRST missing step with an inline CTA.
// Stops at the first miss so the operator doesn't have to read past the
// step that's actually blocking the chain.
//
// Tone budget: rows use Advisory Amber (`--advisory`) for under-10%
// budget per the design system; the terminal failure-state row uses
// Alert Red. Healthy chain renders Healthy Green with a quiet
// reassurance message ("everything is wired; window has no rows yet").

interface DiagnosticRow {
  readonly tone: "advisory" | "alert" | "healthy";
  readonly label: string;
  readonly cta?: {
    readonly label: string;
    readonly target: Tab;
  };
}

function deriveDiagnosticRow(
  pre: HeartbeatPreconditions,
  t: TFunction,
  locale: string,
): DiagnosticRow {
  if (pre.heartbeatInstanceCount === 0) {
    return {
      tone: "advisory",
      label: t("reports.diagnostics.noInstance.label"),
      cta: { label: t("reports.diagnostics.noInstance.cta"), target: "agents" },
    };
  }
  if (pre.enabledHeartbeatInstanceCount === 0) {
    return {
      tone: "advisory",
      label: t("reports.diagnostics.disabled.label"),
      cta: { label: t("reports.diagnostics.disabled.cta"), target: "agents" },
    };
  }
  if (pre.instancesWithoutOutputChannels > 0) {
    return {
      tone: "advisory",
      label: t("reports.diagnostics.noOutputChannels.label"),
      cta: {
        label: t("reports.diagnostics.noOutputChannels.cta"),
        target: "agents",
      },
    };
  }
  if (pre.mostRecentRun === null) {
    return {
      tone: "advisory",
      label: t("reports.diagnostics.noRuns.label"),
      cta: { label: t("reports.diagnostics.noRuns.cta"), target: "agents" },
    };
  }
  const when = pre.mostRecentRun.startedAt !== null
    ? formatDateTime(pre.mostRecentRun.startedAt, locale)
    : "—";
  // Status discrimination ordering matters (Copilot triage on PR #148):
  //   - `running` (in-progress): the operator should see "run is in
  //     flight", not "output is null" — the output column being null
  //     is expected mid-run, not a failure mode.
  //   - any non-`success` terminal status (`failed`, `timeout`): surface
  //     the actual status string so the operator knows what to look
  //     for in Activity; this beats a generic "no output produced".
  //   - `success` + `outputIsNull`: this is the genuine pathological
  //     case (a Thinker call returned an empty heartbeat payload — the
  //     bug that motivated the diagnostic surface to begin with).
  if (pre.mostRecentRun.status === "running") {
    return {
      tone: "advisory",
      label: t("reports.diagnostics.runInFlight.label", { when }),
      cta: { label: t("reports.diagnostics.runInFlight.cta"), target: "activity" },
    };
  }
  if (pre.mostRecentRun.status !== "success") {
    return {
      tone: "alert",
      label: t("reports.diagnostics.runFailed.label", {
        status: pre.mostRecentRun.status,
        when,
      }),
      cta: { label: t("reports.diagnostics.runFailed.cta"), target: "activity" },
    };
  }
  if (pre.mostRecentRun.outputIsNull) {
    return {
      tone: "alert",
      label: t("reports.diagnostics.outputNull.label", { when }),
      cta: { label: t("reports.diagnostics.outputNull.cta"), target: "activity" },
    };
  }
  // All checks pass — the chain is wired; the visible window just has
  // no rows yet (heartbeat hasn't run recently enough, or the list
  // query filtered to a tighter window).
  return {
    tone: "healthy",
    label: t("reports.diagnostics.healthy"),
  };
}

/** PR-B3 (wave-16) — translate the W8 row tone into the shared
 *  EmptyStatePanel chain status. `alert` → fail (terminal miss),
 *  `advisory` → pending (chain not yet satisfied), `healthy` → pass
 *  (chain is wired; the visible window just has no rows yet). */
function rowToneToChainStatus(
  tone: "advisory" | "alert" | "healthy",
): EmptyStateChainStatus {
  switch (tone) {
    case "alert":
      return "fail";
    case "advisory":
      return "pending";
    case "healthy":
      return "pass";
  }
}

/** PR-B3 (wave-16) — thin wrapper that builds an `EmptyStatePanel`
 *  diagnosticsChain from the first miss the precondition walker
 *  returns. The W8 invariant survives end-to-end: walk top-to-bottom,
 *  surface the FIRST failing step with its inline CTA, and render
 *  the heartbeat counters as the panel body. */
function HeartbeatDiagnosticsPanel(props: {
  fetchImpl?: typeof fetch;
  onNavigate?: (tab: Tab) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const [pre, setPre] = useState<HeartbeatPreconditions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<HeartbeatPreconditions>(
          "/api/admin/heartbeat/preconditions",
          fetchOptsFor(props.fetchImpl),
        );
        setPre(r);
      } catch (err) {
        setError(safeErrorMessage(err));
      }
    })();
  }, []);

  if (error !== null) {
    return (
      <NoticeRow tone="alert">
        <strong>{t("reports.diagnostics.errorPrefix")}</strong> {error}
      </NoticeRow>
    );
  }
  if (pre === null) {
    return <NoticeRow tone="muted">{t("reports.diagnostics.loading")}</NoticeRow>;
  }

  const row = deriveDiagnosticRow(pre, t, i18n.language);
  const navigate = props.onNavigate;
  const cta =
    row.cta !== undefined && navigate !== undefined
      ? {
          label: row.cta.label,
          tone: (row.tone === "alert" ? "ghost" : "primary") as
            | "ghost"
            | "primary",
          onClick: (): void => navigate(row.cta!.target),
        }
      : undefined;

  // Pre-formatted stats line — mirrors the W8 footer band. Kept as
  // mono micro-text so the operator can read "instances: 1 ·
  // enabled: 1 · unbound: 0" without scanning columns.
  const stats = (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--ink-3)",
        letterSpacing: "0.04em",
        display: "inline-flex",
        flexWrap: "wrap",
        gap: 14,
      }}
    >
      <span>instances: {pre.heartbeatInstanceCount}</span>
      <span>enabled: {pre.enabledHeartbeatInstanceCount}</span>
      <span>unbound: {pre.instancesWithoutOutputChannels}</span>
      {pre.mostRecentDispatchedAt !== null ? (
        <span>
          last dispatch:{" "}
          {formatDateTime(pre.mostRecentDispatchedAt, i18n.language)}
        </span>
      ) : null}
    </span>
  );

  return (
    <div style={{ padding: "20px 0" }}>
      <EmptyStatePanel
        title={t("reports.diagnostics.title")}
        body={stats}
        diagnosticsChain={[
          {
            label: row.label,
            status: rowToneToChainStatus(row.tone),
          },
        ]}
        {...(cta !== undefined ? { cta } : {})}
      />
    </div>
  );
}

// ─── Redaction events sub-view ────────────────────────────────────────────────

interface RedactionEventsResponse {
  readonly events: readonly RedactionEvent[];
  readonly total: number;
}

function RedactionEventsView(props: { fetchImpl?: typeof fetch }): JSX.Element {
  const { t, i18n } = useTranslation();
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
      } catch (err) {
        // PR-W8 — surface the real error (see HeartbeatView for rationale).
        setError(safeErrorMessage(err));
      }
    })();
  }, []);

  if (error !== null) {
    return (
      <NoticeRow tone="alert">
        <div>
          <strong>{t("reports.redaction.errorPrefix")}</strong> {error}
        </div>
        <div style={{ marginTop: 4, color: "var(--ink-3)" }}>
          {t("reports.redaction.errorHelp")}
        </div>
      </NoticeRow>
    );
  }
  if (events === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;
  if (events.length === 0) {
    return (
      <NoticeRow tone="muted">{t("reports.redaction.empty")}</NoticeRow>
    );
  }

  const columns: ReadonlyArray<TableColumn<RedactionEvent>> = [
    {
      key: "category",
      label: t("reports.redaction.columns.category"),
      mono: true,
      cellStyle: { fontSize: 12, color: "var(--alert)" },
      render: (event) => event.category,
    },
    {
      key: "pipeline",
      label: t("reports.redaction.columns.pipeline"),
      mono: true,
      cellStyle: { fontSize: 11 },
      render: (event) => event.pipeline,
    },
    {
      key: "guard",
      label: t("reports.redaction.columns.guard"),
      mono: true,
      cellStyle: { fontSize: 11 },
      render: (event) => event.guardSlug,
    },
    {
      key: "matches",
      label: t("reports.redaction.columns.matches"),
      mono: true,
      align: "right",
      cellStyle: { fontSize: 11, color: "var(--ink)" },
      // matchedByteRangesCount — count only, never the ranges.
      render: (event) => event.matchedByteRangesCount,
    },
    {
      key: "failMode",
      label: t("reports.redaction.columns.failMode"),
      mono: true,
      cellStyle: { fontSize: 11, color: "var(--ink-3)" },
      render: (event) => event.failMode,
    },
    {
      key: "time",
      label: t("reports.redaction.columns.time"),
      mono: true,
      cellStyle: { fontSize: 11, color: "var(--ink-3)" },
      render: (event) =>
        event.createdAt !== null
          ? formatTime(event.createdAt, i18n.language)
          : "—",
    },
  ];

  return (
    <Table
      columns={columns}
      rows={events}
      rowKey={(event) => event.id}
    />
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
      {/* PR-A2 — visually-hidden h1 satisfies the
          <main aria-labelledby="opencoo-page-h1"> contract; the
          page identifier is already shown in the W10 breadcrumb.
          SR_ONLY_STYLE is the shared sr-only recipe from Chrome.tsx
          (Copilot triage on PR-A2). */}
      <h1 id="opencoo-page-h1" style={SR_ONLY_STYLE}>
        {t("routes.reports.h1")}
      </h1>
      {/* Editorial lede — PR-C4 (wave-16). The lede itself is
          rendered INSIDE HeartbeatView so it's scoped to the
          heartbeat sub-tab and not visible on Redaction (Copilot
          triage on initial review). */}
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
          <HeartbeatView
            {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
            {...(props.subscribeToAgentRuns !== undefined
              ? { subscribeToAgentRuns: props.subscribeToAgentRuns }
              : {})}
            {...(props.onNavigate !== undefined ? { onNavigate: props.onNavigate } : {})}
          />
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
