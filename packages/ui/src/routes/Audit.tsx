/**
 * Audit log viewer (PR-R4, phase-a appendix #10).
 *
 * Read-only consumer of `GET /api/admin/audit-log`. The route is
 * already paginated + sanitised at write time; R4 surfaces it.
 *
 * Filters are applied CLIENT-SIDE on the rows from page 1 — the
 * admin endpoint exposes only `?limit=&offset=`. If the audit
 * table grows beyond what client-side filtering handles, that is
 * a v0.2 concern (server-side action / actor / resource filters).
 *
 * Design constraints (CLAUDE.md + THREAT-MODEL):
 *   - All metadata shown here was sanitised by the writer
 *     (`writeAuditLog` excludes plaintext / secret bytes). The UI
 *     never re-decodes credentials and never logs the rendered
 *     payload server-side.
 *   - JetBrains Mono for the JSON payload + UUIDs.
 *   - Tone tokens: --healthy for create/update happy-path
 *     actions; --alert for delete/disable; --ink-3 for muted
 *     timestamps + empty state. No --advisory (audit-log is
 *     not an agent-layer surface).
 *   - No motion loops on this page (heartbeat-pulse is reserved
 *     for the agent layer).
 *   - Pagination defaults to a SAFE limit (50) — no `?limit=∞`
 *     footgun.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Table, type TableColumn } from "../components/Table.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";

const PAGE_LIMIT = 50;

/** Truncation cap for the inline JSON view. Anything larger gets a
 *  `Show full` toggle so the operator opts into the full payload. */
const JSON_TRUNCATE_BYTES = 50_000;
const JSON_TRUNCATE_KB_LABEL = 50;

// ─── Shared style tokens ──────────────────────────────────────────────────────

/** The repeated mono uppercase micro-label used for column headers,
 *  filter "from/to" lead-ins, the metadata section header, and the
 *  pagination page indicator. */
