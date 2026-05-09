/**
 * DomainDetail tests — PR-R1, phase-a appendix #10.
 *
 * Pins:
 *   - PATCH submit only sends the fields that changed.
 *   - Hard-delete button is disabled when bindingCount > 0; the
 *     helper message explains why.
 *   - Hard-delete button stays disabled until the confirmation
 *     checkbox is ticked (design-system rule for irreversible
 *     actions).
 *   - Disable button → confirmation step → DELETE without ?hard=1.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DomainDetail } from "../../src/components/DomainDetail.js";
import type { Domain } from "../../src/types.js";

const DOMAIN_ID = "11111111-2222-3333-4444-555555555555";

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: DOMAIN_ID,
    slug: "wiki-test",
    name: "Test wiki",
    class: "knowledge",
    locale: "en",
    isAggregator: false,
    disabledAt: null,
    bindingCount: 0,
    ...overrides,
  };
}

describe("DomainDetail", () => {
  it("PATCH submit with display_name change posts the right body shape; refetches on 200", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === `/api/admin/domains/${DOMAIN_ID}` &&
        init?.method === "PATCH"
      ) {
        return new Response(
          JSON.stringify({
            id: DOMAIN_ID,
            slug: "wiki-test",
            name: "Renamed wiki",
            class: "knowledge",
            locale: "en",
            llmPolicy: {},
            isAggregator: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(
      <DomainDetail
        domain={makeDomain()}
        onClose={onClose}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const input = screen.getByLabelText(/display name/i) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Renamed wiki");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(
          (c) =>
            String(c[0]) === `/api/admin/domains/${DOMAIN_ID}` &&
            (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const patchCall = fetchImpl.mock.calls.find(
      (c) =>
        String(c[0]) === `/api/admin/domains/${DOMAIN_ID}` &&
        (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    // Only the changed field is in the body — locale and is_aggregator
    // were not touched, so they must NOT be sent (otherwise an audit
    // row would record a no-op change).
    expect(body).toEqual({ display_name: "Renamed wiki" });

    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Save with no edits closes the modal without firing PATCH", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(
      <DomainDetail
        domain={makeDomain()}
        onClose={onClose}
        onChanged={onChanged}
        fetchImpl={fetchImpl}
      />,
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
    expect(onClose).toHaveBeenCalled();
  });

  it("Hard-delete button is disabled when bindingCount > 0; helper message renders", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <DomainDetail
        domain={makeDomain({ bindingCount: 3 })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    // Open the hard-delete confirmation panel.
    await user.click(
      screen.getByRole("button", { name: /delete permanently/i }),
    );
    // The "Confirm hard delete" destructive button is disabled
    // because bindingCount > 0.
    const confirmBtn = await screen.findByRole("button", {
      name: /confirm hard delete/i,
    });
    expect(confirmBtn).toBeDisabled();
    // Helper message naming the binding count is rendered.
    expect(
      screen.getByText(/Disable bindings first.*3 binding/i),
    ).toBeInTheDocument();
  });

  it("Hard-delete confirmation requires the checkbox tick before the destructive button enables", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === `/api/admin/domains/${DOMAIN_ID}?hard=1` &&
        init?.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(
      <DomainDetail
        domain={makeDomain()}
        onClose={onClose}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /delete permanently/i }),
    );
    const confirmBtn = await screen.findByRole("button", {
      name: /confirm hard delete/i,
    });
    // Initially disabled — the checkbox isn't ticked.
    expect(confirmBtn).toBeDisabled();
    // Tick the checkbox.
    const checkbox = screen.getByRole("checkbox", {
      name: /I understand this is permanent/i,
    });
    await user.click(checkbox);
    // Now enabled.
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(
      fetchImpl.mock.calls.some(
        (c) =>
          String(c[0]) === `/api/admin/domains/${DOMAIN_ID}?hard=1` &&
          (c[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("Soft-disable button confirms before sending DELETE without ?hard=1", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.startsWith(`/api/admin/domains/${DOMAIN_ID}`) && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(
      <DomainDetail
        domain={makeDomain()}
        onClose={onClose}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^disable$/i }));
    // Confirmation panel appears with the "Confirm disable" button.
    await user.click(
      await screen.findByRole("button", { name: /confirm disable/i }),
    );

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The DELETE URL has NO ?hard=1 — soft-delete only.
    const deleteCall = fetchImpl.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "DELETE",
    )!;
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall[0])).toBe(`/api/admin/domains/${DOMAIN_ID}`);
    expect(String(deleteCall[0])).not.toContain("hard=1");
  });

  it("Save with 409 aggregator_already_set surfaces the specific i18n string, not raw err.message", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === `/api/admin/domains/${DOMAIN_ID}` &&
        init?.method === "PATCH"
      ) {
        return new Response(
          JSON.stringify({ error: "aggregator_already_set" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(
      <DomainDetail
        domain={makeDomain()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    // Tick the aggregator toggle and save.
    await user.click(
      screen.getByRole("checkbox", { name: /aggregator/i }),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/HTTP 409/);
    expect(alert.textContent).toMatch(/already the aggregator/i);
  });
});
