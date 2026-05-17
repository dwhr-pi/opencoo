/**
 * Cost analytics dashboard (PR-R5, phase-a appendix #10).
 *
 * Read-only consumer of `GET /api/admin/cost-summary`. Surfaces:
 *   - This-month total + projected EOM (header card).
 *   - Burn-down per domain (one bar per domain, threshold-coloured).
 *   - Stacked-segment bar by tier (thinker/worker/light split).
 *   - Top-buckets table for the chosen groupBy (domain | model |
 *     tier | agent), capped at the server's MAX_BUCKETS = 100.
 *     Rows are sorted DESC by totalUsd server-side; column-header
 *     click sorting is deferred to v0.2.
 *
 * The route fires TWO requests on load:
 *   1. The user-controlled groupBy (default `domain`) → drives the
 *      bottom table + header total.
 *   2. groupBy=tier → drives the stacked-segment chart so the tier
 *      view is always available regardless of the user's bottom-
 *      table grouping.
 *
 * Design constraints (CLAUDE.md + design_system/README.md):
 *   - JetBrains Mono for cost values, token counts, and period
 *     dates. Geist for headers and table chrome.
 *   - --healthy under 50% of cap; --advisory 80-100% (one of the
 *     few approved operator-advisory uses); --alert >= 100% with
 *     a "paused" badge. --ink-3 for no-cap-set domains.
 *   - Heartbeat-pulse glyph on the "live spending" indicator only
 *     (the ONE motion loop in the app).
 *   - No gradients. No drop shadows. Border + paper-shift only.
 *   - No spinners. No emoji. Lowercase opencoo in any prose.
 */
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Card } from "../components/Card.js";
import { GlyphRingWithDot } from "../components/Glyph.js";
import { Table, type TableColumn } from "../components/Table.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type Period = "day" | "week" | "month";
type GroupBy = "domain" | "model" | "tier" | "agent";

interface CostBucket {
  readonly key: string;
  readonly totalUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly runs: number;
}

interface BudgetEntry {
  readonly domainSlug: string;
  readonly capUsd: number | null;
  readonly usedUsd: number;
  readonly projectedEomUsd: number;
  readonly paused: boolean;
}

interface CostSummary {
  readonly totalUsd: number;
  readonly period: Period;
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly byBucket: readonly CostBucket[];
  readonly budgetState: readonly BudgetEntry[];
}

export interface CostProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Style tokens ─────────────────────────────────────────────────────────────

const MICRO_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};

// Chip styles split border into individual long-hands so toggling
// the active state via spread doesn't mix `border` shorthand with
// `borderColor` (React warns otherwise).
const CHIP_STYLE_BASE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  padding: "5px 10px",
  background: "var(--paper)",
  borderStyle: "solid",
  borderWidth: 1,
  borderColor: "var(--rule)",
  borderRadius: 4,
  cursor: "pointer",
  color: "var(--ink-2)",
};

const CHIP_STYLE_ACTIVE: CSSProperties = {
  ...CHIP_STYLE_BASE,
  background: "var(--paper-2)",
  color: "var(--ink)",
};

// Background for each tier-split segment. Order matches the
// canonical thinker → worker → light render order. Distinguishing
// segments by paper-shift (no gradients per CLAUDE.md hard-no).
const TIER_SEGMENT_BACKGROUNDS = ["var(--ink-2)", "var(--ink-3)", "var(--ink-4)"] as const;

const MAX_BUCKETS = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a USD amount with two decimals + thousands separators.
 *  JetBrains Mono in render so columns align in the bottom table.
 *  The number formatting follows the operator's UI locale (en →
 *  `1,234.56`, pl → `1 234,56`) so it lines up with the rest of
 *  the chrome; currency stays USD because the engine bills in USD
 *  and the dashboard's semantics are always USD. */
