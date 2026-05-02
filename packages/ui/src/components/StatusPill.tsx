/**
 * StatusPill — composable status indicator combining a 16px glyph
 * from the trio (open arc / filled disc / ring with dot) and a
 * Badge label. Tone controls both the glyph color (via currentColor)
 * and the Badge tone.
 *
 * Design: inline-flex layout, 4px gap, glyph and text vertically
 * centered. Reuses Badge's existing tone tokens — no new colors.
 *
 * Tone mapping:
 *   - healthy: GlyphRingWithDot + Badge(ok)
 *   - advisory: GlyphOpenArc + Badge(advisory)
 *   - alert: GlyphFilledDisc + Badge(alert)
 */
import { GlyphFilledDisc, GlyphOpenArc, GlyphRingWithDot } from "./Glyph.js";
import { Badge, type BadgeTone } from "./Badge.js";
import type { ReactNode } from "react";

export type StatusTone = "healthy" | "advisory" | "alert";

export interface StatusPillProps {
  readonly tone: StatusTone;
  readonly children: ReactNode;
}

function mapTone(tone: StatusTone): BadgeTone {
  switch (tone) {
    case "healthy":
      return "ok";
    case "advisory":
      return "advisory";
    case "alert":
      return "alert";
  }
}

// Wrapper color drives the glyph via currentColor (the glyph is a sibling
// of <Badge>, not a child, so it can't inherit Badge's color). Mapping
// matches Badge tone foregrounds so glyph and badge text agree visually.
function wrapperColor(tone: StatusTone): string {
  switch (tone) {
    case "healthy":
      return "var(--healthy)";
    case "advisory":
      return "var(--advisory-ink)";
    case "alert":
      return "var(--alert)";
  }
}

function Glyph(props: { tone: StatusTone }): JSX.Element {
  switch (props.tone) {
    case "healthy":
      return <GlyphRingWithDot size={16} />;
    case "advisory":
      return <GlyphOpenArc size={16} />;
    case "alert":
      return <GlyphFilledDisc size={16} />;
  }
}

export function StatusPill(props: StatusPillProps): JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: "4px",
        alignItems: "center",
        color: wrapperColor(props.tone),
      }}
    >
      <Glyph tone={props.tone} />
      <Badge tone={mapTone(props.tone)}>{props.children}</Badge>
    </span>
  );
}
