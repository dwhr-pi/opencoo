/**
 * SourceBindingDetail — Retry-failed button (PR-W2, phase-a appendix #14).
 *
 * Closes the "operator backfilled allowed_paths but the existing 260
 * BullMQ jobs are stale" gap. After W1 (allowed_paths is settable)
 * the operator can fix the binding's config; this button drives the
 * `POST /api/admin/source-bindings/:id/retry-failed` route which
 * enumerates the failed classify jobs and re-enqueues them.
 *
 * Pin matrix:
 *   1. Renders the "Retry failed jobs" button next to "Scan now"
 *      when the binding is enabled.
 *   2. Click → POST `/api/admin/source-bindings/:id/retry-failed`
 *      with no query param (bulk retry).
 *   3. Success (200) flashes a healthy-toned success toast that
 *      surfaces the retried count.
 *   4. Disabled when binding.enabled === false (mirrors scan-now).
 *   5. 503 classify_queue_unavailable surfaces a composition-
 *      incomplete copy.
 *   6. 500 retry_failed_enqueue_failed surfaces the generic
 *      transient-error copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourceBindingDetail } from "../../src/components/SourceBindingDetail.js";
import type { SourceBinding } from "../../src/types.js";

const BINDING_ID = "11111111-2222-3333-4444-555555555555";

function makeBinding(overrides: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: BINDING_ID,
    domainSlug: "wiki-test",
    adapterSlug: "drive",
    reviewMode: "auto",
    enabled: true,
    notes: null,
    name: "drive → wiki-test",
    status: "advisory",
    lastEventAt: new Date(Date.now() - 60_000).toISOString(),
    lastError: "validation",
    pendingEventsCount: 0,
    sigFailCount24h: 0,
    ...overrides,
  };
}

describe("SourceBindingDetail — Retry failed jobs (PR-W2)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the Retry-failed button when the binding is enabled", () => {
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
      screen.getByRole("button", { name: /retry failed/i }),
    ).toBeInTheDocument();
  });

  it("button is disabled when binding.enabled === false", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({ enabled: false, status: null })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const btn = screen.getByRole("button", { name: /retry failed/i });
    expect(btn).toBeDisabled();
  });

  it("click → POST /retry-failed (no intakeId query param) + success toast renders retried count", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === `/api/admin/source-bindings/${BINDING_ID}/retry-failed` &&
        init?.method === "POST"
      ) {
        return new Response(JSON.stringify({ retriedCount: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
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
    await user.click(screen.getByRole("button", { name: /retry failed/i }));

    // Endpoint fired (bulk path — no query string).
    await waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(
          (c) =>
            String(c[0]) ===
              `/api/admin/source-bindings/${BINDING_ID}/retry-failed` &&
            (c[1] as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });

    // Success toast renders + surfaces the count.
    await waitFor(() => {
      const toast = screen.getByTestId("retry-failed-success");
      expect(toast).toBeInTheDocument();
      // The toast carries the retried count so the operator
      // confirms the requested action happened (and at what scale).
      expect(toast.textContent ?? "").toMatch(/7/);
    });
  });

  it("503 classify_queue_unavailable surfaces composition-incomplete copy", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "classify_queue_unavailable",
          reason: "Composition did not register the classify-queue retry surface",
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
    await user.click(screen.getByRole("button", { name: /retry failed/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/retry surface is not wired/i),
      ).toBeInTheDocument();
    });
  });

  it("500 retry_failed_enqueue_failed surfaces the generic transient-error copy", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "retry_failed_enqueue_failed",
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
    await user.click(screen.getByRole("button", { name: /retry failed/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/server is unreachable or returned an error/i),
      ).toBeInTheDocument();
    });
  });

  it("0 retriedCount is still surfaced (idempotent path)", async () => {
    // The endpoint is idempotent: if there are no failed jobs, it
    // returns `{ retriedCount: 0 }` rather than 4xx-ing. The UI should
    // still flash a success toast so the operator knows the click
    // landed, AND the toast must reflect "0" so they can tell
    // nothing new was enqueued.
    const user = userEvent.setup();
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ retriedCount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    render(
      <SourceBindingDetail
        binding={makeBinding()}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /retry failed/i }));
    await waitFor(() => {
      const toast = screen.getByTestId("retry-failed-success");
      expect(toast.textContent ?? "").toMatch(/0/);
    });
  });
});
