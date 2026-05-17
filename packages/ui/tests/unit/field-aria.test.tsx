/**
 * Field aria-described / errormessage chain (PR-A3, phase-a appendix #16).
 *
 * Field already wires `aria-invalid` when `error` is set, but the
 * helper-text + error-text spans are visually-present-not-announced
 * — screen readers see them in the DOM but the input doesn't point
 * to them. Per ARIA 1.2:
 *   - helper text → `aria-describedby={helperId}`
 *   - error text  → `aria-errormessage={errorId}` + `aria-invalid="true"`
 *   - both        → `aria-describedby="helperId errorId"` AND
 *                   `aria-errormessage={errorId}` AND
 *                   `aria-invalid="true"` (the helper still describes;
 *                   the error tags AS WELL via the explicit slot).
 *
 * The error span also gets `role="alert"` so the live region
 * announces it immediately on render — without this, screen-reader
 * users only hear the message after they navigate back to the field.
 *
 * `validationStatus="validating"` (a slot B4 will populate) sets
 * `aria-busy="true"` on the input so SR users hear "busy" while an
 * async validator is in flight.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Field } from "../../src/components/Field.js";
import { TextField } from "../../src/components/TextField.js";
import { TextArea } from "../../src/components/TextArea.js";

describe("Field — aria description / errormessage chain", () => {
  it("input with no helper / no error has no described/error/invalid attrs", () => {
    render(<Field name="slug" label="Slug" value="" onChange={(): void => undefined} />);
    const input = screen.getByLabelText(/slug/i) as HTMLInputElement;
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).not.toHaveAttribute("aria-errormessage");
    // Per the union: when `error` is undefined the attribute is
    // absent (Field passes `undefined` so React strips it).
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input).not.toHaveAttribute("aria-busy");
  });

  it("input with helper-only points aria-describedby at the helper span", () => {
    render(
      <Field
        name="slug"
        label="Slug"
        value=""
        onChange={(): void => undefined}
        helper="lowercase, digits, hyphens"
      />,
    );
    const input = screen.getByLabelText(/slug/i) as HTMLInputElement;
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(describedBy).toBe("field-slug-helper");
    const helper = document.getElementById("field-slug-helper");
    expect(helper).not.toBeNull();
    expect(helper?.textContent).toMatch(/lowercase, digits, hyphens/);
    // No error, so no errormessage / invalid.
    expect(input).not.toHaveAttribute("aria-errormessage");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("input with error-only sets errormessage + invalid + role=alert on the error span", () => {
    render(
      <Field
        name="slug"
        label="Slug"
        value="BAD"
        onChange={(): void => undefined}
        error="Slug must match ^[a-z]"
      />,
    );
    const input = screen.getByLabelText(/slug/i) as HTMLInputElement;
    expect(input).toHaveAttribute("aria-errormessage", "field-slug-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
    // No helper → no describedby.
    expect(input).not.toHaveAttribute("aria-describedby");
    const errorSpan = document.getElementById("field-slug-error");
    expect(errorSpan).not.toBeNull();
    expect(errorSpan).toHaveAttribute("role", "alert");
    expect(errorSpan?.textContent).toMatch(/Slug must match/);
  });

  it("input with helper AND error chains describedby through both ids", () => {
    render(
      <Field
        name="slug"
        label="Slug"
        value="BAD"
        onChange={(): void => undefined}
        helper="lowercase, digits, hyphens"
        error="Slug must match ^[a-z]"
      />,
    );
    const input = screen.getByLabelText(/slug/i) as HTMLInputElement;
    // ARIA 1.2: helper is still in the describedby chain; the
    // error gets its dedicated errormessage slot. Order: helper
    // first, then error, space-separated.
    expect(input).toHaveAttribute(
      "aria-describedby",
      "field-slug-helper field-slug-error",
    );
    expect(input).toHaveAttribute("aria-errormessage", "field-slug-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById("field-slug-helper")).not.toBeNull();
    expect(document.getElementById("field-slug-error")).toHaveAttribute(
      "role",
      "alert",
    );
  });

  it("validationStatus='validating' sets aria-busy=true on the input", () => {
    render(
      <Field
        name="slug"
        label="Slug"
        value="alpha"
        onChange={(): void => undefined}
        validationStatus="validating"
      />,
    );
    const input = screen.getByLabelText(/slug/i) as HTMLInputElement;
    expect(input).toHaveAttribute("aria-busy", "true");
  });

  it("validationStatus='idle'|'valid'|'invalid' do NOT set aria-busy", () => {
    const { rerender } = render(
      <Field
        name="slug"
        label="Slug"
        value="alpha"
        onChange={(): void => undefined}
        validationStatus="idle"
      />,
    );
    expect(
      (screen.getByLabelText(/slug/i) as HTMLInputElement).getAttribute(
        "aria-busy",
      ),
    ).toBeNull();

    rerender(
      <Field
        name="slug"
        label="Slug"
        value="alpha"
        onChange={(): void => undefined}
        validationStatus="valid"
      />,
    );
    expect(
      (screen.getByLabelText(/slug/i) as HTMLInputElement).getAttribute(
        "aria-busy",
      ),
    ).toBeNull();

    rerender(
      <Field
        name="slug"
        label="Slug"
        value="alpha"
        onChange={(): void => undefined}
        validationStatus="invalid"
      />,
    );
    expect(
      (screen.getByLabelText(/slug/i) as HTMLInputElement).getAttribute(
        "aria-busy",
      ),
    ).toBeNull();
  });

  it("uncontrolled mode inherits the same aria chain", () => {
    const ref: React.RefObject<HTMLInputElement | null> = { current: null };
    render(
      <Field
        name="slug"
        label="Slug"
        inputRef={ref}
        defaultValue=""
        helper="lowercase, digits, hyphens"
        error="Slug must match ^[a-z]"
      />,
    );
    const input = screen.getByLabelText(/slug/i) as HTMLInputElement;
    expect(input).toHaveAttribute(
      "aria-describedby",
      "field-slug-helper field-slug-error",
    );
    expect(input).toHaveAttribute("aria-errormessage", "field-slug-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });
});

describe("TextField — inherits Field's aria chain transparently", () => {
  it("threads helper + error props through to the underlying input", () => {
    render(
      <TextField
        name="display-name"
        label="Display name"
        value=""
        onChange={(): void => undefined}
        helper="1–80 characters."
        error="Display name is required."
      />,
    );
    const input = screen.getByLabelText(/display name/i) as HTMLInputElement;
    expect(input).toHaveAttribute(
      "aria-describedby",
      "field-display-name-helper field-display-name-error",
    );
    expect(input).toHaveAttribute(
      "aria-errormessage",
      "field-display-name-error",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById("field-display-name-error")).toHaveAttribute(
      "role",
      "alert",
    );
  });
});

describe("TextArea — wires the same aria chain", () => {
  it("textarea with helper + error chains describedby + errormessage + invalid", () => {
    render(
      <TextArea
        name="notes"
        label="Notes"
        value=""
        onChange={(): void => undefined}
        helper="Markdown allowed."
        error="Notes must be 5+ characters."
      />,
    );
    const textarea = screen.getByLabelText(/notes/i) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute(
      "aria-describedby",
      "field-notes-helper field-notes-error",
    );
    expect(textarea).toHaveAttribute("aria-errormessage", "field-notes-error");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById("field-notes-error")).toHaveAttribute(
      "role",
      "alert",
    );
  });

  it("textarea with helper-only sets aria-describedby and nothing else", () => {
    render(
      <TextArea
        name="notes"
        label="Notes"
        value=""
        onChange={(): void => undefined}
        helper="Markdown allowed."
      />,
    );
    const textarea = screen.getByLabelText(/notes/i) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute("aria-describedby", "field-notes-helper");
    expect(textarea).not.toHaveAttribute("aria-errormessage");
    expect(textarea.getAttribute("aria-invalid")).toBeNull();
  });
});
