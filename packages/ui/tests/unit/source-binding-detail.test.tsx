/**
 * SourceBindingDetail tests — PR-Q10, phase-a appendix #9.
 *
 * The modal opened on a Sources row click. Confirms:
 *   - displays the webhook URL (`${origin}/webhooks/${id}`)
 *   - copy button writes the URL to navigator.clipboard
 *   - copy button surfaces the healthy-toned "copied" confirmation
 *   - displays full lastError (no truncation)
 *   - displays pendingEventsCount + sigFailCount24h
 *   - Disable button → confirmation step → PATCH `/api/admin/source-bindings/:id`
 *   - Delete button → confirmation step → DELETE `/api/admin/source-bindings/:id`
 *
 * NOTE: The modal is rendered with `window.location.origin` derived from the
 * jsdom default (`http://localhost`). The id portion is the binding's UUID.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourceBindingDetail } from "../../src/components/SourceBindingDetail.js";
import type { SourceBinding } from "../../src/types.js";

const BINDING_ID = "11111111-2222-3333-4444-555555555555";

function makeBinding(overrides: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: BINDING_ID,
    domainSlug: "wiki-test",
    adapterSlug: "asana",
    reviewMode: "auto",
    enabled: true,
    notes: null,
    name: "asana → wiki-test",
    status: "healthy",
    lastEventAt: new Date(Date.now() - 60_000).toISOString(),
    lastError: null,
    pendingEventsCount: 0,
    sigFailCount24h: 0,
    ...overrides,
  };
}

interface ClipboardStub {
  readonly writeText: ReturnType<typeof vi.fn>;
}

/** jsdom does NOT expose `navigator.clipboard` by default. `userEvent.setup()`
 *  installs its own stub on `window.navigator` (see
 *  `@testing-library/user-event/dist/esm/utils/dataTransfer/Clipboard.js`),
 *  which is why we must install our stub AFTER `userEvent.setup()` returns
 *  AND directly on the navigator instance — otherwise user-event's
 *  defineProperty overwrites our prototype getter on first interaction. */
let originalDescriptor: PropertyDescriptor | undefined = undefined;

function installClipboard(): ClipboardStub {
  const stub: ClipboardStub = { writeText: vi.fn().mockResolvedValue(undefined) };
  originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: stub,
  });
  return stub;
}

function uninstallClipboard(): void {
  if (originalDescriptor !== undefined) {
    Object.defineProperty(navigator, "clipboard", originalDescriptor);
  } else {
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "clipboard");
  }
  originalDescriptor = undefined;
}

