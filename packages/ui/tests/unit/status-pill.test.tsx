/**
 * StatusPill tests — glyph and tone spec assertions.
 *
 * Pins:
 *   - healthy tone renders GlyphRingWithDot (16px) + Badge(ok)
 *   - advisory tone renders GlyphOpenArc (16px) + Badge(advisory)
 *   - alert tone renders GlyphFilledDisc (16px) + Badge(alert)
 *   - glyphs use currentColor so tone cascades from Badge
 *   - layout is inline-flex with 4px gap
 *   - NO emoji glyphs (SVG trio only)
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { StatusPill } from "../../src/components/StatusPill.js";

describe("StatusPill", () => {
  it("healthy tone renders GlyphRingWithDot + Badge(ok)", () => {
    const { container } = render(<StatusPill tone="healthy">healthy</StatusPill>);
    const pill = container.firstChild as HTMLElement;
    expect(pill.textContent).toContain("healthy");
    // Should have an SVG glyph (ring with dot has two circles)
    const svgs = pill.querySelectorAll("svg");
    expect(svgs.length).toBe(1);
    // Ring with dot has an outer circle and inner filled circle
    const circles = pill.querySelectorAll("circle");
    expect(circles.length).toBeGreaterThanOrEqual(2);
  });

  it("advisory tone renders GlyphOpenArc + Badge(advisory)", () => {
    const { container } = render(<StatusPill tone="advisory">advisory</StatusPill>);
    const pill = container.firstChild as HTMLElement;
    expect(pill.textContent).toContain("advisory");
    // Should have an SVG glyph (arc is a path)
    const svgs = pill.querySelectorAll("svg");
    expect(svgs.length).toBe(1);
    const paths = pill.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
  });

  it("alert tone renders GlyphFilledDisc + Badge(alert)", () => {
    const { container } = render(<StatusPill tone="alert">alert</StatusPill>);
    const pill = container.firstChild as HTMLElement;
    expect(pill.textContent).toContain("alert");
    // Should have an SVG glyph (filled disc is a circle)
    const svgs = pill.querySelectorAll("svg");
    expect(svgs.length).toBe(1);
    const circles = pill.querySelectorAll("circle");
    expect(circles.length).toBeGreaterThan(0);
  });

  it("wrapper sets tone color so glyph's currentColor renders in tone", () => {
    // Glyph is sibling of <Badge>, not child — without the wrapper setting
    // color, currentColor would resolve to default text color, NOT the tone.
    // This test pins the wrapper-color mechanism per tone.
    const cases: ReadonlyArray<{
      tone: "healthy" | "advisory" | "alert";
      expected: string;
    }> = [
      { tone: "healthy", expected: "var(--healthy)" },
      { tone: "advisory", expected: "var(--advisory-ink)" },
      { tone: "alert", expected: "var(--alert)" },
    ];
    for (const c of cases) {
      const { container } = render(
        <StatusPill tone={c.tone}>{c.tone}</StatusPill>,
      );
      const pill = container.firstChild as HTMLElement;
      expect(pill.style.color).toBe(c.expected);
    }
  });

  it("glyph stroke/fill uses currentColor (cascade source verified above)", () => {
    // Stroke-based glyphs: healthy (ring+dot) and advisory (open arc).
    for (const tone of ["healthy", "advisory"] as const) {
      const { container } = render(<StatusPill tone={tone}>{tone}</StatusPill>);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("stroke")).toBe("currentColor");
    }
    // Fill-based glyph: alert (filled disc).
    const { container } = render(<StatusPill tone="alert">alert</StatusPill>);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
  });

  it("layout is inline-flex with 4px gap", () => {
    const { container } = render(<StatusPill tone="healthy">healthy</StatusPill>);
    const pill = container.firstChild as HTMLElement;
    expect(pill.style.display).toBe("inline-flex");
    expect(pill.style.gap).toBe("4px");
  });

  it("NO emoji glyphs (SVG trio only)", () => {
    const { container } = render(
      <>
        <StatusPill tone="healthy">healthy</StatusPill>
        <StatusPill tone="advisory">advisory</StatusPill>
        <StatusPill tone="alert">alert</StatusPill>
      </>,
    );
    // Defensive — no emoji glyphs slipped in.
    const text = container.textContent ?? "";
    expect(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/u.test(text)).toBe(false);
  });
});
