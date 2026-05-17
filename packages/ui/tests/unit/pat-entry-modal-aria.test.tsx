/**
 * PatEntryModal aria-described / errormessage chain (PR-A3,
 * phase-a appendix #16).
 *
 * The PAT input was open-coded in PR-A1's collapse onto the
 * shared Modal shell — it inherits focus-trap from `<dialog>` but
 * NOT the Field-level aria-described/errormessage plumbing.
 * A3 back-ports the same chain so a SR user hears:
 *   - the storage-note ("session storage · cleared when this tab
 *     closes") via aria-describedby
 *   - the auth error ("Token is required" / server-side reject)
 *     via aria-errormessage + aria-invalid + role=alert on the
 *     error span
 *
 * Helper-only test: render with no error — describedby points at
 * the storage-note, errormessage / invalid absent.
 *
 * Helper + error test: render after empty submit — describedby
 * chains BOTH ids; errormessage + invalid set; error span has
 * role=alert.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PatEntryModal } from "../../src/components/PatEntryModal.js";

describe("PatEntryModal — aria chain (PR-A3)", () => {
  it("idle state — PAT input aria-describedby targets the storage-note", () => {
    render(<PatEntryModal onSubmit={() => undefined} />);
    const input = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    // The id resolves to a node containing the storage-note copy.
    const storageNote = document.getElementById(describedBy ?? "");
    expect(storageNote).not.toBeNull();
    expect(storageNote?.textContent).toMatch(/session storage · cleared/i);
    // No error in idle state.
    expect(input).not.toHaveAttribute("aria-errormessage");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("error from prop — input has errormessage + invalid + error span has role=alert", () => {
    render(
      <PatEntryModal onSubmit={() => undefined} error="Sign-in failed." />,
    );
    const input = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    expect(input).toHaveAttribute("aria-invalid", "true");
    const errId = input.getAttribute("aria-errormessage");
    expect(errId).not.toBeNull();
    const errorSpan = document.getElementById(errId ?? "");
    expect(errorSpan).not.toBeNull();
    expect(errorSpan).toHaveAttribute("role", "alert");
    expect(errorSpan?.textContent).toMatch(/Sign-in failed/);
    // Helper (storage-note) is still in the describedby chain.
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    // describedby chains helper id then error id, space-separated.
    expect(describedBy?.split(/\s+/)).toContain(errId);
  });

  it("empty submit surfaces the inline error with the same aria chain + role=alert", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<PatEntryModal onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: /Sign in/i }));
    await waitFor(() => {
      expect(screen.getByText(/Token is required/i)).toBeInTheDocument();
    });
    const input = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    expect(input).toHaveAttribute("aria-invalid", "true");
    const errId = input.getAttribute("aria-errormessage");
    expect(errId).not.toBeNull();
    const errorSpan = document.getElementById(errId ?? "");
    expect(errorSpan).toHaveAttribute("role", "alert");
  });
});
