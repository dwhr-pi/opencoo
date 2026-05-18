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
 *
 * PR-W11 design-system audit (accent budgets, compliant):
 *   - `--alert`: auth-failure banner, error counts, failed/DLQ
 *     counters, terminal-fail tone strings — all flagged items.
 *   - `--healthy`: ok session-status indicator only.
 *   - `--advisory`: StatusPill `running` tone (agent layer).
 *   - No `--wiki` on this route — Activity is not compiled-
 *     knowledge chrome.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AgentsRunNowButton } from "../components/AgentsRunNowButton.js";
import { SR_ONLY_STYLE } from "../components/Chrome.js";
import { EmptyStatePanel } from "../components/EmptyStatePanel.js";
import { SchedulerEditor } from "../components/SchedulerEditor.js";
import { Skeleton } from "../components/Skeleton.js";
import { StatusPill, type StatusTone } from "../components/StatusPill.js";
import { useDeferredSkeleton } from "../hooks/useDeferredSkeleton.js";
import {
  createAgentRunsSubscription,
  type SubscribeToAgentRuns,
} from "../lib/agent-runs-subscription.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import { formatDateTime, formatTime } from "../lib/intl-format.js";
import { clearPat } from "../lib/pat-store.js";
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
  /** PR-W4 — `pipeline.intake_failed` event payload threaded onto the
   *  feed entry so the renderer can show binding-id + errorClass chip
   *  + snippet + similar-failure count without re-parsing `text`. */
  readonly intakeFailed?: {
    readonly bindingId: string;
    readonly errorClass: string;
    readonly errorTextSnippet: string;
    readonly intakeId: string;
    /** Count of `pipeline.intake_failed` events that have arrived for
     *  the same `(bindingId, errorClass)` pair within the rolling
     *  1-hour window ending at the time the entry was created. The
     *  renderer surfaces the count so the operator can tell whether
     *  a failure is a one-off or systemic. */
    readonly recentCount: number;
  };
}

/** PR-W4 — bookkeeping for the "similar failures in the last hour"
 *  count rendered on `pipeline.intake_failed` feed entries. The map
 *  is keyed by `JSON.stringify([bindingId, errorClass])` and stores
 *  the rolling 1-hour window of timestamps so we drop entries older
 *  than the window cheaply.
 *
 *  Implementation note — the map lives in the SSE-subscriber
 *  effect closure (NOT React state); each event arrival snapshots
 *  the freshly-computed count INTO the rendered entry, so each
 *  row's count is stable across re-renders of the entry it was
 *  attached to. This avoids a per-event re-render of every prior
 *  entry just because their rolling-window counters slid forward.
 *
 *  The window helper is pure; the structure is small enough
 *  (per-binding+class entries × ≤a few hundred events/hour) that
 *  we don't need a more complex data-structure here. */
const INTAKE_FAILED_WINDOW_MS = 60 * 60 * 1000;

