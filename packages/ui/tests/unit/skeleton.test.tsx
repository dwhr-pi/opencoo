/**
 * Skeleton primitive tests — PR-B1 (wave-16, phase-a appendix #16).
 *
 * Pins the load-bearing invariants:
 *   - `Skeleton.Row` renders the requested number of `<td>` cells,
 *     inside a `<tr>`. `mono` switches the cell visual width.
 *   - `Skeleton.Block` honors the `height` prop.
 *   - `Skeleton.Field` baseline height matches `Field`'s input
 *     (the wave-16 brief requires they read as the same shape).
 *   - ARIA: every sub-component renders `role="status"` +
 *     `aria-live="polite"` + `aria-busy="true"` + a visually-
 *     hidden "Loading content" label (i18n via common.loading).
 *   - No animation loop (the "exactly one loop is heartbeat-pulse"
 *     rule in design_system/README.md). The skeleton uses depth
 *     via border + paper-2; if a future edit re-adds a shimmer
 *     or pulse, this test fails.
 */
import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";

import { Skeleton } from "../../src/components/Skeleton.js";

describe("Skeleton.Row", () => {
  it("renders the requested number of <td> cells inside a <tr>", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={4} />
        </tbody>
      </table>,
    );
    const tr = container.querySelector("tr");
    expect(tr).not.toBeNull();
    const cells = tr!.querySelectorAll("td");
    expect(cells.length).toBe(4);
  });

  it("defaults to 3 cells when cols is omitted", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row />
        </tbody>
      </table>,
    );
    expect(container.querySelectorAll("td").length).toBe(3);
  });

  it("renders mono variant with JetBrains Mono font-family", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={2} mono />
        </tbody>
      </table>,
    );
    const placeholder = container.querySelector("td > span") as HTMLElement | null;
    expect(placeholder).not.toBeNull();
    expect(placeholder!.style.fontFamily).toBe("var(--font-mono)");
  });

  it("renders sans variant by default (no mono override)", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={2} />
        </tbody>
      </table>,
    );
    const placeholder = container.querySelector("td > span") as HTMLElement | null;
    expect(placeholder).not.toBeNull();
    expect(placeholder!.style.fontFamily).toBe("var(--font-sans)");
  });

  it("keeps the native <tr> row role and announces via an inner span", () => {
    // Triaged from PR-B1 Copilot review: putting `role="status"`
    // on a `<tr>` overrides the implicit `row` role and breaks
    // screen-reader table navigation. The row keeps its row role;
    // the live-region announcement moves to a `<span>` inside the
    // first cell so assistive tech still hears "loading" without
    // losing table semantics.
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={3} />
        </tbody>
      </table>,
    );
    const tr = container.querySelector("tr") as HTMLElement;
    // No explicit role override on the row — implicit `row` applies.
    expect(tr.getAttribute("role")).toBeNull();
    expect(tr.getAttribute("aria-busy")).toBe("true");
    // The live region lives inside the first cell.
    const firstCell = tr.querySelector("td") as HTMLElement;
    const status = firstCell.querySelector('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("includes a visually-hidden i18n loading label inside the first cell", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={3} />
        </tbody>
      </table>,
    );
    const tr = container.querySelector("tr") as HTMLElement;
    const labels = within(tr).getAllByText("Loading…");
    expect(labels.length).toBeGreaterThanOrEqual(1);
    const sr = labels[0]!;
    // Visually-hidden recipe: clip-rect 0 + 1px square + position absolute.
    expect(sr.style.position).toBe("absolute");
    expect(sr.style.width).toBe("1px");
    expect(sr.style.height).toBe("1px");
    // The visually-hidden span lives INSIDE a <td>, not directly
    // on the <tr> — `<span>` inside `<tr>` would be invalid HTML
    // and `role="status"` on `<td>` would override the cell role.
    expect(sr.closest("td")).not.toBeNull();
  });
});

