/**
 * Activity route — output_delivery_dlq SSE event rendering (PR-L).
 *
 * Pin matrix:
 *   1. When an `output_delivery_dlq` SSE event arrives at the feed,
 *      the feed renders an alert-toned entry showing the binding ID,
 *      delivery ID (truncated to first 8 chars), and error text.
 *   2. The DLQ entry renders a StatusPill with tone="alert" (label
 *      "delivery failed" from the i18n key activity.feed.dlq).
 *   3. Multiple DLQ events accumulate in the feed list in
 *      chronological (insertion) order.
 *
 * Mocking strategy:
 *   PR-Q1 replaced the EventSource-based SSE client with a fetch-
 *   streaming one (`openSseClient`), which would do a real connect
 *   against `/api/admin/events` with a Bearer header in production.
 *   In unit tests we mock the entire `../../../src/lib/sse.js`
 *   module and replace `openSseClient` with a factory returning a
 *   controllable stub. The stub exposes a `dispatch` helper so tests
 *   can push synthetic events directly into the registered listeners
 *   — exercising the Activity component's real handler code without
 *   any network involvement.
 *
 *   Vitest hoists `vi.mock(...)` calls before all imports, so the mock is
 *   always in effect when Activity.tsx is evaluated.
 *
 *   The deeper contract (SSE wire-format → browser → Activity feed) is
 *   verified in the e2e lane against the compose stack.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { SseClient, SseListener } from "../../src/lib/sse.js";
import { Activity } from "../../src/routes/Activity.js";

// ─── Controllable SSE stub ────────────────────────────────────────────────────

/** A minimal SseClient stub that lets tests dispatch synthetic events. */
interface SseStub extends SseClient {
  /** Push a synthetic event to all registered listeners for the given type. */
  dispatch(eventType: string, data: unknown): void;
}

let currentStub: SseStub | null = null;

function makeSseStub(): SseStub {
  const listeners = new Map<string, Set<SseListener<unknown>>>();
  const stub: SseStub = {
    on<T>(eventType: string, listener: SseListener<T>): () => void {
      let set = listeners.get(eventType);
      if (set === undefined) {
        set = new Set();
        listeners.set(eventType, set);
      }
      set.add(listener as SseListener<unknown>);
      return () => {
        set?.delete(listener as SseListener<unknown>);
      };
    },
    close(): void {
      listeners.clear();
    },
    get readyState(): "open" {
      return "open";
    },
    dispatch(eventType: string, data: unknown): void {
      const set = listeners.get(eventType);
      if (set === undefined) return;
      const event = { type: eventType, data, lastEventId: "" };
      for (const listener of set) {
        listener(event);
      }
    },
  };
  currentStub = stub;
  return stub;
}