function bumpIntakeFailedCount(
  prev: ReadonlyMap<string, readonly number[]>,
  bindingId: string,
  errorClass: string,
  occurredAtMs: number,
): { readonly map: ReadonlyMap<string, readonly number[]>; readonly count: number } {
  // PR-W4 Copilot triage — key uses JSON.stringify so the
  // composite (bindingId, errorClass) key has no invisible-
  // delimiter bytes (a prior revision used a literal SOH char
  // which was easy to miss in review and could be mangled by
  // editors / formatters / greps). JSON.stringify on a 2-tuple
  // is unambiguous, printable, and survives every transport.
  const key = JSON.stringify([bindingId, errorClass]);
  const cutoff = occurredAtMs - INTAKE_FAILED_WINDOW_MS;
  const prior = prev.get(key) ?? [];
  // Drop entries older than the 1-hour window; append the new one.
  const next = [...prior.filter((t) => t > cutoff), occurredAtMs];
  const map = new Map(prev);
  map.set(key, next);
  return { map, count: next.length };
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
  /** @internal Test seam — per-listener subscribe callable for
   *  the per-agent "Run now" buttons (PR-R3). When omitted, the
   *  route builds ONE shared subscription via
   *  `createAgentRunsSubscription` per pipelines-tab mount and
   *  hands its `subscribe` down. Tests inject a stub directly. */
  readonly subscribeToAgentRuns?: SubscribeToAgentRuns;
  /** PR-W3 — invoked when the SSE feed receives a terminal
   *  `auth_failed` event (the operator's PAT is durably stale).
   *  App.tsx wires this to clear the PAT + flip `authed: false`,
   *  re-rendering the gating PatEntryModal. Default fallback
   *  (when omitted): `clearPat()` + a hard reload, which routes
   *  the user through App.tsx's first-load auth gate. */
  readonly onAuthFailed?: () => void;
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

/** PR-W3 — default re-auth handoff used when no `onAuthFailed`
 *  prop is wired. Clears the stale PAT from sessionStorage and
 *  reloads, which routes the user through App.tsx's first-load
 *  auth gate (the PatEntryModal). Lives at module scope so the
 *  Activity component owns no extra state for the no-prop case. */
function defaultAuthFailedHandler(): void {
  clearPat();
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

function FeedView(props: { onAuthFailed?: () => void }): JSX.Element {
  const { t } = useTranslation();
  const [connected, setConnected] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [entries, setEntries] = useState<FeedEntry[]>([]);

  useEffect(() => {
    const client = openSseClient("/api/admin/events");
    // PR-W4 — per-(bindingId, errorClass) rolling 1-hour timestamp
    // window used to compute the "similar failures (1h)" count
    // surfaced on `pipeline.intake_failed` entries. Held in the
    // effect closure (not React state) because the count is derived
    // freshly each event arrival and embedded into the entry; the
    // entry is what the renderer reads. Resets on component remount.
    let recentMap: ReadonlyMap<string, readonly number[]> = new Map();

    // Connected acknowledgement.
    const offConnected = client.on<{ connectedAt: string }>("connected", () => {
      setConnected(true);
    });

    // PR-W3 — terminal `auth_failed` event from the SSE client. The
    // client itself stops reconnecting; we flip the in-feed indicator
    // to "auth expired" + render the inline alert with a re-auth CTA.
    const offAuth = client.on<{ reason: string }>("auth_failed", () => {
      setAuthExpired(true);
      setConnected(false);
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

    // PR-W4 — `pipeline.intake_failed` events emitted by the
    // compile-worker's catch path (engine-ingestion). The feed entry
    // renders binding id + errorClass chip + scrubbed snippet +
    // similar-failure count via a dedicated render branch keyed by
    // `intakeFailed`. The id is the intakeId so React doesn't
    // collapse multiple failures from the same binding into one row.
    const offIntakeFailed = client.on<{
      bindingId: string;
      errorClass: string;
      errorTextSnippet: string;
      intakeId: string;
      occurredAt: string;
    }>("pipeline.intake_failed", (evt) => {
      const d = evt.data;
      const occurredAtMs = Date.parse(d.occurredAt);
      // `Date.parse` returns NaN on malformed input — fall back to
      // `Date.now()` rather than skipping the event so the operator
      // still sees the failure, just with the local clock as the
      // tie-breaker for the rolling window.
      const windowedAt = Number.isNaN(occurredAtMs)
        ? Date.now()
        : occurredAtMs;
      const bumped = bumpIntakeFailedCount(
        recentMap,
        d.bindingId,
        d.errorClass,
        windowedAt,
      );
      recentMap = bumped.map;
      setEntries((prev) => [
        {
          id: d.intakeId,
          type: "pipeline.intake_failed",
          at: d.occurredAt,
          // `text` is fallback search/scan body for the renderer when
          // the dedicated branch isn't taken (e.g. future telemetry
          // dumps); the branch below renders the structured payload.
          text: `${t("activity.feed.intakeFailed")} binding=${d.bindingId} class=${d.errorClass} — ${d.errorTextSnippet}`,
          tone: "alert" as const,
          intakeFailed: {
            bindingId: d.bindingId,
            errorClass: d.errorClass,
            errorTextSnippet: d.errorTextSnippet,
            intakeId: d.intakeId,
            recentCount: bumped.count,
          },
        },
        ...prev.slice(0, 99),
      ]);
    });

    // The fetch-streaming client does a real connect (PR-Q1); test
    // suites stub `openSseClient` directly, so the readyState here
    // reflects whatever the stub returns. Treat `open` as connected
    // so the LIVE indicator flips immediately when a stub is in use.
    if (client.readyState === "open") {
      setConnected(true);
    }

    return () => {
      offConnected();
      offAuth();
      offRun();
      offDlq();
      offIntakeFailed();
      client.close();
    };
  }, []);

  const handleReauth = props.onAuthFailed ?? defaultAuthFailedHandler;

  // The status-line color picks up `--alert` when the session is
  // terminally unauthenticated — auth-expired IS a blocking state,
  // not a transient "still connecting…". Avoid nested ternaries
  // (CLAUDE.md: prefer explicit branches for >2 conditions).
  let indicatorColor: string;
  let indicatorLabel: string;
  if (authExpired) {
    indicatorColor = "var(--alert)";
    indicatorLabel = t("activity.feed.authExpired");
  } else if (connected) {
    indicatorColor = "var(--healthy)";
    indicatorLabel = t("activity.feed.live");
  } else {
    indicatorColor = "var(--ink-3)";
    indicatorLabel = t("activity.feed.connecting");
  }

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
          color: indicatorColor,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {indicatorLabel}
      </div>
      {/* PR-W3 — terminal auth-failure alert. `--alert` border + title
          (auth expiry IS a destructive/blocking state); informational
          secondary line in `--ink-3`. NO new motion loop — heartbeat
          pulse is reserved for the agent layer. */}
      {authExpired && (
        <div
          role="alert"
          data-testid="sse-auth-failed-alert"
          style={{
            border: "1px solid var(--alert)",
            borderRadius: 6,
            padding: "12px 16px",
            background: "var(--paper-2)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              fontSize: 13,
              color: "var(--alert)",
            }}
          >
            {t("activity.feed.authFailed.title")}
          </div>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              color: "var(--ink-3)",
            }}
          >
            {t("activity.feed.authFailed.body")}
          </div>
          <button
            type="button"
            onClick={handleReauth}
            data-testid="sse-auth-failed-reauth"
            style={{
              alignSelf: "flex-start",
              font: "inherit",
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              padding: "6px 12px",
              border: "1px solid var(--alert)",
              borderRadius: 3,
              background: "var(--paper)",
              color: "var(--alert)",
              cursor: "pointer",
            }}
          >
            {t("activity.feed.authFailed.action")}
          </button>
        </div>
      )}
      {entries.length === 0 && !authExpired && (
        <EmptyStatePanel
          title={t("activity.emptyState.title")}
          body={t("activity.emptyState.body")}
        />
      )}
      {entries.map((e) => {
        // PR-W4 — dedicated render branch for `pipeline.intake_failed`
        // entries. Surface binding id, errorClass chip, scrubbed
        // snippet, and the "similar failures in the last hour" count
        // so the operator can tell at a glance whether the failure
        // is isolated or systemic. Falls back to the generic row
        // when the structured payload is absent (e.g. a future
        // unstructured event we don't yet have a branch for).
        if (e.intakeFailed !== undefined) {
          const f = e.intakeFailed;
          return (
            <div
              key={e.id}
              data-testid={`intake-failed-row-${e.id}`}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--alert)",
                borderLeft: "2px solid var(--alert)",
                paddingLeft: 10,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span style={{ color: "var(--ink-3)" }}>{e.at}</span>
              <StatusPill tone="alert">
                {t("activity.feed.intakeFailed")}
              </StatusPill>
              <span style={{ color: "var(--ink-2)" }}>
                {t("activity.feed.intakeFailedRow")}=
              </span>
              <span>{f.bindingId}</span>
              <span style={{ color: "var(--ink-2)" }}>
                {t("activity.feed.intakeFailedClass")}=
              </span>
              <span>{f.errorClass}</span>
              <span
                data-testid={`intake-failed-count-${f.bindingId}-${f.errorClass}`}
                style={{ color: "var(--ink-3)" }}
                title={t("activity.feed.intakeFailedRecentCount")}
              >
                ({f.recentCount}× / 1h)
              </span>
              <span style={{ color: "var(--ink-2)", flexBasis: "100%" }}>
                {f.errorTextSnippet}
              </span>
            </div>
          );
        }
        return (
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
        );
      })}
    </div>
  );
}

