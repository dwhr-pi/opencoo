/**
 * Badge — migrated from the management-console UI kit.
 *
 * Tone reservations (CLAUDE.md "Design system"):
 *   - 'advisory' — agent layer ONLY (Heartbeat, approvals).
 *     Budget < 10% per screen.
 *   - 'wiki'     — compiled-knowledge chrome ONLY (citations,
 *                  wiki-path badges, prompts-diff banner).
 *   - 'alert'    — destructive / flagged items.
 *   - 'ok'       — healthy / compiled state.
 *   - 'neutral'  — anything else.
 */
import type { CSSProperties, ReactNode } from "react";

export type BadgeTone = "neutral" | "advisory" | "wiki" | "alert" | "ok";

const TONES: Record<BadgeTone, CSSProperties> = {
  neutral: {
    background: "var(--paper-2)",
    color: "var(--ink-2)",
    borderColor: "var(--rule)",
  },
  advisory: {
    background: "color-mix(in oklab, var(--advisory) 28%, var(--paper))",
    color: "var(--advisory-ink)",
    borderColor: "color-mix(in oklab, var(--advisory) 40%, var(--paper))",
  },
  wiki: {
    background: "color-mix(in oklab, var(--wiki) 14%, var(--paper))",
    color: "var(--wiki)",
    borderColor: "color-mix(in oklab, var(--wiki) 25%, var(--paper))",
  },
  alert: {
    background: "color-mix(in oklab, var(--alert) 14%, var(--paper))",
    color: "var(--alert)",
    borderColor: "color-mix(in oklab, var(--alert) 30%, var(--paper))",
  },
  ok: {
    background: "color-mix(in oklab, var(--healthy) 14%, var(--paper))",
    color: "var(--healthy)",
    borderColor: "color-mix(in oklab, var(--healthy) 26%, var(--paper))",
  },
};

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}

export function Badge(props: BadgeProps): JSX.Element {
  const t = TONES[props.tone ?? "neutral"];
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        padding: "3px 7px",
        borderRadius: 3,
        borderStyle: "solid",
        borderWidth: 1,
        ...t,
      }}
    >
      {props.children}
    </span>
  );
}