function formatUsd(amount: number, locale: string): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}$${abs.toLocaleString(intlLocale(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatTokens(n: number, locale: string): string {
  return n.toLocaleString(intlLocale(locale));
}

/** Map i18next's locale codes (`en`, `pl`) onto Intl BCP-47 tags
 *  with grouping conventions the operator expects. Unknown locales
 *  fall back to en-US so a missing translation never produces
 *  malformed numbers. */
function intlLocale(language: string): string {
  if (language.toLowerCase().startsWith("pl")) return "pl-PL";
  return "en-US";
}

/** Burn-down threshold tone. The strict ranges from PR-R5 spec:
 *   - <50%      → healthy (green)
 *   - 50%-80%   → in-between (still healthy at the lower edge,
 *                 transitions to advisory at the upper); v0.1
 *                 keeps it healthy throughout to avoid a fourth
 *                 colour band.
 *   - 80%-100%  → advisory (amber) — operator advisory budget.
 *   - >=100%    → alert (red); paused badge surfaces if backend
 *                 says paused=true (no domain_llm_budgets table
 *                 yet, so always false in v0.1).
 *  Domains with no cap render a fourth no-cap muted state. */
type BarTone = "healthy" | "advisory" | "alert" | "no-cap";

function barToneFor(entry: BudgetEntry): BarTone {
  if (entry.capUsd === null) return "no-cap";
  if (entry.usedUsd >= entry.capUsd) return "alert";
  const pct = entry.usedUsd / entry.capUsd;
  if (pct >= 0.8) return "advisory";
  return "healthy";
}

function barColorFor(tone: BarTone): string {
  switch (tone) {
    case "healthy":
      return "var(--healthy)";
    case "advisory":
      return "var(--advisory)";
    case "alert":
      return "var(--alert)";
    case "no-cap":
      return "var(--ink-3)";
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ChipGroupProps<T extends string> {
  readonly label: string;
  readonly options: readonly { readonly key: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  /** `data-testid` prefix for the chips so tests can target each
   *  one without coupling to label text. The chip's testid becomes
   *  `${testIdPrefix}-${optionKey}`. */
  readonly testIdPrefix: string;
}

function ChipGroup<T extends string>(props: ChipGroupProps<T>): JSX.Element {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={MICRO_LABEL_STYLE}>{props.label}</span>
      <span style={{ display: "inline-flex", gap: 4 }}>
        {props.options.map((opt) => {
          const active = opt.key === props.value;
          return (
            <button
              key={opt.key}
              type="button"
              data-testid={`${props.testIdPrefix}-${opt.key}`}
              onClick={(): void => props.onChange(opt.key)}
              style={active ? CHIP_STYLE_ACTIVE : CHIP_STYLE_BASE}
            >
              {opt.label}
            </button>
          );
        })}
      </span>
    </span>
  );
}

interface HeaderCardProps {
  readonly summary: CostSummary | null;
}

function HeaderCard(props: HeaderCardProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const totalUsd = props.summary?.totalUsd ?? 0;
  // Summed projection + cap across every domain. The header card's
  // "projected month-end" is the global aggregate; per-domain
  // projection is shown in the burn-down list below. `anyCap` is
  // true when at least one domain has a cap, gating the "vs cap"
  // numeric label vs. a "no cap set" muted label.
  const budgetState = props.summary?.budgetState ?? [];
  const projectedEom = budgetState.reduce((acc, b) => acc + b.projectedEomUsd, 0);
  const summedCap = budgetState.reduce((acc, b) => acc + (b.capUsd ?? 0), 0);
  const anyCap = budgetState.some((b) => b.capUsd !== null);

  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 24,
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              ...MICRO_LABEL_STYLE,
            }}
          >
            {/* The heartbeat-pulse glyph — the ONE motion loop in
             *  the system. Reserved for the agent / live layer
             *  (CLAUDE.md design-system). The "live spending"
             *  indicator is the only place it appears on this
             *  page, signalling that the total is real-time. */}
            <span
              className="heartbeat-glyph"
              style={{ color: "var(--advisory)", display: "inline-flex" }}
              aria-hidden
            >
              <GlyphRingWithDot size={12} />
            </span>
            <span>{t("cost.header.live")}</span>
          </div>
          <div
            data-testid="cost-total"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 32,
              fontWeight: 500,
              letterSpacing: "-0.005em",
              color: "var(--ink)",
              marginTop: 4,
            }}
          >
            {formatUsd(totalUsd, locale)}
          </div>
          <div
            style={{
              ...MICRO_LABEL_STYLE,
              marginTop: 4,
            }}
          >
            {t("cost.header.thisMonth")}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
          }}
        >
          <span style={MICRO_LABEL_STYLE}>{t("cost.header.projectedEom")}</span>
          <span
            data-testid="cost-projection"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 20,
              color: "var(--ink-2)",
            }}
          >
            {formatUsd(projectedEom, locale)}
          </span>
          <span style={MICRO_LABEL_STYLE}>
            {anyCap
              ? `${t("cost.header.vsCap")} ${formatUsd(summedCap, locale)}`
              : t("cost.header.noCap")}
          </span>
        </div>
      </div>
    </Card>
  );
}