// ─── Runs sub-view ────────────────────────────────────────────────────────────

function RunsView(props: { fetchImpl?: typeof fetch }): JSX.Element {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<readonly AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Wave-16 PR-B1 proof-of-use site. The deferred-skeleton hook
  // hides the placeholder for sub-80ms warm-cache loads so the
  // table doesn't flash, then renders Skeleton.Row x N (one per
  // expected row) at full table width — eliminates the layout
  // reshape when /api/admin/agent-runs lands.
  const showSkeleton = useDeferredSkeleton(rows === null && error === null);

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
  if (rows === null) {
    if (!showSkeleton) {
      // Pre-deferral window (<80ms): keep the surface blank so a
      // fast warm-cache load doesn't paint a skeleton then
      // immediately replace it.
      return <></>;
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
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton.Row key={i} mono cols={6} />
          ))}
        </tbody>
      </table>
    );
  }
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
                {run.startedAt !== null ? formatTime(run.startedAt, i18n.language) : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Scheduled agents card list (PR-R3) ───────────────────────────────────────
// One card per scheduled agent_instance from `/api/admin/scheduler`.
// Each card carries a "Run now" CTA the operator uses to fire the
// agent on demand without waiting for the cron tick.

interface ScheduleEntry {
  readonly instanceId: string;
  readonly definitionSlug: string;
  readonly name: string;
  readonly scheduleCron: string;
  readonly nextFireAt: string | null;
  readonly lastFireAt: string | null;
  readonly domainSlug: string | null;
}

interface ScheduleResponse {
  readonly schedules: readonly ScheduleEntry[];
}

const RUN_NOW_DISPATCHABLE = new Set([
  "heartbeat",
  "lint",
  "surfacer",
  "builder",
]);

function ScheduledAgentsView(props: {
  fetchImpl?: typeof fetch;
  /** @internal Test seam — see HeartbeatView for the same pattern. */
  subscribeToAgentRuns?: SubscribeToAgentRuns;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const [schedules, setSchedules] = useState<readonly ScheduleEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // PR-R6 — which agent INSTANCE currently has the cadence editor
  // expanded. Keyed by `instanceId` (not `definitionSlug`) so two
  // instances of the same agent on the same page each have their
  // own toggle target — clicking one card's "Edit schedule" doesn't
  // open both editors. Only one editor open at a time keeps the
  // column count visually predictable.
  const [editingInstance, setEditingInstance] = useState<string | null>(null);

  const refetch = async (): Promise<void> => {
    try {
      const r = await fetchAdmin<ScheduleResponse>(
        "/api/admin/scheduler",
        fetchOptsFor(props.fetchImpl),
      );
      setSchedules(r.schedules);
      setError(null);
    } catch {
      setError(t("common.error"));
    }
  };

  useEffect(() => {
    void refetch();
  }, []);

  // Stable SSE subscription shared across the cards. ONE
  // underlying client per ScheduledAgentsView mount; each
  // "Run now" button calls `subscription.subscribe(listener)` to
  // add a handler without re-opening the SSE pipe. Tests inject
  // a stub `subscribe` callable directly via the prop.
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

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (schedules === null) {
    return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;
  }
  if (schedules.length === 0) {
    return (
      <NoticeRow tone="muted">{t("agentsRunNow.activityCard.empty")}</NoticeRow>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {schedules.map((s) => {
        // PR-R6 round-2 — split the gating cleanly:
        //   - `editableSlug` (Edit-schedule visibility): agent slug
        //     alone. Editing the cron pattern is independent of
        //     dispatchability — a global Surfacer instance with no
        //     bound domain still has a cron the operator can change.
        //   - `dispatchable` (Run-now visibility): slug + domainSlug.
        //     The Run-now button needs the domain to fire the agent.
        const editableSlug = RUN_NOW_DISPATCHABLE.has(s.definitionSlug)
          ? (s.definitionSlug as
              | "heartbeat"
              | "lint"
              | "surfacer"
              | "builder")
          : null;
        const dispatchable =
          s.domainSlug !== null && editableSlug !== null;
        const slug = dispatchable ? editableSlug : null;
        const editing = editingInstance === s.instanceId;
        // Used twice below (Edit-schedule and Run-now cells) when
        // the agent slug isn't dispatchable — extract once so the
        // grid keeps an identically-styled placeholder cell.
        const dash = (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--ink-3)",
            }}
          >
            —
          </span>
        );
        return (
          <div
            key={s.instanceId}
            style={{
              border: "1px solid var(--rule)",
              borderRadius: 6,
              padding: "16px 20px",
              background: "var(--paper-2)",
              display: "flex",
              flexDirection: "column",
              gap: 0,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto auto auto auto",
                gap: 18,
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
                {s.definitionSlug}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--ink-2)",
                }}
              >
                {s.name}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--ink-3)",
                }}
              >
                {s.scheduleCron}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--ink-3)",
                }}
              >
                {s.lastFireAt !== null
                  ? formatDateTime(s.lastFireAt, i18n.language)
                  : "—"}
              </span>
              {/* PR-R6 — Edit schedule toggle. Default chrome
                  (NO `--alert`); gated on the agent slug ALONE —
                  editing the cron pattern is independent of
                  dispatchability so a global Surfacer instance with
                  no bound domain can still have its cadence
                  flipped. */}
              {editableSlug !== null ? (
                <button
                  type="button"
                  onClick={(): void =>
                    setEditingInstance(editing ? null : s.instanceId)
                  }
                  data-testid={`scheduler-editor-toggle-${s.definitionSlug}`}
                  style={{
                    font: "inherit",
                    fontSize: 12,
                    fontFamily: "var(--font-sans)",
                    padding: "6px 12px",
                    border: "1px solid var(--rule)",
                    borderRadius: 3,
                    background: editing ? "var(--paper-2)" : "var(--paper)",
                    color: "var(--ink-2)",
                    cursor: "pointer",
                  }}
                >
                  {t("schedulerEditor.edit")}
                </button>
              ) : (
                dash
              )}
              {slug !== null && s.domainSlug !== null ? (
                <AgentsRunNowButton
                  agentSlug={slug}
                  domainSlug={s.domainSlug}
                  instanceSlug={s.name}
                  idleLabel={t("agentsRunNow.labels.runNow")}
                  queuedLabelFormat={t("agentsRunNow.labels.queued")}
                  runningLabelFormat={t("agentsRunNow.labels.running")}
                  rateLimitedTooltipFormat={t(
                    "agentsRunNow.tooltips.rateLimited",
                  )}
                  subscribeToAgentRuns={subscribeToAgentRuns}
                  {...(props.fetchImpl !== undefined
                    ? { fetchImpl: props.fetchImpl }
                    : {})}
                />
              ) : (
                dash
              )}
            </div>
            {editing && editableSlug !== null && (
              <SchedulerEditor
                agentSlug={editableSlug}
                currentCron={s.scheduleCron}
                onApplied={(): void => {
                  void refetch();
                }}
                onCancel={(): void => setEditingInstance(null)}
                {...(props.fetchImpl !== undefined
                  ? { fetchImpl: props.fetchImpl }
                  : {})}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Pipelines sub-view ───────────────────────────────────────────────────────

function PipelinesView(props: {
  fetchImpl?: typeof fetch;
  /** @internal Test seam — see ScheduledAgentsView. */
  subscribeToAgentRuns?: SubscribeToAgentRuns;
}): JSX.Element {
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: "16px 0" }}>
      {/* PR-R3 — scheduled-agent cards with per-card "Run now". */}
      <section>
        <h3
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            margin: "0 0 8px 0",
          }}
        >
          {t("agentsRunNow.activityCard.title")}
        </h3>
        <ScheduledAgentsView
          {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
          {...(props.subscribeToAgentRuns !== undefined
            ? { subscribeToAgentRuns: props.subscribeToAgentRuns }
            : {})}
        />
      </section>

      {/* Existing BullMQ queue cards. */}
      <section>
        <h3
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            margin: "0 0 8px 0",
          }}
        >
          {t("activity.tabs.pipelines")}
        </h3>
        {error !== null ? (
          <NoticeRow tone="alert">{error}</NoticeRow>
        ) : pipelines === null ? (
          <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>
        ) : pipelines.length === 0 ? (
          <NoticeRow tone="muted">{t("activity.pipelines.empty")}</NoticeRow>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink)" }}>
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
        )}
      </section>
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
      {/* PR-A2 — visually-hidden h1 satisfies the
          <main aria-labelledby="opencoo-page-h1"> contract without
          duplicating the page identifier already shown in the W10
          breadcrumb. SR_ONLY_STYLE is the shared sr-only recipe
          from Chrome.tsx (Copilot triage on PR-A2). */}
      <h1 id="opencoo-page-h1" style={SR_ONLY_STYLE}>
        {t("routes.activity.h1")}
      </h1>
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
        {activeTab === "feed" && (
          <FeedView
            {...(props.onAuthFailed !== undefined
              ? { onAuthFailed: props.onAuthFailed }
              : {})}
          />
        )}
        {activeTab === "runs" && (
          props.fetchImpl !== undefined
            ? <RunsView fetchImpl={props.fetchImpl} />
            : <RunsView />
        )}
        {activeTab === "pipelines" && (
          <PipelinesView
            {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
            {...(props.subscribeToAgentRuns !== undefined
              ? { subscribeToAgentRuns: props.subscribeToAgentRuns }
              : {})}
          />
        )}
      </div>
    </div>
  );
}
