/**
 * Display primitive tests — PR-C4 (wave-16, phase-a appendix #16).
 *
 * The Display component is the ONLY legal call site for the
 * Instrument Serif italic family in the management console. It
 * renders editorial-headline copy at three strategic placements
 * (Reports lede, Prompts empty-state lede, Domains tab top-line
 * summary) and is the only consumer of the `t-display` / `t-lede`
 * typescale classes defined in `colors_and_type.css:99-106, 158-166`.
 *
 * Pins:
 *   - `<Display level={1}>` renders `<h1>` with `t-display` class.
 *   - `<Display level={2}>` renders `<h2>` with `t-lede` class.
 *   - `<Display level={3}>` renders `<h3>` with `t-lede` class
 *     (h3 is also editorial in scope, just smaller).
 *   - Inline `font-family` resolves to `var(--font-serif)` + italic.
 *   - `as` override swaps the wrapper tag (used inside
 *     non-heading contexts e.g. empty-state panels where the
 *     surrounding card already carries an h1).
 *   - Children survive intact (the component is a typographic
 *     wrapper — no transformation).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Display } from "../../src/components/Display.js";

describe("Display primitive (PR-C4, wave-16)", () => {
  it("level=1 renders <h1> with the t-display class", () => {
    const { container } = render(<Display level={1}>Hello</Display>);
    const node = container.firstElementChild as HTMLElement;
    expect(node.tagName).toBe("H1");
    expect(node.className).toContain("t-display");
  });

  it("level=2 renders <h2> with the t-lede class", () => {
    const { container } = render(<Display level={2}>Hello</Display>);
    const node = container.firstElementChild as HTMLElement;
    expect(node.tagName).toBe("H2");
    expect(node.className).toContain("t-lede");
  });

  it("level=3 renders <h3> with the t-lede class", () => {
    const { container } = render(<Display level={3}>Hello</Display>);
    const node = container.firstElementChild as HTMLElement;
    expect(node.tagName).toBe("H3");
    expect(node.className).toContain("t-lede");
  });

  it("applies inline font-family = var(--font-serif) + italic so the typescale survives sheet-load order", () => {
    // The W11 audit-fence test asserts no inline color literals.
    // The font-family inline IS deliberate: it pins the only-legal
    // call-site even if `colors_and_type.css` hasn't loaded yet
    // (the C4 ESLint rule rejects every other reference, so this
    // inline value is THE marker the rule looks for upstream).
    const { container } = render(<Display level={2}>Lede</Display>);
    const node = container.firstElementChild as HTMLElement;
    expect(node.style.fontFamily).toBe("var(--font-serif)");
    expect(node.style.fontStyle).toBe("italic");
  });

  it("survives children unchanged (no wrapping span, no transform)", () => {
    render(<Display level={2}>Today&apos;s signals</Display>);
    expect(screen.getByText("Today's signals")).not.toBeNull();
  });

  it("`as` prop overrides the wrapper tag for non-heading contexts", () => {
    const { container } = render(
      <Display level={2} as="p">
        Lede body
      </Display>,
    );
    const node = container.firstElementChild as HTMLElement;
    expect(node.tagName).toBe("P");
    // The typescale class still tracks level (lede), not the tag.
    expect(node.className).toContain("t-lede");
  });

  it("`as` override still emits the serif + italic inline so the lint rule has a marker to find", () => {
    const { container } = render(
      <Display level={2} as="p">
        Lede body
      </Display>,
    );
    const node = container.firstElementChild as HTMLElement;
    expect(node.style.fontFamily).toBe("var(--font-serif)");
    expect(node.style.fontStyle).toBe("italic");
  });

  it("renders no inline color literals (W11 audit-fence)", () => {
    const { container } = render(<Display level={2}>Lede</Display>);
    const node = container.firstElementChild as HTMLElement;
    // Color comes from the t-display/t-lede class via --fg-1; the
    // primitive intentionally does NOT inline `color`.
    expect(node.style.color).toBe("");
  });
});
