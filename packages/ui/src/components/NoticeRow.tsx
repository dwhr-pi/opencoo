/**
 * NoticeRow — single-line muted/alert message used by list views to
 * render their loading, empty, and error states.
 *
 * Tone:
 *   - "muted"  → ink-3 (loading + empty)
 *   - "alert"  → alert (fetch failed)
 *
 * Used by Activity (Runs/Pipelines) and the Review Dashboard sub-views.
 */
import type { ReactNode } from "react";

export interface NoticeRowProps {
  readonly tone: "alert" | "muted";
  readonly children: ReactNode;
}

export function NoticeRow(props: NoticeRowProps): JSX.Element {
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
