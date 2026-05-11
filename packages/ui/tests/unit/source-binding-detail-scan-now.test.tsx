/**
 * SourceBindingDetail — Scan-now button (PR-Z3, phase-a appendix #12).
 *
 * Closes G8 (operator wanting to verify a binding works currently
 * has to wait 4h for the cron OR shell into the box).
 *
 * Pin matrix:
 *   1. Renders the "Scan now" button alongside the existing
 *      Disable/Delete/Forget destructive group.
 *   2. Click → POST `/api/admin/source-bindings/:id/scan-now`.
 *   3. Success (202) flashes the healthy-toned success toast.
 *   4. Button stays disabled for ~3s after success (anti-spam).
 *   5. 409 `binding_disabled` surfaces the "Enable the binding…"
 *      copy.
 *   6. 503 `scanner_queue_unavailable` surfaces the "not wired"
 *      copy.
 *   7. 5xx / network error surfaces the generic "Could not queue…"
 *      copy.
 *   8. Disabled bindings (binding.enabled === false) → button is
 *      disabled client-side (no fetch fires).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
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

describe("SourceBindingDetail — Scan now (PR-Z3, closes G8)", () => {
  beforeEach(() => {
    // Real timers by default; individual tests opt in to fake.
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the Scan-now button when the binding is enabled", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    expect(
      screen.getByRole("button", { name: /scan now/i }),
    ).toBeInTheDocument();
  });

  it("button is disabled when binding.enabled === false (operator must Enable first)", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({ enabled: false, status: null })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const btn = screen.getByRole("button", { name: /scan now/i });
    expect(btn).toBeDisabled();
  });

  it("click → POST /api/admin/source-bindings/:id/scan-now + success flash", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === `/api/admin/source-bindings/${BINDING_ID}/scan-now` &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({ enqueued: true, jobId: "scan-now-xyz" }),
          { status: 202, headers: { "content-type": "application/json" } },
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
    await user.click(screen.getByRole("button", { name: /scan now/i }));

    // Endpoint fired.
    await waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(
          (c) =>
            String(c[0]) ===
              `/api/admin/source-bindings/${BINDING_ID}/scan-now` &&
            (c[1] as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });

    // Success toast appears via `data-testid="scan-now-success"`.
    await waitFor(() => {
      expect(screen.getByTestId("scan-now-success")).toBeInTheDocument();
    });
  });

  it("button stays disabled for the 3s cooldown window after a successful click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ enqueued: true, jobId: "scan-now-xyz" }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const btn = screen.getByRole("button", { name: /scan now/i });
    await user.click(btn);

    // Wait until the success toast lands (which means cooldown is
    // active). After that, the button MUST stay disabled until the
    // 3s window elapses.
    await waitFor(() => {
      expect(screen.getByTestId("scan-now-success")).toBeInTheDocument();
    });
    expect(btn).toBeDisabled();

    // Advance time past the cooldown — button should re-enable.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(btn).not.toBeDisabled();
  });

  it("409 binding_disabled surfaces the 'Enable the binding' copy", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "binding_disabled", id: BINDING_ID }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    });
    // The server-side check fires when the binding is disabled in
    // the database. The client doesn't necessarily know about the
    // race (e.g. another operator disabled it between fetch +
    // click). The test renders an `enabled: true` binding so the
    // client-side disable guard doesn't fire — then asserts the
    // server's 409 response routes through the right copy.
    render(
      <SourceBindingDetail
        binding={makeBinding({ enabled: true })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /scan now/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/enable the binding before queuing a scan/i),
      ).toBeInTheDocument();
    });
  });

  it("503 scanner_queue_unavailable surfaces the composition-incomplete copy", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "scanner_queue_unavailable",
          reason: "Composition did not register a writable ingestion queue",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /scan now/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/scanner queue is not wired in this deployment/i),
      ).toBeInTheDocument();
    });
  });

  it("500 enqueue_failed surfaces the generic transient-error copy (ApiTransientError path)", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "enqueue_failed",
          reason: "transient",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /scan now/i }));
    // 500 → ApiTransientError → routed through `mapActionError`
    // which returns the generic transient copy ("Server is
    // unreachable or returned an error.") — same path the other
    // PATCH/DELETE actions use. The 5xx path is intentionally
    // generic so the operator picks the same recovery action
    // regardless of which mutating verb hit the server.
    await waitFor(() => {
      expect(
        screen.getByText(/server is unreachable or returned an error/i),
      ).toBeInTheDocument();
    });
  });

  it("on error path, button re-enables immediately (no cooldown)", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "enqueue_failed" }),
        { status: 500 },
      );
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const btn = screen.getByRole("button", { name: /scan now/i });
    await user.click(btn);
    // After the error response lands, the button is back to
    // enabled state — the operator can retry immediately. We pin
    // this by waiting for the error text to appear, then
    // asserting the button is no longer disabled.
    await waitFor(() => {
      expect(
        screen.getByText(/server is unreachable or returned an error/i),
      ).toBeInTheDocument();
    });
    expect(btn).not.toBeDisabled();
  });
});