interface BurnDownCardProps {
  readonly summary: CostSummary | null;
}

function BurnDownCard(props: BurnDownCardProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const entries = props.summary?.budgetState ?? [];
  return (
    <Card
      title={t("cost.burndown.title")}
      subtitle={t("cost.burndown.subtitle")}
    >
      {entries.length === 0 ? (
        <div style={{ ...MICRO_LABEL_STYLE, padding: "8px 0" }}>
          {t("cost.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {entries.map((entry) => {
            const tone = barToneFor(entry);
            const color = barColorFor(tone);
            const widthPct =
              entry.capUsd === null
                ? 0
                : Math.min(
                    100,
                    Math.max(0, (entry.usedUsd / entry.capUsd) * 100),
                  );
            return (
              <div key={entry.domainSlug}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 13,
                      color:
                        tone === "no-cap" ? "var(--ink-3)" : "var(--ink)",
                    }}
                  >
                    {entry.domainSlug}
                  </span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "baseline",
                      gap: 8,
                    }}
                  >
                    {tone === "no-cap" ? (
                      <span
                        data-testid={`cost-budget-no-cap-${entry.domainSlug}`}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          color: "var(--ink-3)",
                        }}
                      >
                        {t("cost.burndown.noCap")}
                      </span>
                    ) : null}
                    {entry.paused ? (
                      <span
                        data-testid={`cost-budget-paused-${entry.domainSlug}`}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "var(--alert)",
                          padding: "2px 6px",
                          border: "1px solid var(--alert)",
                          borderRadius: 3,
                        }}
                      >
                        {t("cost.burndown.paused")}
                      </span>
                    ) : null}
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--ink-2)",
                      }}
                    >
                      {formatUsd(entry.usedUsd, locale)}
                      {entry.capUsd !== null
                        ? ` / ${formatUsd(entry.capUsd, locale)}`
                        : ""}
                    </span>
                  </span>
                </div>
                <div
                  style={{
                    background: "var(--paper-2)",
                    border: "1px solid var(--rule)",
                    borderRadius: 3,
                    height: 10,
                    overflow: "hidden",
                  }}
                >
                  {/* Inline style references the design-system
                   *  var by name (not literal hex) so the bar's
                   *  tone tracks any future palette tweak. The
                   *  test asserts on the var presence — keep
                   *  this as `var(...)` not a literal. */}
                  <div
                    data-testid={`cost-budget-bar-${entry.domainSlug}`}
                    style={{
                      width: `${widthPct}%`,
                      height: "100%",
                      background: color,
                      // No transition — the bar is a snapshot, not an
                      // animated load. (Motion-loop budget is reserved
                      // for the heartbeat-pulse on the live indicator.)
                    }}
                  />
                </div>
                <div
                  style={{
                    ...MICRO_LABEL_STYLE,
                    marginTop: 4,
                  }}
                >
                  {t("cost.header.projectedEom")}: {formatUsd(entry.projectedEomUsd, locale)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

interface TierSplitCardProps {
  readonly tierBuckets: readonly CostBucket[] | null;
}

function TierSplitCard(props: TierSplitCardProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const buckets = props.tierBuckets;
  // Render order is canonical (thinker → worker → light) regardless
  // of input order. Missing tiers render zero-width segments so
  // a 100/0/0 split still shows the labels.
  const ordered: ReadonlyArray<{ key: "thinker" | "worker" | "light"; usd: number }> = [
    {
      key: "thinker",
      usd: buckets?.find((b) => b.key === "thinker")?.totalUsd ?? 0,
    },
    {
      key: "worker",
      usd: buckets?.find((b) => b.key === "worker")?.totalUsd ?? 0,
    },
    {
      key: "light",
      usd: buckets?.find((b) => b.key === "light")?.totalUsd ?? 0,
    },
  ];
  const total = ordered.reduce((acc, t2) => acc + t2.usd, 0);

  return (
    <Card
      title={t("cost.tierSplit.title")}
      subtitle={t("cost.tierSplit.subtitle")}
    >
      {total === 0 ? (
        <div style={{ ...MICRO_LABEL_STYLE, padding: "8px 0" }}>
          {t("cost.empty")}
        </div>
      ) : (
        <div>
          <div
            style={{
              display: "flex",
              border: "1px solid var(--rule)",
              borderRadius: 3,
              overflow: "hidden",
              height: 18,
              background: "var(--paper-2)",
            }}
          >
            {ordered.map((seg, i) => {
              // Safe: guarded by `total === 0` early-return above.
              const pct = (seg.usd / total) * 100;
              return (
                <div
                  key={seg.key}
                  data-testid={`cost-tier-segment-${seg.key}`}
                  title={`${seg.key}: ${formatUsd(seg.usd, locale)} (${pct.toFixed(1)}%)`}
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: TIER_SEGMENT_BACKGROUNDS[i],
                    borderRight:
                      i < ordered.length - 1 ? "1px solid var(--paper)" : "none",
                  }}
                />
              );
            })}
          </div>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            {ordered.map((seg) => (
              <span
                key={seg.key}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--ink-2)",
                }}
              >
                <span style={MICRO_LABEL_STYLE}>
                  {t(`cost.tierSplit.${seg.key}`)}
                </span>
                <span>{formatUsd(seg.usd, locale)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

interface BucketTableProps {
  readonly groupBy: GroupBy;
  readonly buckets: readonly CostBucket[];
}

function BucketTable(props: BucketTableProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  // Rows are sorted DESC by totalUsd server-side; that's the
  // operator's expected default. Column-header click sorting is
  // deferred to v0.2 — the columns render plain `<th>` here.
  const truncated = props.buckets.length >= MAX_BUCKETS;

  // `data-groupby` carries the active grouping for tests + future
  // per-grouping styling (e.g. a `groupBy === "agent"` branch may
  // want to render `domain.slug × agent.slug` composite rows). It
  // also keeps `groupBy` in the public contract of `BucketTable`
  // without an extra hidden node.
  const columns: ReadonlyArray<TableColumn<CostBucket>> = [
    {
      key: "key",
      label: t("cost.table.key"),
      mono: true,
      cellStyle: { color: "var(--ink)" },
      render: (bucket) => bucket.key,
    },
    {
      key: "totalUsd",
      label: t("cost.table.totalUsd"),
      mono: true,
      align: "right",
      cellStyle: { color: "var(--ink)" },
      render: (bucket) => formatUsd(bucket.totalUsd, locale),
    },
    {
      key: "tokensIn",
      label: t("cost.table.tokensIn"),
      mono: true,
      align: "right",
      render: (bucket) => formatTokens(bucket.tokensIn, locale),
    },
    {
      key: "tokensOut",
      label: t("cost.table.tokensOut"),
      mono: true,
      align: "right",
      render: (bucket) => formatTokens(bucket.tokensOut, locale),
    },
    {
      key: "runs",
      label: t("cost.table.runs"),
      mono: true,
      align: "right",
      render: (bucket) => bucket.runs,
    },
  ];

  return (
    <Card title={t("cost.table.title")}>
      <Table
        columns={columns}
        rows={props.buckets}
        rowKey={(bucket) => bucket.key}
        testId="cost-bucket-table"
        dataAttrs={{ "data-groupby": props.groupBy }}
      />
      {truncated ? (
        <div style={{ ...MICRO_LABEL_STYLE, marginTop: 8 }}>
          {t("cost.table.truncated", { n: MAX_BUCKETS })}
        </div>
      ) : null}
    </Card>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function Cost(props: CostProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("month");
  const [groupBy, setGroupBy] = useState<GroupBy>("domain");
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [tierSummary, setTierSummary] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setTierSummary(null);
    setError(null);
    void (async () => {
      try {
        const [primary, tier] = await Promise.all([
          fetchAdmin<CostSummary>(
            `/api/admin/cost-summary?period=${period}&groupBy=${groupBy}`,
            fetchOptsFor(props.fetchImpl),
          ),
          fetchAdmin<CostSummary>(
            `/api/admin/cost-summary?period=${period}&groupBy=tier`,
            fetchOptsFor(props.fetchImpl),
          ),
        ]);
        if (!cancelled) {
          setSummary(primary);
          setTierSummary(tier);
        }
      } catch {
        if (!cancelled) setError(t("cost.loadError"));
      }
    })();
    return (): void => {
      cancelled = true;
    };
    // `props.fetchImpl` is a stable test seam — intentionally
    // omitted from the dep list to avoid an extra round-trip.
  }, [period, groupBy]);

  const periodOptions = useMemo(
    () => [
      { key: "day" as const, label: t("cost.selectors.day") },
      { key: "week" as const, label: t("cost.selectors.week") },
      { key: "month" as const, label: t("cost.selectors.month") },
    ],
    [t],
  );

  const groupByOptions = useMemo(
    () => [
      { key: "domain" as const, label: t("cost.selectors.domain") },
      { key: "model" as const, label: t("cost.selectors.model") },
      { key: "tier" as const, label: t("cost.selectors.tier") },
      { key: "agent" as const, label: t("cost.selectors.agent") },
    ],
    [t],
  );

  // While the very first fetch is in flight (`summary === null`
  // with no error), render a minimal text-only loading state
  // instead of the full dashboard with empty cards. Text only —
  // no spinner — because the heartbeat-pulse glyph on the live-
  // spending indicator is the ONLY motion loop in the app
  // (CLAUDE.md design-system, "no spinners").
  if (summary === null && error === null) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "0 24px 24px",
          fontFamily: "var(--font-sans)",
          gap: 16,
          overflow: "auto",
        }}
      >
        <div style={{ padding: "16px 0 8px" }}>
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              fontSize: "var(--fs-body)",
              color: "var(--ink)",
            }}
          >
            {t("cost.title")}
          </span>
        </div>
        <Card>
          <div
            data-testid="cost-loading"
            style={{
              color: "var(--ink-3)",
              padding: 32,
              textAlign: "center",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
            }}
          >
            {t("cost.loading")}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        padding: "0 24px 24px",
        fontFamily: "var(--font-sans)",
        gap: 16,
        overflow: "auto",
      }}
    >
      <div
        style={{
          padding: "16px 0 8px",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 500,
              fontSize: "var(--fs-body)",
              color: "var(--ink)",
            }}
          >
            {t("cost.title")}
          </span>
          <span style={MICRO_LABEL_STYLE}>{t("cost.subtitle")}</span>
        </div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <ChipGroup
            label={t("cost.selectors.period")}
            options={periodOptions}
            value={period}
            onChange={setPeriod}
            testIdPrefix="cost-period"
          />
          <ChipGroup
            label={t("cost.selectors.groupBy")}
            options={groupByOptions}
            value={groupBy}
            onChange={setGroupBy}
            testIdPrefix="cost-groupBy"
          />
        </div>
      </div>

      {error !== null ? (
        <NoticeRow tone="alert">{error}</NoticeRow>
      ) : (
        <>
          <HeaderCard summary={summary} />
          <BurnDownCard summary={summary} />
          <TierSplitCard tierBuckets={tierSummary?.byBucket ?? null} />
          <BucketTable groupBy={groupBy} buckets={summary?.byBucket ?? []} />
        </>
      )}
    </div>
  );
}

function NoticeRow(props: {
  readonly tone: "alert" | "muted";
  readonly children: ReactNode;
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
