/**
 * DiffPreviewDialog — sovereignty-diff confirm flow (PR 29 /
 * plan #131; UX token-binding spec).
 *
 * Old-vs-new LlmPolicy side-by-side before commit. Confirm
 * button is Advisory-Amber (LLM-policy edits cross the agent
 * layer's data path); additions Wiki-Teal (committing to a new
 * compiled-knowledge route), deletions Alert-Red. 5-min
 * countdown forces attentiveness; under 30s the timer hue
 * shifts to `--alert`.
 *
 * The server is canonical for the diff (PR 28 sovereignty-token
 * primitives). The UI:
 *   1. Receives a `SovereigntyDiffPreview` from the parent
 *      (already fetched from `/api/admin/domains/:id/llm-policy/preview`).
 *   2. Renders side-by-side `current` / `proposed` panels with
 *      explicit `+ ` / `- ` line markers (not bg-only — a11y).
 *   3. On Apply, calls the parent-supplied callback which POSTs
 *      to `/apply` with `{token, proposed}`.
 *   4. On expiry, surfaces an explanation prompting re-preview.
 *
 * Hard-nos honored:
 *   - additions in `--wiki` only (NOT `--healthy` — that's the
 *     compiled-state semantic).
 *   - deletions in `--alert` only on the diff lines; the
 *     confirm button itself is NEVER red (would read as
 *     Cancel).
 *   - solid color-mix tints on diff backgrounds (no gradients).
 *   - NO pulse / blink on the timer (the only motion loop is
 *     the heartbeat-on-operate-glyph).
 *   - NO spinner during commit (label-swap to `committing…`
 *     in mono and disable).
 *   - timer color transition is one-shot 240ms color-only fade.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type {
  LineDiffEntry,
  PromptOverridePreview,
  SovereigntyDiffPreview,
} from "../types.js";

const SUB_30S_THRESHOLD = 30;

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(18, 18, 16, 0.32)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "var(--space-5)",
};

const DIALOG_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 920,
  background: "var(--paper)",
  border: "1px solid var(--ink)",
  borderRadius: "var(--radius-xl)",
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-4)",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-h2)",
  lineHeight: "var(--lh-h2)",
  letterSpacing: "var(--tr-h2)",
  color: "var(--fg-1)",
  margin: 0,
};

const SUBTITLE_STYLE: CSSProperties = {
  marginTop: "var(--space-1)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--fg-3)",
};

const TIMER_BAR_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-2) var(--space-3)",
};

const TIMER_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const PANELS_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "var(--space-4)",
};

const PANEL_STYLE: CSSProperties = {
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-l)",
  padding: "var(--space-4)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  maxHeight: 360,
  overflow: "auto",
};

const PANEL_HEADER_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  fontSize: "var(--fs-micro)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--fg-3)",
};

const DIFF_LINE_BASE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--fg-1)",
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--space-2)",
  paddingInline: "var(--space-2)",
  paddingBlock: 2,
};

const DIFF_PATH_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--fg-3)",
  marginBottom: 2,
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

const CANCEL_BTN_STYLE: CSSProperties = {
  background: "transparent",
  color: "var(--fg-1)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
};

const CONFIRM_BTN_BASE_STYLE: CSSProperties = {
  background: "var(--advisory)",
  color: "var(--ink)",
  border: "1px solid var(--advisory-ink)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  cursor: "pointer",
};

const ERROR_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  color: "var(--alert)",
  margin: 0,
};

export interface DiffPreviewDialogProps {
  /** Either the key-level diff (LLM-policy) or the line-level
   *  diff (prompt-override, PR-W7a). The dialog branches on
   *  the entry shape at render time so it stays drop-in for
   *  both call sites. */
  readonly preview: SovereigntyDiffPreview | PromptOverridePreview;
  readonly onApply: () => Promise<void>;
  readonly onCancel: () => void;
  readonly errorMessage?: string | null;
  /** Optional sub-title override — defaults to the LLM-policy
   *  copy ("current → proposed"). Prompt-override callers
   *  pass the prompt-name + locale for at-a-glance context. */
  readonly subtitle?: string;
  /** @internal Test seam — defaults to `Date.now()`. */
  readonly now?: () => number;
}