describe("SourceBindingDetail", () => {
  // The clipboard stub MUST be re-installed after every `userEvent.setup()`
  // because user-event proactively replaces `navigator.clipboard` with its
  // own polyfill — installing once in `beforeEach` would lose the override
  // the moment a test calls `userEvent.setup()`. Tests that need to assert
  // on `writeText` should call `installClipboard()` after their user
  // setup. The afterEach guarantees teardown.
  afterEach(() => {
    uninstallClipboard();
  });

  it("renders the webhook URL composed from window.location.origin and the binding id", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const expectedUrl = `${window.location.origin}/webhooks/${BINDING_ID}`;
    expect(screen.getByText(expectedUrl)).toBeInTheDocument();
  });

  it("copies the webhook URL to the clipboard when the copy button is clicked + flashes a confirmation", async () => {
    const user = userEvent.setup();
    // Install AFTER userEvent.setup() — the user-event polyfill clobbers
    // navigator.clipboard during setup, so we re-install our stub here.
    const clip = installClipboard();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const expectedUrl = `${window.location.origin}/webhooks/${BINDING_ID}`;
    await user.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => {
      expect(clip.writeText).toHaveBeenCalledWith(expectedUrl);
    });
    // After the click, the button surface should swap to the "copied"
    // confirmation AND a healthy-toned status row renders below the
    // URL. Both surfaces show the same text — use getAllBy.
    await waitFor(() => {
      expect(screen.getAllByText(/copied/i).length).toBeGreaterThanOrEqual(1);
    });
    // The status row carries `role="status"` so screen readers (and
    // operators) get the confirmation; assert it landed.
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders the full lastError (no truncation in the modal)", () => {
    const longError =
      "transient: connection refused after 3 retries (peer reset, see logs at ts=...long string... — full diagnostic body that the Sources row column would have ellipsised)";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({ status: "alert", lastError: longError })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    expect(screen.getByText(longError)).toBeInTheDocument();
  });

  it("renders pendingEventsCount + sigFailCount24h when present", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({ pendingEventsCount: 7, sigFailCount24h: 3 })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("Disable button → confirmation step → PATCH `/api/admin/source-bindings/:id` with enabled=false", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: BINDING_ID, enabled: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={onClose}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^disable$/i }));
    // Confirmation step asks the operator to confirm.
    await user.click(
      await screen.findByRole("button", { name: /confirm disable/i }),
    );

    await waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(
          (c) =>
            String(c[0]) === `/api/admin/source-bindings/${BINDING_ID}` &&
            (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const patchCall = fetchImpl.mock.calls.find(
      (c) =>
        String(c[0]) === `/api/admin/source-bindings/${BINDING_ID}` &&
        (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body).toEqual({ enabled: false });

    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Enable button shows when binding is disabled, calls PATCH with enabled=true", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: BINDING_ID, enabled: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding({ enabled: false, status: null })}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^enable$/i }));
    await user.click(
      await screen.findByRole("button", { name: /confirm enable/i }),
    );

    await waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(
          (c) =>
            (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const patchCall = fetchImpl.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body).toEqual({ enabled: true });
  });

  it("Delete button → confirmation step → DELETE `/api/admin/source-bindings/:id`", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ deleted: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    const onClose = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={onClose}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    // Confirmation step.
    await user.click(
      await screen.findByRole("button", { name: /confirm delete/i }),
    );

    await waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Delete confirmation can be cancelled — no DELETE request made", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    // The confirmation panel renders a "back" button to retreat to the
    // detail view.
    await user.click(await screen.findByRole("button", { name: /cancel/i }));
    // No fetch was issued.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  // PR-Q10b — error i18n mapping. Both PATCH and DELETE catch blocks
  // previously surfaced raw `err.message` ("Admin API validation
  // error (HTTP 422)") instead of an i18n string. Map structured
  // errors to operator-facing keys.
  it("PATCH 422 surfaces an i18n string, not the raw err.message", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ error: "validation_failed" }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^disable$/i }));
    await user.click(
      await screen.findByRole("button", { name: /confirm disable/i }),
    );
    const alert = await screen.findByRole("alert");
    // The raw error message would say "Admin API validation error
    // (HTTP 422)" — assert the surfaced text does NOT contain that
    // diagnostic shape and DOES contain the operator-facing string.
    expect(alert.textContent).not.toMatch(/Admin API validation error/);
    expect(alert.textContent).not.toMatch(/HTTP 422/);
    // The default mapping for unknown errors is patchFailed.
    expect(alert.textContent).toMatch(/Could not disable binding/);
  });

  it("PATCH 401/403 surfaces an i18n auth string, not the raw err.message", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ reason: "expired_pat" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^disable$/i }));
    await user.click(
      await screen.findByRole("button", { name: /confirm disable/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/Admin API auth failed/);
    expect(alert.textContent).not.toMatch(/HTTP 401/);
  });

  it("PATCH 5xx / network surfaces an i18n string, not the raw err.message", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ error: "internal_error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^disable$/i }));
    await user.click(
      await screen.findByRole("button", { name: /confirm disable/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/HTTP 500/);
  });

  it("DELETE 500 internal error surfaces an i18n transient string, not the raw err.message", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ error: "internal_error" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(
      await screen.findByRole("button", { name: /confirm delete/i }),
    );
    const alert = await screen.findByRole("alert");
    // 500 maps to ApiTransientError → transient i18n string. The
    // surfaced message must NOT leak `HTTP 500` or `internal_error`,
    // and must match the operator-facing transient copy.
    expect(alert.textContent).not.toMatch(/HTTP 500/);
    expect(alert.textContent).not.toMatch(/internal_error/);
    expect(alert.textContent).toMatch(/unreachable|returned an error/i);
  });

  it("DELETE 422 unknown validation surfaces the deleteFailed i18n default", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ error: "validation_failed" }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(
      await screen.findByRole("button", { name: /confirm delete/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/HTTP 422/);
    expect(alert.textContent).toMatch(/Could not delete binding/);
  });

  it("DELETE 409 fk_restricted still surfaces its specific i18n string", async () => {
    // Already covered by the 409 path before PR-Q10b — keep the
    // explicit assertion so the deleteFkRestricted mapping doesn't
    // regress alongside the new default-mapping refactor.
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/admin/source-bindings/${BINDING_ID}` && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({ error: "fk_restricted" }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    await user.click(
      await screen.findByRole("button", { name: /confirm delete/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/audit history/i);
  });
});
