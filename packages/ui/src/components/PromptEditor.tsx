/**
 * PromptEditor — right-pane editor for the Prompts tab
 * (PR-W7a, phase-a appendix #15).
 *
 * Single-prompt edit surface: domain dropdown, locale tabs, the
 * textarea, the version chips, the staleness badge, and the
 * action row (Preview, Revert, "What was sent" drawer button).
 * The route holds the network state and preview lifecycle; this
 * component is purely presentational + emits intents through
 * the four callback props.
 *
 * Design-system bindings (per CLAUDE.md hard-nos):
 *   - mono font for the body textarea (paths/IDs/code-like)
 *   - sans for buttons + helper text
 *   - JetBrains Mono pinned via `var(--font-mono)`
 *   - wiki-teal chips for the baseline-version pill (compiled-
 *     knowledge chrome semantics)
 *   - advisory-amber border on the staleness badge (agent-layer
 *     drift signal)
 *   - alert-red ONLY on the Revert button text
 */
import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import type { Domain } from "../types.js";

type Locale = "en" | "pl";

interface PromptResponse {
  readonly name: string;
  readonly locale: Locale;
  readonly source: "baseline" | "override";
  readonly body: string;
  readonly version: string;
  readonly baselineVersion?: string;
  readonly isStale?: boolean;
}

export interface PromptEditorProps {
  readonly promptName: string;
  readonly domainId: string;
  readonly domains: ReadonlyArray<Domain>;
  readonly locale: Locale;
  readonly current: PromptResponse;
  readonly proposedBody: string;
  readonly onDomainChange: (id: string) => void;
  readonly onLocaleChange: (locale: Locale) => void;
  readonly onProposedBodyChange: (body: string) => void;
  readonly onPreview: () => void;
  readonly onRevert: () => void;
  readonly onOpenDebug: () => void;
  readonly previewError: string | null;
  readonly drift: {
    readonly previewBaselineVersion: string;
    readonly currentBaselineVersion: string;
  } | null;
  readonly onRefork: () => void;
  readonly appliedNotice: string | null;
}

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const PROMPT_NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-h3)",
  color: "var(--fg-1)",
  margin: 0,
};

const CHIPS_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const BASELINE_CHIP_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--wiki)",
  border: "1px solid var(--wiki)",
  background: "color-mix(in oklch, var(--wiki) 6%, var(--paper))",
  padding: "2px 8px",
  borderRadius: 3,
};

const SOURCE_CHIP_BASE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  padding: "2px 8px",
  borderRadius: 3,
  border: "1px solid var(--rule)",
};

const STALE_BADGE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--advisory-ink)",
  border: "1px solid var(--advisory-ink)",
  background: "color-mix(in oklch, var(--advisory) 14%, var(--paper))",
  padding: "2px 8px",
  borderRadius: 3,
};

const SELECTOR_ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(180px, 1fr) minmax(140px, max-content)",
  gap: 12,
  alignItems: "end",
};

const FIELD_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--fg-3)",
};

const SELECT_STYLE: CSSProperties = {
  width: "100%",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  padding: "6px 8px",
  border: "1px solid var(--rule)",
  borderRadius: 3,
  background: "var(--paper)",
  color: "var(--fg-1)",
};

const LOCALE_TABS_STYLE: CSSProperties = {
  display: "inline-flex",
  border: "1px solid var(--rule)",
  borderRadius: 3,
  overflow: "hidden",
};

const LOCALE_TAB_BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  padding: "4px 10px",
  background: "transparent",
  color: "var(--fg-1)",
  border: "none",
  cursor: "pointer",
};

const LOCALE_TAB_ACTIVE_STYLE: CSSProperties = {
  ...LOCALE_TAB_BTN_STYLE,
  background: "var(--paper-2)",
  fontWeight: 600,
};

const TEXTAREA_STYLE: CSSProperties = {
  width: "100%",
  minHeight: 360,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  border: "1px solid var(--rule)",
  borderRadius: 3,
  padding: 12,
  background: "var(--paper)",
  color: "var(--fg-1)",
  resize: "vertical",
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const ACTION_ROW_RIGHT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const TOAST_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--healthy)",
};

const ERROR_BANNER_STYLE: CSSProperties = {
  border: "1px solid var(--alert)",
  background: "color-mix(in oklch, var(--alert) 8%, var(--paper))",
  padding: "var(--space-3) var(--space-4)",
  borderRadius: 3,
  color: "var(--alert)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
};