const MICRO_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuditLogRow {
  readonly id: string;
  readonly action: string;
  readonly userId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

interface AuditLogResponse {
  readonly rows: readonly AuditLogRow[];
}

export interface AuditProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Metadata keys that name "the resource this row acted on", in
 *  priority order. Used both for the table's resource cell summary
 *  and the resource free-text filter. */
const RESOURCE_KEYS = ["slug", "binding_id", "domain_id", "id"] as const;

/** Action-suffix tone buckets. The full audit-log action allowlist
 *  lives in `engine-self-operating/src/admin-api/audit-log.ts`;
 *  anything not listed here falls through to the neutral default. */
const ALERT_SUFFIXES: ReadonlySet<string> = new Set([
  "delete",
  "disable",
  "reject",
  "skip",
]);
const HEALTHY_SUFFIXES: ReadonlySet<string> = new Set([
  "create",
  "update",
  "apply",
  "approve",
  "accept",
  "acknowledge",
  "rotate",
  "credentials_rotate",
  "config_update",
]);

function actionTone(action: string): "healthy" | "alert" | "neutral" {
  const suffix = action.slice(action.lastIndexOf(".") + 1);
  if (ALERT_SUFFIXES.has(suffix)) return "alert";
  if (HEALTHY_SUFFIXES.has(suffix)) return "healthy";
  return "neutral";
}

function actionColor(action: string): string {
  switch (actionTone(action)) {
    case "healthy":
      return "var(--healthy)";
    case "alert":
      return "var(--alert)";
    default:
      return "var(--ink)";
  }
}

/** Read a top-level metadata key as a non-empty string, or null. */
function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const v = metadata[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The most-relevant single-line summary of the row's metadata —
 *  pick the first key that exists in priority order. Returns
 *  `null` when no recognised key is present. */
function resourceSummary(metadata: Record<string, unknown>): string | null {
  for (const k of RESOURCE_KEYS) {
    const v = metadataString(metadata, k);
    if (v !== null) return v;
  }
  return null;
}

function actorLabel(row: AuditLogRow): string {
  const username = metadataString(row.metadata, "caller_username");
  if (username !== null) return username;
  if (row.userId !== null) {
    // Last 12 chars are enough to disambiguate an operator's actions
    // without dumping the full UUID into a list cell.
    return `…${row.userId.slice(-12)}`;
  }
  return "—";
}

/** Pretty-printed JSON used by the row drill-down. Stable indent
 *  so the operator can copy it verbatim into a ticket. */
function formatMetadata(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata, null, 2);
}

/** Render an ISO-8601 timestamp as `YYYY-MM-DD HH:mm:ss UTC`. The
 *  audit log is consumed across operator timezones during cross-team
 *  triage; locale-dependent strings (`toLocaleString()`) make it hard
 *  to correlate rows from two operators' screens. UTC is the lingua
 *  franca for ops timestamps. */
function formatIsoUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

// ─── Column definitions for the shared Table primitive ──────────────────────

/** Build the audit-table column descriptor list. `t` is threaded
 *  through so labels resolve under the current i18n locale; the
 *  cell renderers cover the four open-coded columns the page had
 *  before PR-W9. */
function auditColumns(
  t: (key: string) => string,
): ReadonlyArray<TableColumn<AuditLogRow>> {
  return [
    {
      key: "time",
      label: t("audit.columns.time"),
      mono: true,
      cellStyle: { fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap" },
      render: (row) => formatIsoUtc(row.createdAt),
    },
    {
      key: "action",
      label: t("audit.columns.action"),
      // action stays in font-sans (not mono) so it visually
      // distinguishes the noun from the surrounding mono cells.
      cellStyle: (row) => ({ color: actionColor(row.action) }),
      render: (row) => row.action,
    },
    {
      key: "actor",
      label: t("audit.columns.actor"),
      mono: true,
      render: (row) => actorLabel(row),
    },
    {
      key: "resource",
      label: t("audit.columns.resource"),
      mono: true,
      cellStyle: (row) => ({
        color:
          resourceSummary(row.metadata) !== null ? "var(--ink)" : "var(--ink-3)",
      }),
      render: (row) => resourceSummary(row.metadata) ?? "—",
    },
  ];
}

// ─── Filter state ─────────────────────────────────────────────────────────────

interface FilterState {
  readonly actions: ReadonlySet<string>; // empty = no constraint
  readonly actor: string;
  readonly resource: string;
  readonly fromDate: string; // ISO yyyy-mm-dd or ""
  readonly toDate: string;
}

const EMPTY_FILTERS: FilterState = {
  actions: new Set(),
  actor: "",
  resource: "",
  fromDate: "",
  toDate: "",
};

function actorMatches(row: AuditLogRow, needle: string): boolean {
  const username = metadataString(row.metadata, "caller_username") ?? "";
  if (username.toLowerCase().includes(needle.toLowerCase())) return true;
  return row.userId !== null && row.userId === needle;
}

function resourceMatches(row: AuditLogRow, needle: string): boolean {
  const lower = needle.toLowerCase();
  for (const k of RESOURCE_KEYS) {
    const v = metadataString(row.metadata, k);
    if (v !== null && v.toLowerCase().includes(lower)) return true;
  }
  return false;
}

function rowMatchesFilters(row: AuditLogRow, f: FilterState): boolean {
  if (f.actions.size > 0 && !f.actions.has(row.action)) return false;
  if (f.actor.length > 0 && !actorMatches(row, f.actor)) return false;
  if (f.resource.length > 0 && !resourceMatches(row, f.resource)) return false;

  if (f.fromDate.length > 0 || f.toDate.length > 0) {
    const ts = new Date(row.createdAt).getTime();
    if (
      f.fromDate.length > 0 &&
      ts < new Date(`${f.fromDate}T00:00:00Z`).getTime()
    ) {
      return false;
    }
    // Inclusive of the end date — operators expect "May 1 → May 7"
    // to include events on May 7.
    if (
      f.toDate.length > 0 &&
      ts > new Date(`${f.toDate}T23:59:59.999Z`).getTime()
    ) {
      return false;
    }
  }

  return true;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

interface ActionMultiSelectProps {
  readonly options: readonly string[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (action: string) => void;
}

function ActionMultiSelect(props: ActionMultiSelectProps): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label =
    props.selected.size === 0
      ? t("audit.filters.actionAll")
      : t("audit.filters.actionSelected", { count: props.selected.size, n: props.selected.size });

  return (
    <div style={{ position: "relative" }}>
      <button
        data-testid="audit-filter-action"
        type="button"
        onClick={(): void => setOpen((v) => !v)}
        style={{
          font: "inherit",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          padding: "6px 10px",
          background: "var(--paper)",
          color: "var(--ink)",
          border: "1px solid var(--rule)",
          borderRadius: 4,
          cursor: "pointer",
          minWidth: 160,
          textAlign: "left",
        }}
      >
        {label}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 10,
            background: "var(--paper)",
            border: "1px solid var(--rule)",
            borderRadius: 4,
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            maxHeight: 280,
            overflowY: "auto",
            minWidth: 240,
          }}
        >
          {props.options.length === 0 ? (
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                color: "var(--ink-3)",
                padding: "4px 8px",
              }}
            >
              {t("audit.empty")}
            </span>
          ) : (
            props.options.map((opt) => {
              const checked = props.selected.has(opt);
              return (
                <label
                  key={opt}
                  data-testid={`audit-filter-action-option-${opt}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: actionColor(opt),
                    cursor: "pointer",
                    background: checked ? "var(--paper-2)" : "transparent",
                    border: "1px solid",
                    borderColor: checked ? "var(--rule)" : "transparent",
                    borderRadius: 3,
                  }}
                >
                  {/* The checkbox is the actual interactive control —
                   *  natively focusable + Space-toggleable. The wrapping
                   *  <label> forwards clicks-on-text to the checkbox,
                   *  which fires onChange exactly once (no double toggle).
                   *  Removed `pointerEvents: none` + `tabIndex: -1` so
                   *  keyboard users can Tab into the dropdown. */}
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(): void => props.onToggle(opt)}
                  />
                  <span>{opt}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

interface FilterBarProps {
  readonly filters: FilterState;
  readonly onFiltersChange: (next: FilterState) => void;
  readonly actionOptions: readonly string[];
}

function FilterBar(props: FilterBarProps): JSX.Element {
  const { t } = useTranslation();

  const toggleAction = (action: string): void => {
    const next = new Set(props.filters.actions);
    if (next.has(action)) next.delete(action);
    else next.add(action);
    props.onFiltersChange({ ...props.filters, actions: next });
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: "12px 0",
        borderBottom: "1px solid var(--rule)",
        flexWrap: "wrap",
      }}
    >
      <ActionMultiSelect
        options={props.actionOptions}
        selected={props.filters.actions}
        onToggle={toggleAction}
      />
      <input
        type="text"
        placeholder={t("audit.filters.actorPlaceholder")}
        value={props.filters.actor}
        onChange={(e): void =>
          props.onFiltersChange({ ...props.filters, actor: e.target.value })
        }
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          padding: "6px 10px",
          background: "var(--paper)",
          color: "var(--ink)",
          border: "1px solid var(--rule)",
          borderRadius: 4,
          minWidth: 240,
        }}
      />
      <input
        type="text"
        placeholder={t("audit.filters.resourcePlaceholder")}
        value={props.filters.resource}
        onChange={(e): void =>
          props.onFiltersChange({ ...props.filters, resource: e.target.value })
        }
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          padding: "6px 10px",
          background: "var(--paper)",
          color: "var(--ink)",
          border: "1px solid var(--rule)",
          borderRadius: 4,
          minWidth: 220,
        }}
      />
      <span style={MICRO_LABEL_STYLE}>{t("audit.filters.from")}</span>
      <input
        data-testid="audit-filter-from"
        type="date"
        value={props.filters.fromDate}
        onChange={(e): void =>
          props.onFiltersChange({ ...props.filters, fromDate: e.target.value })
        }
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          padding: "5px 8px",
          background: "var(--paper)",
          color: "var(--ink)",
          border: "1px solid var(--rule)",
          borderRadius: 4,
        }}
      />
      <span style={MICRO_LABEL_STYLE}>{t("audit.filters.to")}</span>
      <input
        data-testid="audit-filter-to"
        type="date"
        value={props.filters.toDate}
        onChange={(e): void =>
          props.onFiltersChange({ ...props.filters, toDate: e.target.value })
        }
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          padding: "5px 8px",
          background: "var(--paper)",
          color: "var(--ink)",
          border: "1px solid var(--rule)",
          borderRadius: 4,
        }}
      />
      <button
        type="button"
        onClick={(): void => props.onFiltersChange(EMPTY_FILTERS)}
        style={{
          marginLeft: "auto",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          padding: "5px 10px",
          background: "transparent",
          color: "var(--ink-2)",
          border: "1px solid var(--rule)",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        {t("audit.filters.clear")}
      </button>
    </div>
  );
}

interface RowDetailProps {
  readonly row: AuditLogRow;
}

type CopyState = "idle" | "success" | "error";

function RowDetail(props: RowDetailProps): JSX.Element {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [showFull, setShowFull] = useState(false);
  // Holds the 2s revert timer so it can be cleared on rapid re-clicks
  // (no state-reset race) AND on unmount (no setState-on-unmounted
  // warning if the operator collapses the row before it fires).
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fullJson = useMemo(() => formatMetadata(props.row.metadata), [props.row.metadata]);
  const overflow = fullJson.length > JSON_TRUNCATE_BYTES;
  const visibleJson = overflow && !showFull ? fullJson.slice(0, JSON_TRUNCATE_BYTES) : fullJson;

  const handleCopy = useCallback((): void => {
    // `navigator.clipboard.writeText` rejects when the page is
    // served over HTTP (non-secure context), when the user denies
    // clipboard permission, or when the API is missing entirely
    // (older browsers). Without this catch the rejection bubbled
    // up unhandled and the operator got no feedback that the copy
    // didn't take.
    if (copyTimeoutRef.current !== null) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    void (async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(fullJson);
        setCopyState("success");
      } catch {
        setCopyState("error");
      }
      copyTimeoutRef.current = setTimeout((): void => {
        setCopyState("idle");
        copyTimeoutRef.current = null;
      }, 2000);
    })();
  }, [fullJson]);

  useEffect((): (() => void) => {
    return (): void => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  const copyLabel =
    copyState === "success"
      ? t("audit.row.copied")
      : copyState === "error"
        ? t("audit.row.copyFailed")
        : t("audit.row.copy");
  const copyColor =
    copyState === "success"
      ? "var(--healthy)"
      : copyState === "error"
        ? "var(--alert)"
        : "var(--ink-2)";

  return (
    <div
      data-testid={`audit-row-${props.row.id}-detail`}
      style={{
        padding: "10px 16px 16px 16px",
        background: "var(--paper-2)",
        borderTop: "1px solid var(--rule)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span style={MICRO_LABEL_STYLE}>
          {t("audit.row.metadata")}
          {overflow && (
            <span style={{ marginLeft: 8, color: "var(--ink-3)" }}>
              · {t("audit.row.truncatedNote", { kb: JSON_TRUNCATE_KB_LABEL })}
            </span>
          )}
        </span>
        <span style={{ display: "inline-flex", gap: 6 }}>
          {overflow && (
            <button
              type="button"
              onClick={(): void => setShowFull((v) => !v)}
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 11,
                padding: "2px 8px",
                background: "var(--paper)",
                color: "var(--ink-2)",
                border: "1px solid var(--rule)",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              {showFull ? t("audit.row.showLess") : t("audit.row.showFull")}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              padding: "2px 8px",
              background: "var(--paper)",
              color: copyColor,
              border: "1px solid var(--rule)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            {copyLabel}
          </button>
        </span>
      </div>
      <pre
        data-testid={`audit-row-${props.row.id}-json`}
        style={{
          margin: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--ink)",
          background: "var(--paper)",
          border: "1px solid var(--rule)",
          borderRadius: 4,
          padding: 12,
          overflow: "auto",
          maxHeight: 480,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {visibleJson}
      </pre>
      {(props.row.sourceIp !== null || props.row.userAgent !== null) && (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            gap: 16,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--ink-3)",
          }}
        >
          {props.row.sourceIp !== null && (
            <span>{t("audit.row.ipPrefix")} {props.row.sourceIp}</span>
          )}
          {props.row.userAgent !== null && (
            <span>{t("audit.row.uaPrefix")} {props.row.userAgent}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function Audit(props: AuditProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly AuditLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Race-safety: rapid offset changes (Next-Next-Next) or unmount
    // mid-flight can let an earlier request resolve AFTER a later
    // one, overwriting `rows`/`error` with stale data. The
    // `cancelled` flag short-circuits the state writes for any
    // request whose effect has already been torn down.
    // (`fetchAdmin` doesn't currently take a `signal`, so a true
    // network abort isn't available — the cancelled flag is enough
    // to prevent the visible state-write race.)
    let cancelled = false;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        const r = await fetchAdmin<AuditLogResponse>(
          `/api/admin/audit-log?limit=${PAGE_LIMIT}&offset=${offset}`,
          fetchOptsFor(props.fetchImpl),
        );
        if (!cancelled) setRows(r.rows);
      } catch {
        if (!cancelled) setError(t("audit.loadError"));
      }
    })();
    return (): void => {
      cancelled = true;
    };
    // Re-fetch on offset change. `props.fetchImpl` is a test seam,
    // intentionally not part of the dep list (changing fetchImpl
    // mid-life would force an extra round-trip in test rigs).
  }, [offset]);

  // The action multi-select's options are derived from whatever
  // rows the page has loaded — server doesn't have an "actions"
  // index endpoint and won't get one in R4 (no backend changes).
  const actionOptions = useMemo(() => {
    if (rows === null) return [];
    return Array.from(new Set(rows.map((r) => r.action))).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [rows]);

  const filtered = useMemo(() => {
    if (rows === null) return [];
    return rows.filter((r) => rowMatchesFilters(r, filters));
  }, [rows, filters]);

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pageNum = Math.floor(offset / PAGE_LIMIT) + 1;
  const hasNext = rows !== null && rows.length === PAGE_LIMIT;
  const hasPrev = offset > 0;

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
      <div
        style={{
          padding: "16px 0 8px",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            fontSize: "var(--fs-body)",
            color: "var(--ink)",
          }}
        >
          {t("audit.title")}
        </span>
        <span
          title={t("audit.scopeAside")}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.04em",
            color: "var(--ink-3)",
            cursor: "help",
            borderBottom: "1px dotted var(--ink-3)",
          }}
        >
          {t("audit.subtitle")}
        </span>
      </div>

      <FilterBar
        filters={filters}
        onFiltersChange={setFilters}
        actionOptions={actionOptions}
      />

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {error !== null && <NoticeRow tone="alert">{error}</NoticeRow>}
        {error === null && rows === null && (
          <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>
        )}
        {error === null && rows !== null && filtered.length === 0 && (
          <NoticeRow tone="muted">{t("audit.empty")}</NoticeRow>
        )}
        {error === null && rows !== null && filtered.length > 0 && (
          <Table
            columns={auditColumns(t)}
            rows={filtered}
            rowKey={(row) => row.id}
            rowAttrs={(row) => {
              const isOpen = expanded.has(row.id);
              const detailRowId = `audit-row-${row.id}-detail`;
              const onKeyDown = (
                e: ReactKeyboardEvent<HTMLTableRowElement>,
              ): void => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleExpand(row.id);
                }
              };
              return {
                "data-testid": `audit-row-${row.id}`,
                role: "button",
                tabIndex: 0,
                "aria-expanded": isOpen,
                "aria-controls": detailRowId,
                onClick: (): void => toggleExpand(row.id),
                onKeyDown,
                style: {
                  // Row a11y: the <tr> is the click target so it
                  // also needs role=button + tabIndex + keyboard
                  // handler + aria-expanded/-controls. Mirrors the
                  // per-cell pattern used in Sources.tsx (PR-R1
                  // fix-up), adapted to <tr> since we control the
                  // table layout here. The detail row below carries
                  // its own --rule so this one drops it when open
                  // to avoid a double-rule artefact.
                  borderBottom: isOpen ? "none" : "1px solid var(--rule)",
                  cursor: "pointer",
                  background: isOpen ? "var(--paper-2)" : "transparent",
                },
              };
            }}
            renderAfterRow={(row) => {
              if (!expanded.has(row.id)) return null;
              const detailRowId = `audit-row-${row.id}-detail`;
              return (
                <tr
                  id={detailRowId}
                  role="region"
                  style={{ borderBottom: "1px solid var(--rule)" }}
                >
                  <td colSpan={4} style={{ padding: 0 }}>
                    <RowDetail row={row} />
                  </td>
                </tr>
              );
            }}
          />
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 0",
          borderTop: "1px solid var(--rule)",
        }}
      >
        <span style={MICRO_LABEL_STYLE}>
          {t("audit.pagination.page", { page: pageNum })}
        </span>
        <span style={{ display: "inline-flex", gap: 8 }}>
          <button
            type="button"
            disabled={!hasPrev}
            onClick={(): void => setOffset(Math.max(0, offset - PAGE_LIMIT))}
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              padding: "5px 10px",
              background: "var(--paper)",
              color: hasPrev ? "var(--ink)" : "var(--ink-3)",
              border: "1px solid var(--rule)",
              borderRadius: 4,
              cursor: hasPrev ? "pointer" : "not-allowed",
              opacity: hasPrev ? 1 : 0.55,
            }}
          >
            {t("audit.pagination.prev")}
          </button>
          <button
            type="button"
            disabled={!hasNext}
            onClick={(): void => setOffset(offset + PAGE_LIMIT)}
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              padding: "5px 10px",
              background: "var(--paper)",
              color: hasNext ? "var(--ink)" : "var(--ink-3)",
              border: "1px solid var(--rule)",
              borderRadius: 4,
              cursor: hasNext ? "pointer" : "not-allowed",
              opacity: hasNext ? 1 : 0.55,
            }}
          >
            {t("audit.pagination.next")}
          </button>
        </span>
      </div>
    </div>
  );
}