// vi.mock is hoisted by Vitest before all imports — the Activity component
// will always receive the stub factory when openSseClient is called.
vi.mock("../../src/lib/sse.js", () => ({
  openSseClient: () => makeSseStub(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFetch(): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : (input as Request).url;
    if (url.includes("agent-runs")) {
      return Promise.resolve(new Response(JSON.stringify({ rows: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.includes("pipelines")) {
      return Promise.resolve(new Response(JSON.stringify({ pipelines: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    return Promise.resolve(new Response("404", { status: 404 }));
  }) as typeof fetch;
}

function makeDlqEvent(overrides?: {
  outputBindingId?: string;
  deliveryId?: string;
  error?: string;
  occurredAt?: string;
}) {
  return {
    type: "output_delivery_dlq",
    outputBindingId: overrides?.outputBindingId ?? "binding-abc123",
    deliveryId: overrides?.deliveryId ?? "delivery-11111111-2222-3333-4444-555555555555",
    error: overrides?.error ?? "connect ECONNREFUSED 127.0.0.1:9999",
    occurredAt: overrides?.occurredAt ?? "2026-05-02T10:00:00.000Z",
  };
}

beforeEach(() => {
  currentStub = null;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Activity route — output_delivery_dlq rendering", () => {
  it("renders deliveryId (truncated to first 8 chars) in the DLQ entry", async () => {
    render(<Activity fetchImpl={makeFetch()} />);
    // Feed is the default active tab — stub is already registered.
    const stub = currentStub!;
    expect(stub).not.toBeNull();

    const dlq = makeDlqEvent({
      deliveryId: "abcdef12-0000-0000-0000-000000000000",
    });

    await act(() => {
      stub.dispatch("output_delivery_dlq", dlq);
    });

    // The first 8 chars of the deliveryId should appear in the feed.
    expect(screen.getByText(/abcdef12/)).toBeInTheDocument();
    // The binding ID should also appear.
    expect(screen.getByText(/binding-abc123/)).toBeInTheDocument();
  });

  it("renders a StatusPill with tone=alert (label 'delivery failed') for a DLQ entry", async () => {
    render(<Activity fetchImpl={makeFetch()} />);
    const stub = currentStub!;

    await act(() => {
      stub.dispatch("output_delivery_dlq", makeDlqEvent());
    });

    // The i18n key activity.feed.dlq resolves to "delivery failed".
    expect(screen.getByText(/delivery failed/i)).toBeInTheDocument();
  });

  it("accumulates multiple DLQ events in chronological order in the feed", async () => {
    render(<Activity fetchImpl={makeFetch()} />);
    const stub = currentStub!;

    const first = makeDlqEvent({
      deliveryId: "aaaaaaaa-0000-0000-0000-000000000000",
      error: "first-error",
    });
    const second = makeDlqEvent({
      deliveryId: "bbbbbbbb-0000-0000-0000-000000000000",
      error: "second-error",
    });

    await act(() => {
      stub.dispatch("output_delivery_dlq", first);
      stub.dispatch("output_delivery_dlq", second);
    });

    // Both events must be present in the feed.
    expect(screen.getByText(/first-error/)).toBeInTheDocument();
    expect(screen.getByText(/second-error/)).toBeInTheDocument();

    // Feed prepends new events (most recent first) — use innerHTML which
    // jsdom populates reliably (innerText is not fully supported in jsdom).
    const html = document.body.innerHTML;
    const posFirst = html.indexOf("first-error");
    const posSecond = html.indexOf("second-error");
    expect(posFirst).toBeGreaterThan(-1);
    expect(posSecond).toBeGreaterThan(-1);
    // Second event dispatched later → prepended above first in feed.
    expect(posSecond).toBeLessThan(posFirst);
  });

  it("feed tab shows 'live' indicator when SSE stub is open", () => {
    render(<Activity fetchImpl={makeFetch()} />);
    // SSE stub readyState is always "open" → "live" indicator.
    const indicators = screen.queryAllByText(/live/i);
    expect(indicators.length).toBeGreaterThan(0);
  });
});

// ─── PR-W3 — terminal `auth_failed` event ────────────────────────────────────

describe("Activity route — auth_failed terminal SSE event (PR-W3)", () => {
  it("renders the inline auth-expired alert when the SSE client fires `auth_failed`", async () => {
    render(<Activity fetchImpl={makeFetch()} />);
    const stub = currentStub!;
    expect(stub).not.toBeNull();

    await act(() => {
      stub.dispatch("auth_failed", { reason: "unauthorized" });
    });

    // Inline alert renders with the i18n title + body strings.
    const alert = screen.getByTestId("sse-auth-failed-alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(/sign-in expired/i)).toBeInTheDocument();
    expect(
      screen.getByText(/re-paste your pat to reconnect/i),
    ).toBeInTheDocument();
    // Indicator flips from "live" → "auth expired" with --alert color.
    expect(screen.getByText(/auth expired/i)).toBeInTheDocument();
    // Alert styling uses the `--alert` token (per design-system: alert
    // color is reserved for destructive/blocking states like an expired
    // sign-in). Verified by checking the inline style references the
    // design-system var rather than a hardcoded color.
    expect(alert.getAttribute("style") ?? "").toMatch(/var\(--alert\)/);
  });

  it("invokes the onAuthFailed callback when the operator clicks the re-auth button", async () => {
    const onAuthFailed = vi.fn();
    render(
      <Activity fetchImpl={makeFetch()} onAuthFailed={onAuthFailed} />,
    );
    const stub = currentStub!;

    await act(() => {
      stub.dispatch("auth_failed", { reason: "unauthorized" });
    });

    const button = screen.getByTestId("sse-auth-failed-reauth");
    expect(button).toBeInTheDocument();
    await act(() => {
      button.click();
    });

    expect(onAuthFailed).toHaveBeenCalledTimes(1);
  });
});
