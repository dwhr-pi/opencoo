/**
 * TextField / TextArea primitives (PR-W9, phase-a appendix #15).
 *
 * Both are thin controlled-string shorthands; the interesting
 * surface is the `(next: string) => void` wrapper around the
 * underlying ChangeEvent — that's the whole point of the
 * primitive vs. calling Field directly.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TextArea } from "../../src/components/TextArea.js";
import { TextField } from "../../src/components/TextField.js";

describe("TextField", () => {
  it("renders a label + controlled input and forwards (next: string)", () => {
    const onChange = vi.fn<(next: string) => void>();
    render(
      <TextField
        label="Name"
        name="display-name"
        value="alpha"
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue("alpha") as HTMLInputElement;
    expect(input).toHaveAttribute("name", "display-name");
    fireEvent.change(input, { target: { value: "alpha2" } });
    expect(onChange).toHaveBeenCalledWith("alpha2");
  });

  it("clamps to maxLength on the way out", () => {
    const onChange = vi.fn<(next: string) => void>();
    render(
      <TextField
        label="Name"
        name="display-name"
        value="alp"
        onChange={onChange}
        maxLength={5}
      />,
    );
    const input = screen.getByDisplayValue("alp") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alphabet" } });
    // Callback receives the clamped value — caller never sees
    // characters beyond the configured maxLength.
    expect(onChange).toHaveBeenCalledWith("alpha");
  });
});

describe("TextArea", () => {
  it("renders a label + textarea and forwards (next: string)", () => {
    const onChange = vi.fn<(next: string) => void>();
    render(
      <TextArea
        label="Notes"
        name="domain-notes"
        value="initial"
        onChange={onChange}
      />,
    );
    const textarea = screen.getByDisplayValue("initial") as HTMLTextAreaElement;
    expect(textarea.tagName.toLowerCase()).toBe("textarea");
    expect(textarea).toHaveAttribute("name", "domain-notes");
    fireEvent.change(textarea, { target: { value: "added" } });
    expect(onChange).toHaveBeenCalledWith("added");
  });

  it("renders the helper / error chrome when provided", () => {
    render(
      <TextArea
        label="Notes"
        name="domain-notes"
        value="initial"
        onChange={(): void => undefined}
        helper="Markdown allowed."
        error="Notes must be 5+ characters."
      />,
    );
    expect(screen.getByText("Markdown allowed.")).toBeInTheDocument();
    expect(screen.getByText("Notes must be 5+ characters.")).toBeInTheDocument();
  });
});
