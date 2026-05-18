/**
 * CommandPalette × OnboardingWizard re-summon — PR-B6, wave-16.
 *
 * Pins:
 *   - The static "Run onboarding wizard" entry appears in the
 *     palette results (always present, last in the static list).
 *   - Selecting it clears the `opencoo_onboarding_dismissed`
 *     localStorage flag and dispatches a `{ tab: 'domains' }`
 *     navigation target so App.tsx scrolls + tab-switches to
 *     Domains.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CommandPalette } from "../../src/components/CommandPalette.js";

function renderPalette(extra: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const view = render(
    <CommandPalette
      onClose={onClose}
      onNavigate={onNavigate}
      promptNames={[]}
      initialResults={[]}
      {...extra}
    />,
  );
  return { view, onClose, onNavigate };
}

describe("CommandPalette (PR-B6) — onboarding re-summon", () => {
  beforeEach(() => {
    localStorage.removeItem("opencoo_onboarding_dismissed");
  });

  it("renders a 'Run onboarding wizard' entry even when no other results are loaded", () => {
    renderPalette();
    // Static-suffix command — keyed by `command:onboarding`.
    const row = document.querySelector(
      '[data-result-id="command:onboarding"]',
    );
    expect(row).not.toBeNull();
  });

  it("selecting the onboarding entry clears the dismissal flag and dispatches a domains target", () => {
    localStorage.setItem("opencoo_onboarding_dismissed", "1");
    const { onNavigate, onClose } = renderPalette();
    const row = document.querySelector(
      '[data-result-id="command:onboarding"]',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    fireEvent.click(row);
    expect(localStorage.getItem("opencoo_onboarding_dismissed")).toBeNull();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ tab: "domains" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the onboarding entry is matchable by the search query", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "onboard" } });
    const row = document.querySelector(
      '[data-result-id="command:onboarding"]',
    );
    expect(row).not.toBeNull();
  });

  it("the onboarding entry is the last static entry in the list", () => {
    // With non-empty initialResults, the onboarding entry should
    // still appear, ranked after the loaded results (substring
    // tie-break on idx).
    renderPalette({
      initialResults: [
        {
          id: "domain:1",
          kind: "domain",
          label: "alpha",
          target: { tab: "domains", entityId: "1" },
        },
      ],
    });
    const ids = Array.from(
      document.querySelectorAll("[data-result-id]"),
    ).map((el) => el.getAttribute("data-result-id"));
    expect(ids).toContain("command:onboarding");
    // Onboarding sits after the seeded domain result.
    expect(ids.indexOf("command:onboarding")).toBeGreaterThan(
      ids.indexOf("domain:1"),
    );
  });
});
