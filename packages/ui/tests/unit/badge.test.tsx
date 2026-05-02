/**
 * Badge tests — legibility and tone spec assertions.
 *
 * Pins:
 *   - renders all five tones: neutral, advisory, wiki, alert, ok
 *   - font size is 12px (NOT 10px) — the legibility regression guard
 *   - text is uppercase with 0.08em letter-spacing
 *   - tone-specific background and color apply correctly
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Badge } from "../../src/components/Badge.js";

describe("Badge", () => {
  it("renders neutral tone with correct styles", () => {
    const { container } = render(<Badge tone="neutral">neutral</Badge>);
    const badge = container.firstChild as HTMLElement;
    expect(badge.textContent).toBe("neutral");
    expect(badge.style.fontSize).toBe("12px");
    expect(badge.style.textTransform).toBe("uppercase");
    expect(badge.style.letterSpacing).toBe("0.08em");
    expect(badge.style.fontFamily).toBe("var(--font-mono)");
    expect(badge.style.background).toBe("var(--paper-2)");
  });

  it("renders advisory tone with correct styles", () => {
    const { container } = render(<Badge tone="advisory">advisory</Badge>);
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.fontSize).toBe("12px");
    expect(badge.style.color).toBe("var(--advisory-ink)");
  });

  it("renders wiki tone with correct styles", () => {
    const { container } = render(<Badge tone="wiki">wiki</Badge>);
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.fontSize).toBe("12px");
    expect(badge.style.color).toBe("var(--wiki)");
  });

  it("renders alert tone with correct styles", () => {
    const { container } = render(<Badge tone="alert">alert</Badge>);
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.fontSize).toBe("12px");
    expect(badge.style.color).toBe("var(--alert)");
  });

  it("renders ok tone with correct styles", () => {
    const { container } = render(<Badge tone="ok">ok</Badge>);
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.fontSize).toBe("12px");
    expect(badge.style.color).toBe("var(--healthy)");
  });

  it("renders with default neutral tone when tone is omitted", () => {
    const { container } = render(<Badge>unlabeled</Badge>);
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.background).toBe("var(--paper-2)");
  });
});
