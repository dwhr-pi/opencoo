/**
 * Review tab — 6th tab in the management console.
 *
 * Three item types in v0.1 (phase-a):
 *   1. Source-binding review (source bindings needing manual approval)
 *   2. Lint findings (from the most-recent Lint agent run)
 *   3. Surfacer candidates (proposed automation candidates)
 *
 * Two item types explicitly deferred to later phases:
 *   4. Skill candidates (phase-b SkillMiner output)
 *   5. Marketplace updates (phase-c live-fetch loop)
 * Both are called out in the tab's empty-state / footer per the
 * acceptance criteria.
 *
 * Design: mirrors the Activity tab sub-tab pattern from PR-B.
 * Uses StatusPill for status indicators per PR-E.
 * Security: all state-changing actions fire existing PR #28 audited
 * endpoints (THREAT-MODEL §3.13). No new state-machine code.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { LintFindings } from "./Review/LintFindings.js";
import { SourceBindingsReview } from "./Review/SourceBindingsReview.js";
import { SurfacerCandidates } from "./Review/SurfacerCandidates.js";

// ─── Sub-tab type ──────────────────────────────────────────────────────────────

type ReviewTab = "sourceBindings" | "lintFindings" | "candidates";

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface ReviewProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Main component ────────────────────────────────────────────────────────────

export function Review(props: ReviewProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ReviewTab>("sourceBindings");

  const tabs: Array<{ key: ReviewTab; label: string }> = [
    { key: "sourceBindings", label: t("review.tabs.sourceBindings") },
    { key: "lintFindings", label: t("review.tabs.lintFindings") },
    { key: "candidates", label: t("review.tabs.candidates") },
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
      {/* Sub-tab navigation — mirrors Activity.tsx pattern */}
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
      <div style={{ flex: 1, overflowY: "auto", paddingTop: 16 }}>
        {activeTab === "sourceBindings" && (
          props.fetchImpl !== undefined
            ? <SourceBindingsReview fetchImpl={props.fetchImpl} />
            : <SourceBindingsReview />
        )}
        {activeTab === "lintFindings" && (
          props.fetchImpl !== undefined
            ? <LintFindings fetchImpl={props.fetchImpl} />
            : <LintFindings />
        )}
        {activeTab === "candidates" && (
          props.fetchImpl !== undefined
            ? <SurfacerCandidates fetchImpl={props.fetchImpl} />
            : <SurfacerCandidates />
        )}
      </div>

      {/* Footer: upcoming item types — required by acceptance criteria */}
      <div
        style={{
          borderTop: "1px solid var(--rule)",
          padding: "12px 0",
          marginTop: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--ink-3)",
          letterSpacing: "0.06em",
        }}
      >
        {t("review.upcoming")}
      </div>
    </div>
  );
}
