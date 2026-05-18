/**
 * CommandPalette tests — Cmd-K palette (PR-W10, phase-a
 * appendix #15 wave-15).
 *
 * Pins:
 *   - Opens with all results visible.
 *   - Substring + prefix matcher narrows the list as the
 *     operator types.
 *   - Arrow Up/Down moves the highlight; wraps at both ends.
 *   - Enter dispatches `onNavigate` for the highlighted row.
 *   - Esc dispatches `onClose`.
 *   - Matched chars render with the wiki-teal highlight.
 *   - Read-only: the palette never POSTs / never mutates.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  CommandPalette,
  type CommandPaletteProps,
} from "../../src/components/CommandPalette.js";

type Result = NonNullable<CommandPaletteProps["initialResults"]>[number];

const SAMPLE_RESULTS: ReadonlyArray<Result> = [
  {
    id: "domain:1",
    kind: "domain",
    label: "wiki-executive",
    target: { tab: "domains", entityId: "1" },
  },
  {
    id: "domain:2",
    kind: "domain",
    label: "wiki-hr",
    target: { tab: "domains", entityId: "2" },
  },
  {
    id: "binding:1",
    kind: "binding",
    label: "drive → wiki-executive",
    target: { tab: "sources", entityId: "1" },
  },
  {
    id: "agent:1",
    kind: "agent",
    label: "heartbeat (morning)",
    target: { tab: "agents", entityId: "1" },
  },
  {
    id: "prompt:heartbeat",
    kind: "prompt",
    label: "heartbeat",
    target: { tab: "prompts", promptName: "heartbeat" },
  },
];

function renderPalette(extra: Partial<CommandPaletteProps> = {}) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const view = render(
    <CommandPalette
      onClose={onClose}
      onNavigate={onNavigate}
      promptNames={["heartbeat"]}
      initialResults={SAMPLE_RESULTS}
      {...extra}
    />,
  );
  return { view, onClose, onNavigate };
}

describe("CommandPalette (PR-W10)", () => {
  it("renders all seeded results on open", () => {
    renderPalette();
    const rows = document.querySelectorAll("[data-result-id]");
    // PR-B6 (wave-16): the palette always appends a static
    // "Run onboarding wizard" command entry, so the row count
    // is SAMPLE_RESULTS + 1.
    expect(rows.length).toBe(SAMPLE_RESULTS.length + 1);
  });

  it("narrows the list by case-insensitive substring match", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wiki" } });
    const rows = document.querySelectorAll("[data-result-id]");
    // "wiki" matches: wiki-executive, wiki-hr, drive → wiki-executive
    expect(rows.length).toBe(3);
  });

  it("ranks prefix matches above mid-string matches (stable ties)", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "wiki" } });
    const ids = Array.from(
      document.querySelectorAll("[data-result-id]"),
    ).map((el) => el.getAttribute("data-result-id"));
    // wiki-executive (prefix), wiki-hr (prefix), drive → wiki-executive (substring)
    expect(ids).toEqual(["domain:1", "domain:2", "binding:1"]);
  });

  it("renders the empty-state when nothing matches", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "qzx" } });
    expect(document.querySelectorAll("[data-result-id]").length).toBe(0);
    // Empty hint is rendered.
    expect(screen.getByText(/No results/i)).toBeTruthy();
  });

  it("Arrow Down moves the active row; Arrow Up wraps", () => {
    renderPalette();
    const sheet = document.querySelector(
      '[data-component="command-palette"]',
    )!.firstChild as HTMLElement;
    // Initially active row is idx 0.
    let active = document.querySelector(
      '[data-result-active="true"]',
    ) as HTMLElement;
    expect(active.getAttribute("data-result-id")).toBe("domain:1");
    fireEvent.keyDown(sheet, { key: "ArrowDown" });
    active = document.querySelector(
      '[data-result-active="true"]',
    ) as HTMLElement;
    expect(active.getAttribute("data-result-id")).toBe("domain:2");
    // From idx 0, ArrowUp wraps to the last row. PR-B6
    // (wave-16) appends the static "Run onboarding wizard"
    // command, so the last row is now `command:onboarding`.
    fireEvent.keyDown(sheet, { key: "ArrowUp" });
    fireEvent.keyDown(sheet, { key: "ArrowUp" });
    active = document.querySelector(
      '[data-result-active="true"]',
    ) as HTMLElement;
    expect(active.getAttribute("data-result-id")).toBe("command:onboarding");
  });

  it("Enter dispatches onNavigate for the active row and closes the palette", () => {
    const { onClose, onNavigate } = renderPalette();
    const sheet = document.querySelector(
      '[data-component="command-palette"]',
    )!.firstChild as HTMLElement;
    fireEvent.keyDown(sheet, { key: "ArrowDown" });
    fireEvent.keyDown(sheet, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      tab: "domains",
      entityId: "2",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking a result dispatches onNavigate + onClose", () => {
    const { onClose, onNavigate } = renderPalette();
    const row = document.querySelector(
      '[data-result-id="binding:1"]',
    ) as HTMLElement;
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith({
      tab: "sources",
      entityId: "1",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc closes the palette", () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop closes the palette", () => {
    const { onClose } = renderPalette();
    const backdrop = document.querySelector(
      '[data-component="command-palette"]',
    ) as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("highlights the matched substring with bold ink (PR-W11: wiki-teal removed — palette spans non-knowledge entities, so `--wiki` would violate the compiled-knowledge-chrome budget)", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "exec" } });
    const row = document.querySelector(
      '[data-result-id="domain:1"]',
    ) as HTMLElement;
    const bold = row.querySelector("b") as HTMLElement;
    expect(bold).not.toBeNull();
    expect(bold.textContent).toBe("exec");
    expect(bold.style.color).toBe("var(--ink)");
    expect(bold.style.fontWeight).toBe("600");
  });

  it("does not call any fetch when initialResults is supplied (read-only seam)", () => {
    const fetchSpy = vi.fn();
    render(
      <CommandPalette
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        promptNames={["heartbeat"]}
        initialResults={SAMPLE_RESULTS}
        fetchImpl={fetchSpy as unknown as typeof fetch}
      />,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("matches the search query case-insensitively", () => {
    renderPalette();
    const input = screen.getByTestId(
      "command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "WIKI-HR" } });
    const rows = document.querySelectorAll("[data-result-id]");
    expect(rows.length).toBe(1);
    expect(rows[0]!.getAttribute("data-result-id")).toBe("domain:2");
  });

  // Copilot triage on PR-W10: selecting a prompt result must
  // emit `promptName` on the navigation target so App.tsx can
  // route the hop into the Prompts route's `initialPromptName`
  // channel — otherwise the prompt-name palette command lands on
  // the empty prompt picker.
  it("dispatches promptName when selecting a prompt result", () => {
    const { onClose, onNavigate } = renderPalette();
    const row = document.querySelector(
      '[data-result-id="prompt:heartbeat"]',
    ) as HTMLElement;
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith({
      tab: "prompts",
      promptName: "heartbeat",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
