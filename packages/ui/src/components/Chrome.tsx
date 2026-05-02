/**
 * Sidebar + TopBar — migrated from
 * design_system/ui_kits/management-console/Chrome.jsx with
 * the v0.1 admin-API tabs (Domains, Sources, LLM Policy,
 * Prompts).
 *
 * The sidebar is the canonical surface for app navigation.
 * The TopBar surfaces:
 *   - the current tab title,
 *   - the resolved username,
 *   - a logout button.
 *
 * Both surfaces reference design-system CSS vars only — no
 * color literals, no second motion loop. (CLAUDE.md "Design
 * system" hard-nos.)
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { Tab } from "../types.js";

import { Btn } from "./Btn.js";

interface SidebarProps {
  readonly tab: Tab;
  readonly setTab: (t: Tab) => void;
}

const TABS: ReadonlyArray<{ key: Tab; labelKey: string }> = [
  { key: "domains", labelKey: "nav.domains" },
  { key: "sources", labelKey: "nav.sources" },
  { key: "llmPolicy", labelKey: "nav.llmPolicy" },
  { key: "prompts", labelKey: "nav.prompts" },
  // Phase-a appendix #4 PR-B: Activity tab (5th tab).
  { key: "activity", labelKey: "nav.activity" },
  // Phase-a appendix #4 PR-D: Reports tab (7th tab, after Review=6th from PR-C).
  // Merge order: PR-C adds 'review' before this entry; after rebase the array
  // order will be [..., 'activity', 'review', 'reports'].
  { key: "reports", labelKey: "nav.reports" },
];

export function Sidebar(props: SidebarProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <nav
      style={{
        width: 240,
        background: "var(--paper-2)",
        borderRight: "1px solid var(--rule)",
        padding: "22px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 8px 18px",
          borderBottom: "1px solid var(--rule)",
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            letterSpacing: "-0.005em",
            color: "var(--ink)",
          }}
        >
          {t("app.title")}
        </span>
      </div>
      {TABS.map((item) => {
        const active = props.tab === item.key;
        return (
          <button
            key={item.key}
            onClick={(): void => props.setTab(item.key)}
            style={{
              textAlign: "left",
              font: "inherit",
              fontSize: 13,
              padding: "8px 10px",
              background: active ? "var(--paper)" : "transparent",
              border: "1px solid",
              borderColor: active ? "var(--rule)" : "transparent",
              borderRadius: 4,
              color: active ? "var(--ink)" : "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            {t(item.labelKey)}
          </button>
        );
      })}
      <div
        style={{
          marginTop: "auto",
          paddingTop: 12,
          borderTop: "1px solid var(--rule)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--ink-3)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {t("app.version")} · {t("app.tagline")}
      </div>
    </nav>
  );
}

interface TopBarProps {
  readonly title: ReactNode;
  readonly username: string | null;
  readonly onLogout: () => void;
}

export function TopBar(props: TopBarProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 24px",
        borderBottom: "1px solid var(--rule)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--ink-3)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      <span>
        <b style={{ color: "var(--ink)", fontWeight: 500 }}>{props.title}</b>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {props.username !== null ? (
          <span>{t("auth.loggedInAs", { username: props.username })}</span>
        ) : null}
        <Btn variant="ghost" onClick={props.onLogout}>
          {t("nav.logout")}
        </Btn>
      </span>
    </div>
  );
}
