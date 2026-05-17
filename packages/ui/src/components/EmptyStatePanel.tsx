/**
 * EmptyStatePanel — shared "no rows yet" surface (PR-B3, wave-16).
 *
 * Extracted from W8's HeartbeatDiagnosticsPanel
 * (Reports.tsx:505-631) so every list route shares one visual
 * recipe + one CTA affordance + an optional precondition-chain
 * shape for the surfaces that have a derivable diagnostic
 * (Reports today; Domains/Sources/etc. as follow-ups).
 *
 * Design-system constraints honored (CLAUDE.md hard-nos):
 *   - No gradients, no drop shadows, no emoji, no marketing voice.
 *   - Depth via border + paper-2 only.
 *   - Glyphs come from the trio (OpenArc / FilledDisc / RingWithDot);
 *     status icon is a Glyph — no fourth glyph, no Lucide.
 *   - Accent budgets: --healthy on pass rows, --alert only on
 *     destructive/terminal-failure rows. --advisory on advisory
 *     misses (the agent-layer is the legitimate consumer per
 *     design_system/README.md).
 *
 * Composition shape:
 *   <Card>
 *     <header band>title (h3, font-mono micro-label)</header>
 *     <body>
 *       <prose>body</prose>
 *       <diagnosticsChain?>
 *         row · status indicator · label · help
 *         row · …
 *       </diagnosticsChain>
 *       <cta?>CTA button or anchor</cta>
 *     </body>
 *   </Card>
 *
 * Why h3 for the title — the route already carries an <h1> at the
 * page header; the empty-state panel sits beneath it as a sectional
 * affordance, not a primary heading. Slots cleanly under A2's
 * landmark/h1 work.
 */
import type { CSSProperties, ReactNode } from "react";

import { Btn } from "./Btn.js";
import { GlyphFilledDisc, GlyphOpenArc, GlyphRingWithDot } from "./Glyph.js";

export type EmptyStateChainStatus = "fail" | "pass" | "pending" | "unknown";

export interface EmptyStateChainStep {
  readonly label: string;
  readonly status: EmptyStateChainStatus;
  readonly help?: ReactNode;
}

export interface EmptyStateCta {
  readonly label: string;
  readonly onClick?: () => void;
  readonly href?: string;
  readonly tone?: "ghost" | "primary";
}

export interface EmptyStatePanelProps {
  readonly title: string;
  readonly body: ReactNode;
  readonly cta?: EmptyStateCta;
  readonly diagnosticsChain?: ReadonlyArray<EmptyStateChainStep>;
}

const CARD_STYLE: CSSProperties = {
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-l)",
  background: "var(--paper)",
  display: "flex",
  flexDirection: "column",
};

const TITLE_BAND_STYLE: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--rule)",
  background: "var(--paper-2)",
  borderTopLeftRadius: "var(--radius-l)",
  borderTopRightRadius: "var(--radius-l)",
};

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-sans)",
  fontWeight: 500,
  fontSize: "var(--fs-body)",
  color: "var(--ink)",
};

const BODY_STYLE: CSSProperties = {
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const PROSE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--ink-2)",
  lineHeight: 1.5,
};

const CHAIN_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const CHAIN_ROW_STYLE: CSSProperties = {
  border: "1px solid var(--rule)",
  borderRadius: 6,
  padding: "12px 16px",
  background: "var(--paper-2)",
  display: "flex",
  alignItems: "flex-start",
  gap: 14,
};

const CHAIN_LABEL_STYLE: CSSProperties = {
  flex: 1,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--ink)",
  lineHeight: 1.5,
};

const CHAIN_HELP_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--ink-3)",
  marginTop: 4,
  lineHeight: 1.5,
};

const CTA_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const ANCHOR_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  padding: "8px 12px",
  borderRadius: 3,
  borderStyle: "solid",
  borderWidth: 1,
  textDecoration: "none",
  background: "var(--ink)",
  color: "var(--paper)",
  borderColor: "var(--ink)",
};

function chainGlyph(status: EmptyStateChainStatus): {
  glyph: JSX.Element;
  color: string;
} {
  switch (status) {
    case "pass":
      return {
        glyph: <GlyphRingWithDot size={18} />,
        color: "var(--healthy)",
      };
    case "fail":
      return {
        glyph: <GlyphOpenArc size={18} />,
        color: "var(--alert)",
      };
    case "pending":
      return {
        glyph: <GlyphOpenArc size={18} />,
        color: "var(--advisory-ink)",
      };
    case "unknown":
    default:
      return {
        glyph: <GlyphFilledDisc size={18} />,
        color: "var(--ink-3)",
      };
  }
}

export function EmptyStatePanel(props: EmptyStatePanelProps): JSX.Element {
  const { title, body, cta, diagnosticsChain } = props;
  return (
    <div data-empty-state-panel style={CARD_STYLE}>
      <div style={TITLE_BAND_STYLE}>
        <h3 style={TITLE_STYLE}>{title}</h3>
      </div>
      <div style={BODY_STYLE}>
        {body !== "" && body !== undefined && body !== null ? (
          <div style={PROSE_STYLE}>{body}</div>
        ) : null}
        {diagnosticsChain !== undefined && diagnosticsChain.length > 0 ? (
          <div style={CHAIN_LIST_STYLE}>
            {diagnosticsChain.map((step, idx) => {
              const { glyph, color } = chainGlyph(step.status);
              return (
                <div
                  key={`${idx}-${step.label}`}
                  data-empty-state-chain-row={step.status}
                  style={CHAIN_ROW_STYLE}
                >
                  <span
                    style={{
                      color,
                      display: "inline-flex",
                      marginTop: 1,
                    }}
                  >
                    {glyph}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={CHAIN_LABEL_STYLE}>{step.label}</div>
                    {step.help !== undefined ? (
                      <div style={CHAIN_HELP_STYLE}>{step.help}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {cta !== undefined ? (
          <div style={CTA_ROW_STYLE}>
            {cta.href !== undefined ? (
              <a href={cta.href} style={ANCHOR_STYLE}>
                {cta.label}
              </a>
            ) : (
              <Btn
                variant={cta.tone === "ghost" ? "ghost" : "primary"}
                {...(cta.onClick !== undefined ? { onClick: cta.onClick } : {})}
              >
                {cta.label}
              </Btn>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