const DRIFT_BANNER_STYLE: CSSProperties = {
  border: "1px solid var(--alert)",
  background: "color-mix(in oklch, var(--alert) 10%, var(--paper))",
  padding: "var(--space-3) var(--space-4)",
  borderRadius: 3,
  color: "var(--alert)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const REVERT_BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-small)",
  background: "transparent",
  color: "var(--alert)",
  border: "1px solid var(--alert)",
  borderRadius: 3,
  padding: "6px 10px",
  cursor: "pointer",
};

export function PromptEditor(props: PromptEditorProps): JSX.Element {
  const { t } = useTranslation();
  const isOverride = props.current.source === "override";
  const sourceChipStyle: CSSProperties = useMemo(() => {
    if (isOverride) {
      return {
        ...SOURCE_CHIP_BASE_STYLE,
        color: "var(--wiki)",
        borderColor: "var(--wiki)",
        background: "color-mix(in oklch, var(--wiki) 6%, var(--paper))",
      };
    }
    return SOURCE_CHIP_BASE_STYLE;
  }, [isOverride]);

  const dirty = props.proposedBody !== props.current.body;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={HEADER_STYLE}>
        <h2 style={PROMPT_NAME_STYLE}>{props.promptName}</h2>
        <div style={CHIPS_ROW_STYLE}>
          <span style={BASELINE_CHIP_STYLE} data-testid="baseline-version-chip">
            {t("prompts.editor.baseline")} v
            {props.current.baselineVersion ?? props.current.version}
          </span>
          <span
            style={sourceChipStyle}
            data-testid={`source-chip-${props.current.source}`}
          >
            {t(`prompts.editor.source.${props.current.source}`)}
            {isOverride ? ` v${props.current.version}` : null}
          </span>
          {props.current.isStale === true ? (
            <span style={STALE_BADGE_STYLE} data-testid="stale-badge">
              {t("prompts.editor.staleBadge", {
                baseline: props.current.baselineVersion,
              })}
            </span>
          ) : null}
        </div>
      </div>

      <div style={SELECTOR_ROW_STYLE}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={FIELD_LABEL_STYLE}>{t("prompts.editor.domain")}</span>
          <select
            data-testid="prompt-domain-picker"
            value={props.domainId}
            onChange={(e): void => props.onDomainChange(e.target.value)}
            style={SELECT_STYLE}
          >
            {props.domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.slug}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={FIELD_LABEL_STYLE}>{t("prompts.editor.locale")}</span>
          <div style={LOCALE_TABS_STYLE} role="tablist">
            {(["en", "pl"] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={props.locale === l}
                data-testid={`locale-tab-${l}`}
                onClick={(): void => props.onLocaleChange(l)}
                style={
                  props.locale === l
                    ? LOCALE_TAB_ACTIVE_STYLE
                    : LOCALE_TAB_BTN_STYLE
                }
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <textarea
        data-testid="prompt-body-textarea"
        value={props.proposedBody}
        onChange={(e): void => props.onProposedBodyChange(e.target.value)}
        style={TEXTAREA_STYLE}
        spellCheck={false}
      />

      {props.drift !== null ? (
        <div style={DRIFT_BANNER_STYLE} role="alert" data-testid="drift-banner">
          <span>
            {t("prompts.editor.driftBanner", {
              preview: props.drift.previewBaselineVersion,
              current: props.drift.currentBaselineVersion,
            })}
          </span>
          <div>
            <Btn variant="primary" onClick={props.onRefork}>
              {t("prompts.editor.refork")}
            </Btn>
          </div>
        </div>
      ) : null}
      {props.previewError !== null && props.drift === null ? (
        <div style={ERROR_BANNER_STYLE} role="alert" data-testid="preview-error">
          {props.previewError}
        </div>
      ) : null}
      {props.appliedNotice !== null ? (
        <div style={TOAST_STYLE} data-testid="applied-notice">
          {props.appliedNotice}
        </div>
      ) : null}

      <div style={ACTION_ROW_STYLE}>
        <button
          type="button"
          data-testid="open-debug-drawer"
          onClick={props.onOpenDebug}
          style={{
            background: "transparent",
            border: "1px solid var(--rule)",
            borderRadius: 3,
            padding: "6px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-mono)",
            color: "var(--fg-1)",
            cursor: "pointer",
          }}
        >
          {t("prompts.editor.openDebugDrawer")}
        </button>
        <div style={ACTION_ROW_RIGHT_STYLE}>
          {isOverride ? (
            <button
              type="button"
              data-testid="revert-btn"
              onClick={props.onRevert}
              style={REVERT_BTN_STYLE}
            >
              {t("prompts.editor.revert")}
            </button>
          ) : null}
          <Btn
            variant="primary"
            disabled={!dirty}
            onClick={props.onPreview}
          >
            {t("prompts.editor.save")}
          </Btn>
        </div>
      </div>
    </div>
  );
}
