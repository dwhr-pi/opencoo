/**
 * PromptDebugDrawer — "what was actually sent" right-side
 * drawer for the Prompts UI (PR-W7a, phase-a appendix #15).
 *
 * Fetches the 5 most-recent rows from
 * `GET /api/admin/llm-usage-debug?promptName=…&domainId=…`
 * and renders them as collapsible JetBrains-Mono cards. When
 * `LLM_DEBUG_LOG=1` is not set on the deployment the route
 * returns `{rows: [], hint: ...}` — we render the hint as an
 * empty-state banner so the operator understands the drawer is
 * off-by-default in production.
 *
 * The drawer is a modal-style backdrop + right-aligned card
 * (NOT a system-tray pull-out). Mirrors the LlmPolicy diff
 * dialog's elevation pattern (border + paper-2 background).
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { fetchAdmin } from "../lib/api.js";

interface DebugRow {
  readonly usageId: string;
  readonly createdAt: string;
  readonly promptTextTruncated: string;
  readonly modelSlug: string;
}

interface DebugResponse {
  readonly rows: ReadonlyArray<DebugRow>;
  readonly hint?: string;
}

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(18, 18, 16, 0.32)",
  display: "flex",
  alignItems: "stretch",
  justifyContent: "flex-end",
};

const DRAWER_STYLE: CSSProperties = {
  width: "min(720px, 100vw)",
  height: "100vh",
  background: "var(--paper)",
  borderLeft: "1px solid var(--ink)",
  display: "flex",
  flexDirection: "column",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 20px",
  borderBottom: "1px solid var(--rule)",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-h3)",
  color: "var(--fg-1)",
  margin: 0,
};

const SUBTITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--fg-3)",
  marginTop: 4,
};

const BODY_STYLE: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const EMPTY_BANNER_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--fg-3)",
  border: "1px dashed var(--rule)",
  borderRadius: 3,
  padding: 16,
  textAlign: "center",
};

const CARD_STYLE: CSSProperties = {
  border: "1px solid var(--rule)",
  borderRadius: 3,
  background: "var(--paper-2)",
};

const CARD_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  borderBottom: "1px solid var(--rule)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  color: "var(--fg-3)",
};

const CARD_BODY_STYLE: CSSProperties = {
  padding: 12,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
  lineHeight: "var(--lh-mono)",
  color: "var(--fg-1)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 320,
  overflowY: "auto",
};

const TOGGLE_BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--fg-1)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-micro)",
  letterSpacing: "0.04em",
  cursor: "pointer",
};

export interface PromptDebugDrawerProps {
  readonly promptName: string;
  readonly domainId: string;
  readonly onClose: () => void;
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
}

export function PromptDebugDrawer(
  props: PromptDebugDrawerProps,
): JSX.Element {
  const { t } = useTranslation();
  const [data, setData] = useState<DebugResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<DebugResponse>(
          `/api/admin/llm-usage-debug?promptName=${props.promptName}&domainId=${props.domainId}&limit=5`,
          props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl }
            : {},
        );
        setData(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [props.promptName, props.domainId, props.fetchImpl]);

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="debug-drawer-title"
      style={BACKDROP_STYLE}
      onClick={props.onClose}
    >
      <div
        style={DRAWER_STYLE}
        onClick={(e): void => e.stopPropagation()}
        data-testid="prompt-debug-drawer"
      >
        <div style={HEADER_STYLE}>
          <div>
            <h2 id="debug-drawer-title" style={TITLE_STYLE}>
              {t("prompts.debug.title")}
            </h2>
            <div style={SUBTITLE_STYLE}>
              {props.promptName} · {props.domainId.slice(0, 8)}
            </div>
          </div>
          <Btn variant="ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </Btn>
        </div>
        <div style={BODY_STYLE}>
          {error !== null ? (
            <div style={{ color: "var(--alert)" }} role="alert">
              {error}
            </div>
          ) : data === null ? (
            <div style={{ color: "var(--fg-3)" }}>{t("common.loading")}</div>
          ) : data.hint !== undefined ? (
            <div style={EMPTY_BANNER_STYLE} data-testid="debug-empty-banner">
              {t("prompts.debug.disabledBanner")}
            </div>
          ) : data.rows.length === 0 ? (
            <div style={EMPTY_BANNER_STYLE}>
              {t("prompts.debug.emptyBanner")}
            </div>
          ) : (
            data.rows.map((row) => {
              const isOpen = expanded.has(row.usageId);
              return (
                <div
                  key={row.usageId}
                  style={CARD_STYLE}
                  data-testid={`debug-card-${row.usageId}`}
                >
                  <div style={CARD_HEADER_STYLE}>
                    <span>
                      {row.modelSlug} · {row.createdAt}
                    </span>
                    <button
                      type="button"
                      onClick={(): void => toggle(row.usageId)}
                      style={TOGGLE_BTN_STYLE}
                    >
                      {isOpen
                        ? t("prompts.debug.collapse")
                        : t("prompts.debug.expand")}
                    </button>
                  </div>
                  {isOpen ? (
                    <div style={CARD_BODY_STYLE}>{row.promptTextTruncated}</div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