function isLineDiff(
  entry: SovereigntyDiffPreview["diff"][number] | LineDiffEntry,
): entry is LineDiffEntry {
  return typeof (entry as LineDiffEntry).op === "string";
}

/** Format a value for display inside a diff line — JSON-stringify
 *  but elide outer quotes for primitives so `"openai"` reads as
 *  `openai`. Objects + arrays render as JSON. */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function DiffPreviewDialog(
  props: DiffPreviewDialogProps,
): JSX.Element {
  const { t } = useTranslation();
  // `now` is held in a ref so it doesn't trigger the interval-effect
  // teardown/rebuild every second. Without the ref, the default
  // `() => Date.now()` would be a new function on every render and
  // the effect's dep array would re-fire each tick (the tick itself
  // calls setState, which re-renders). Tests pass an explicit
  // deterministic clock; production reads the ref.
  const nowRef = useRef<() => number>(props.now ?? ((): number => Date.now()));
  nowRef.current = props.now ?? nowRef.current;
  const expiresAt = props.preview.expiresAt;
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor((expiresAt - nowRef.current()) / 1000)),
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const tick = (): void => {
      const remaining = Math.max(
        0,
        Math.floor((expiresAt - nowRef.current()) / 1000),
      );
      setSecondsLeft(remaining);
    };
    const id = window.setInterval(tick, 1000);
    return (): void => window.clearInterval(id);
  }, [expiresAt]);

  const expired = secondsLeft === 0;
  const timerColor: string = expired
    ? "var(--alert)"
    : secondsLeft < SUB_30S_THRESHOLD
      ? "var(--alert)"
      : "var(--fg-1)";

  const onApplyClick = async (): Promise<void> => {
    if (expired) return;
    setSubmitting(true);
    try {
      await props.onApply();
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDisabled =
    expired || submitting || props.preview.diff.length === 0;

  const confirmStyle: CSSProperties = {
    ...CONFIRM_BTN_BASE_STYLE,
    ...(submitting
      ? {
          background: "var(--ink-3)",
          borderColor: "var(--ink-3)",
          color: "var(--paper)",
          cursor: "not-allowed",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-mono)",
          fontWeight: 600,
        }
      : confirmDisabled
        ? { opacity: 0.55, cursor: "not-allowed" }
        : {}),
  };

  // Per-line tones — `--wiki` for additions, `--alert` for
  // removals. Background is a 10–12% color-mix tint of the
  // accent on paper (NOT a gradient).
  const addLineStyle: CSSProperties = {
    ...DIFF_LINE_BASE_STYLE,
    background: "color-mix(in oklch, var(--wiki) 12%, var(--paper))",
    borderLeft: "2px solid var(--wiki)",
  };
  const delLineStyle: CSSProperties = {
    ...DIFF_LINE_BASE_STYLE,
    background: "color-mix(in oklch, var(--alert) 10%, var(--paper))",
    borderLeft: "2px solid var(--alert)",
  };

  const formattedSeconds = expired
    ? t("llmPolicy.timerExpired")
    : `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;

  return (
    <div
      role="dialog"
      aria-labelledby="diff-dialog-title"
      aria-modal="true"
      style={BACKDROP_STYLE}
    >
      <div className="opencoo-dialog-enter" style={DIALOG_STYLE}>
        <div style={HEADER_STYLE}>
          <div>
            <h2 id="diff-dialog-title" style={TITLE_STYLE}>
              {t("llmPolicy.diffTitle")}
            </h2>
            <div style={SUBTITLE_STYLE}>
              {props.subtitle ?? t("llmPolicy.diffSubtitle")}
            </div>
          </div>
          <div style={TIMER_BAR_STYLE} data-testid="diff-timer-bar">
            <span style={TIMER_LABEL_STYLE}>
              {t("llmPolicy.timerLabel")}
            </span>
            <span
              data-testid="diff-countdown"
              className="opencoo-timer-color"
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                fontSize: "var(--fs-mono)",
                color: timerColor,
              }}
            >
              {formattedSeconds}
            </span>
          </div>
        </div>
        <div data-testid="diff-list" style={PANELS_STYLE}>
          <div style={PANEL_STYLE}>
            <div style={PANEL_HEADER_STYLE}>{t("llmPolicy.panelCurrent")}</div>
            {props.preview.diff.length === 0 ? (
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-micro)",
                  color: "var(--fg-3)",
                }}
              >
                {t("llmPolicy.noChanges")}
              </div>
            ) : (
              props.preview.diff.map((entry, idx) => {
                if (isLineDiff(entry)) {
                  // Line-level diff: render only `same`/`del`
                  // rows in the current panel. `add` lines
                  // don't exist in `before` so they're
                  // omitted here.
                  if (entry.op === "add") return null;
                  const lineStyle =
                    entry.op === "del"
                      ? delLineStyle
                      : DIFF_LINE_BASE_STYLE;
                  const marker = entry.op === "del" ? "- " : "  ";
                  const markerColor =
                    entry.op === "del" ? "var(--alert)" : "var(--fg-3)";
                  return (
                    <div
                      key={`cur-${entry.op}-${idx}`}
                      data-testid={`line-cur-${entry.op}-${idx}`}
                      style={lineStyle}
                    >
                      <span style={{ color: markerColor }}>{marker}</span>
                      <span>{entry.line}</span>
                    </div>
                  );
                }
                return (
                  <div key={`cur-${entry.path}-${idx}`}>
                    <div style={DIFF_PATH_STYLE}>{entry.path}</div>
                    <div style={delLineStyle}>
                      <span style={{ color: "var(--alert)" }}>{"- "}</span>
                      <span>{formatValue(entry.before)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div style={PANEL_STYLE}>
            <div style={PANEL_HEADER_STYLE}>{t("llmPolicy.panelProposed")}</div>
            {props.preview.diff.length === 0 ? (
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-micro)",
                  color: "var(--fg-3)",
                }}
              >
                {t("llmPolicy.noChanges")}
              </div>
            ) : (
              props.preview.diff.map((entry, idx) => {
                if (isLineDiff(entry)) {
                  if (entry.op === "del") return null;
                  const lineStyle =
                    entry.op === "add"
                      ? addLineStyle
                      : DIFF_LINE_BASE_STYLE;
                  const marker = entry.op === "add" ? "+ " : "  ";
                  const markerColor =
                    entry.op === "add" ? "var(--wiki)" : "var(--fg-3)";
                  return (
                    <div
                      key={`pro-${entry.op}-${idx}`}
                      data-testid={`line-pro-${entry.op}-${idx}`}
                      style={lineStyle}
                    >
                      <span style={{ color: markerColor }}>{marker}</span>
                      <span>{entry.line}</span>
                    </div>
                  );
                }
                return (
                  <div key={`pro-${entry.path}-${idx}`}>
                    <div style={DIFF_PATH_STYLE}>{entry.path}</div>
                    <div style={addLineStyle}>
                      <span style={{ color: "var(--wiki)" }}>{"+ "}</span>
                      <span>{formatValue(entry.after)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        {props.errorMessage !== null && props.errorMessage !== undefined ? (
          <p data-testid="diff-error" style={ERROR_TEXT_STYLE}>
            {props.errorMessage}
          </p>
        ) : null}
        <div style={FOOTER_STYLE}>
          <button type="button" style={CANCEL_BTN_STYLE} onClick={props.onCancel}>
            {t("llmPolicy.cancel")}
          </button>
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={(): void => {
              void onApplyClick();
            }}
            style={confirmStyle}
          >
            {submitting ? t("llmPolicy.committing") : t("llmPolicy.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