describe("Skeleton.Block", () => {
  it("honors the height prop (number → px)", () => {
    const { container } = render(<Skeleton.Block height={120} />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.style.height).toBe("120px");
  });

  it("falls back to a sensible default when height is omitted", () => {
    const { container } = render(<Skeleton.Block />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block.style.height).not.toBe("");
  });

  it("exposes role=status + aria-live=polite + aria-busy=true", () => {
    const { container } = render(<Skeleton.Block height={60} />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block.getAttribute("role")).toBe("status");
    expect(block.getAttribute("aria-live")).toBe("polite");
    expect(block.getAttribute("aria-busy")).toBe("true");
  });

  it("includes a visually-hidden i18n loading label", () => {
    const { getAllByText, container } = render(<Skeleton.Block height={60} />);
    const labels = getAllByText("Loading…");
    expect(labels.length).toBeGreaterThanOrEqual(1);
    const sr = labels[0]!;
    expect(sr.style.position).toBe("absolute");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("uses border + paper-2 for depth (no shadow)", () => {
    const { container } = render(<Skeleton.Block height={60} />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block.style.border).toContain("var(--paper-3)");
    expect(block.style.background).toBe("var(--paper-2)");
    // Drop-shadow is a design-system hard-no.
    expect(block.style.boxShadow === "" || block.style.boxShadow === "none").toBe(true);
  });
});

describe("Skeleton.Field", () => {
  it("mirrors Field.tsx's input box recipe so swapping does not shift", () => {
    // Triaged from PR-B1 Copilot review: a hardcoded 32px height
    // does NOT match Field's actual rendered height (8px padding-
    // top + body line × 1.55 line-height + 8px padding-bottom +
    // 2px border ≈ 41px). Pin parity by asserting the SAME box
    // recipe — padding, border, line-height, font-size — that
    // Field.tsx applies to its <input>. With the global
    // `box-sizing: border-box` (app.css:10), identical recipe ⇒
    // identical border-box height ⇒ no swap-time layout shift.
    const { container } = render(<Skeleton.Field />);
    const field = container.querySelector('[role="status"]') as HTMLElement;
    expect(field).not.toBeNull();
    // Same padding as Field's <input> (Field.tsx:132).
    expect(field.style.padding).toBe("8px 10px");
    // Same font-size + line-height tokens so glyph metrics match.
    expect(field.style.fontSize).toBe("var(--fs-body)");
    expect(field.style.lineHeight).toBe("var(--lh-body)");
    // 1px border — same width as Field's input border.
    expect(field.style.border).toContain("1px solid");
  });

  it("exposes role=status + aria-live=polite + aria-busy=true", () => {
    const { container } = render(<Skeleton.Field />);
    const field = container.querySelector('[role="status"]') as HTMLElement;
    expect(field.getAttribute("role")).toBe("status");
    expect(field.getAttribute("aria-live")).toBe("polite");
    expect(field.getAttribute("aria-busy")).toBe("true");
  });

  it("includes a visually-hidden i18n loading label", () => {
    const { getAllByText } = render(<Skeleton.Field />);
    expect(getAllByText("Loading…").length).toBeGreaterThanOrEqual(1);
  });
});

describe("Skeleton — no animation loop invariant", () => {
  // The design-system's "exactly one loop" rule reserves the
  // heartbeat-pulse on the operate glyph as the only animation
  // loop in the product. Every skeleton primitive must remain
  // static — no shimmer, no pulse, no opacity loop.
  //
  // These tests pin that by asserting NO inline `animation` /
  // `animationName` style + NO `transition` (the skeleton is
  // a steady-state surface, not a transition target).
  it("Skeleton.Block carries no inline animation or transition", () => {
    const { container } = render(<Skeleton.Block height={60} />);
    const block = container.querySelector('[role="status"]') as HTMLElement;
    expect(block.style.animation).toBe("");
    expect(block.style.animationName).toBe("");
    expect(block.style.transition).toBe("");
    expect(block.style.transitionProperty).toBe("");
  });

  it("Skeleton.Row carries no inline animation or transition on its cells", () => {
    const { container } = render(
      <table>
        <tbody>
          <Skeleton.Row cols={2} />
        </tbody>
      </table>,
    );
    const tr = container.querySelector("tr") as HTMLElement;
    expect(tr.style.animation).toBe("");
    expect(tr.style.animationName).toBe("");
    expect(tr.style.transition).toBe("");
    expect(tr.style.transitionProperty).toBe("");
    const placeholders = container.querySelectorAll("td > span");
    placeholders.forEach((node) => {
      const el = node as HTMLElement;
      expect(el.style.animation).toBe("");
      expect(el.style.animationName).toBe("");
      expect(el.style.transition).toBe("");
      expect(el.style.transitionProperty).toBe("");
    });
  });

  it("Skeleton.Field carries no inline animation or transition", () => {
    const { container } = render(<Skeleton.Field />);
    const field = container.querySelector('[role="status"]') as HTMLElement;
    expect(field.style.animation).toBe("");
    expect(field.style.animationName).toBe("");
    expect(field.style.transition).toBe("");
    expect(field.style.transitionProperty).toBe("");
  });
});
