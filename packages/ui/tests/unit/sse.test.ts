/**
 * SSE client — fetch-streaming auth (phase-a appendix #9 PR-Q1) +
 * 401 terminal-state handling (phase-a appendix #11 PR-W3).
 *
 * Pin matrix:
 *   1. Multi-line `data:` lines concatenate with a literal "\n" between
 *      lines and dispatch on the trailing blank line.
 *   2. Named events (`event: agent_run` followed by `data: {...}`) dispatch
 *      to the matching `on("agent_run", ...)` listener with parsed JSON.
 *   3. `id:` lines update the client's `lastEventId`; the next reconnect's
 *      fetch carries the most recent id as the `Last-Event-ID` header AND
 *      the `Authorization: Bearer <pat>` header sourced from `pat-store`.
 *   4. `close()` aborts the in-flight fetch (its AbortController fires);
 *      the client transitions to readyState "closed" and stops dispatching.
 *   5. PR-W3 — a 401 response is TERMINAL: the client emits a synthetic
 *      `auth_failed` event on the `auth_failed` channel, transitions to
 *      readyState "closed", and does NOT schedule a reconnect. A 5xx
 *      response (or a network error) still triggers exponential backoff.
 *
 * Strategy:
 *   We replace globalThis.fetch with a controllable stub that returns a
 *   Response wrapping a Web ReadableStream. Tests push raw SSE wire-format
 *   chunks into the stream; the parser is exercised end-to-end exactly as
 *   in the browser. No real network, no MSW dependency — the same Web
 *   Streams API is available in jsdom + Node 22.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { ReadableStream } from "node:stream/web";

import { setPat, clearPat } from "../../src/lib/pat-store.js";
import { openSseClient } from "../../src/lib/sse.js";

// ─── Test harness ────────────────────────────────────────────────────────────

interface StreamHandle {
  /** Push an SSE wire-format chunk into the stream. */
  push(chunk: string): void;
  /** Close the stream cleanly (server-side EOF). */
  end(): void;
  /** AbortSignal handed to fetch — flips when the client calls close(). */
  readonly signal: AbortSignal;
  /** Headers the client sent on this fetch attempt. */
  readonly headers: Headers;
}

interface FetchHarness {
  /** Resolves on the next pending fetch — yields its handle. */
  next(): Promise<StreamHandle>;
  /** All fetches observed so far, in order. */
  readonly attempts: readonly StreamHandle[];
}

/** Replace globalThis.fetch with a queue of controllable streams.
 *
 *  `status` may be a single number (applied to every fetch) or an
 *  array consumed positionally — first attempt gets `statuses[0]`,
 *  second `statuses[1]`, etc. Past the array end the harness falls
 *  back to 200, so longer-than-expected reconnect loops still parse. */
function installFetchHarness(
  opts: { status?: number; statuses?: readonly number[] } = {},
): FetchHarness {
  const fixedStatus = opts.status ?? 200;
  const statuses = opts.statuses;
  const attempts: StreamHandle[] = [];
  const waiters: Array<(h: StreamHandle) => void> = [];
  let consumed = 0;

  const fetchMock: Mock = vi.fn(
    (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      let pushController: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          pushController = controller;
        },
      });
      const encoder = new TextEncoder();
      const handle: StreamHandle = {
        push(chunk: string): void {
          pushController.enqueue(encoder.encode(chunk));
        },
        end(): void {
          try {
            pushController.close();
          } catch {
            /* already closed */
          }
        },
        signal: (init?.signal ?? new AbortController().signal) as AbortSignal,
        headers: new Headers(init?.headers ?? {}),
      };
      const idx = attempts.length;
      attempts.push(handle);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        consumed += 1;
        waiter(handle);
      }
      const status =
        statuses !== undefined
          ? (statuses[idx] ?? 200)
          : fixedStatus;
      // Cast through unknown — node:stream/web's ReadableStream is assignable
      // to BodyInit in jsdom but TS sees the global Web Streams type.
      return Promise.resolve(
        new Response(stream as unknown as BodyInit, {
          status,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock as unknown as typeof fetch;

  // Harness owns the fetch override; the lifecycle hook below
  // (`afterEach`) restores `globalThis.fetch` to its original
  // implementation so the mock cannot leak across files. Vitest's
  // `restoreAllMocks` only undoes `vi.spyOn` / `vi.fn` registered
  // mocks, not raw assignments to globals.

  return {
    async next(): Promise<StreamHandle> {
      // If a fetch has already landed but no one consumed it, hand it off.
      if (consumed < attempts.length) {
        const handle = attempts[consumed];
        if (handle !== undefined) {
          consumed += 1;
          return handle;
        }
      }
      // Otherwise queue a waiter — the next fetch will resolve it.
      return new Promise<StreamHandle>((resolve) => waiters.push(resolve));
    },
    get attempts(): readonly StreamHandle[] {
      return attempts;
    },
  };
}

/** Wait for a microtask flush so async listeners can run. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

const ORIGINAL_FETCH: typeof fetch = globalThis.fetch;

beforeEach(() => {
  clearPat();
  vi.useRealTimers();
});

afterEach(() => {
  clearPat();
  vi.restoreAllMocks();
  // Always return to real timers between tests — the PR-W3 401 cases
  // install fake timers to assert no reconnect was scheduled, and a
  // leaked fake-timer state would poison sibling test files that rely
  // on real `setTimeout` (credential-form, diff-preview).
  vi.useRealTimers();
  // Restore the original `fetch` — `installFetchHarness` overwrites
  // `globalThis.fetch` directly (a raw assignment, not a vi.spyOn),
  // which `vi.restoreAllMocks()` cannot revert. Without this hook,
  // the mocked fetch would leak into any later test file that
  // touches `globalThis.fetch`.
  globalThis.fetch = ORIGINAL_FETCH;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("openSseClient — wire-format parsing", () => {
  it("concatenates multi-line `data:` lines with literal newline separators", async () => {
    const harness = installFetchHarness();
    const client = openSseClient("/api/admin/events");
    const received: Array<{ data: unknown; lastEventId: string }> = [];
    client.on<string>("message", (e) => {
      received.push({ data: e.data, lastEventId: e.lastEventId });
    });

    const stream = await harness.next();
    // Multi-line data — server sends each line with its own `data:` prefix.
    // The SSE spec dictates lines concatenate with "\n" on dispatch.
    stream.push("data: line one\ndata: line two\ndata: line three\n\n");
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]?.data).toBe("line one\nline two\nline three");

    client.close();
  });

  it("dispatches named events to the matching listener with parsed JSON data", async () => {
    const harness = installFetchHarness();
    const client = openSseClient("/api/admin/events");
    const runs: Array<unknown> = [];
    const messages: Array<unknown> = [];
    client.on<{ runId: string; status: string }>("agent_run", (e) => {
      runs.push(e.data);
    });
    client.on<unknown>("message", (e) => {
      messages.push(e.data);
    });

    const stream = await harness.next();
    stream.push(
      'event: agent_run\ndata: {"runId":"abc","status":"success"}\n\n',
    );
    await flush();

    expect(runs).toEqual([{ runId: "abc", status: "success" }]);
    // Named event must NOT also dispatch to the default `message` channel.
    expect(messages).toHaveLength(0);

    client.close();
  });
});

describe("openSseClient — reconnect carries Last-Event-ID + Bearer PAT", () => {
  it("updates lastEventId from `id:` lines and re-sends it on reconnect", async () => {
    setPat("test-pat-token");
    const harness = installFetchHarness();
    const client = openSseClient("/api/admin/events");
    const received: Array<{ id: string; data: unknown }> = [];
    client.on<unknown>("message", (e) => {
      received.push({ id: e.lastEventId, data: e.data });
    });

    // First connection — server emits an event with an `id:` line, then
    // closes the stream (simulating a network drop / server restart).
    const first = await harness.next();
    first.push('id: 42\ndata: "payload"\n\n');
    await flush();
    expect(received[0]?.id).toBe("42");
    first.end();

    // Client should reconnect — the second fetch carries Last-Event-ID = 42
    // AND the Bearer PAT.
    const second = await harness.next();
    expect(second.headers.get("Last-Event-ID")).toBe("42");
    expect(second.headers.get("Authorization")).toBe("Bearer test-pat-token");
    expect(second.headers.get("Accept")).toMatch(/text\/event-stream/);

    client.close();
  });
});

describe("openSseClient — 401 is terminal (PR-W3, phase-a appendix #11)", () => {
  it("emits an `auth_failed` event and does NOT schedule a reconnect on 401", async () => {
    setPat("stale-pat-token");
    // Use fake timers so any errant scheduleReconnect() call would be
    // observable as a queued setTimeout — verified below.
    vi.useFakeTimers();

    const harness = installFetchHarness({ status: 401 });
    const client = openSseClient("/api/admin/events");

    const authFailedEvents: Array<unknown> = [];
    client.on<unknown>("auth_failed", (e) => {
      authFailedEvents.push(e);
    });

    // First fetch lands.
    await harness.next();
    // Drain microtasks so the 401 handling runs.
    await vi.runAllTimersAsync();

    // Exactly ONE fetch attempt — no reconnect was scheduled.
    expect(harness.attempts).toHaveLength(1);
    // The terminal `auth_failed` event fired.
    expect(authFailedEvents).toHaveLength(1);
    // Client transitioned to closed; subsequent close() is a no-op.
    expect(client.readyState).toBe("closed");

    // Advance the clock well past the maximum backoff window — still no
    // second fetch (the terminal flag prevents scheduleReconnect from
    // queuing one).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.attempts).toHaveLength(1);

    client.close();
    vi.useRealTimers();
  });

  it("preserves backoff/reconnect on 5xx (only 401 is terminal)", async () => {
    vi.useFakeTimers();

    // First attempt 503 → must reconnect; second attempt 200 → recovers.
    const harness = installFetchHarness({ statuses: [503, 200] });
    const client = openSseClient("/api/admin/events");

    const authFailedEvents: Array<unknown> = [];
    client.on<unknown>("auth_failed", (e) => {
      authFailedEvents.push(e);
    });

    // First fetch lands and returns 503.
    await harness.next();
    await vi.runAllTimersAsync();

    // No auth_failed event; reconnect was scheduled.
    expect(authFailedEvents).toHaveLength(0);

    // Advance past the initial 500ms backoff so the reconnect timer fires.
    await vi.advanceTimersByTimeAsync(1_000);
    // A second fetch attempt happened.
    expect(harness.attempts.length).toBeGreaterThanOrEqual(2);
    // Client is not in terminal state — readyState is "open" or "connecting".
    expect(client.readyState).not.toBe("closed");

    client.close();
    vi.useRealTimers();
  });
});

describe("openSseClient — close() aborts the in-flight fetch", () => {
  it("fires the AbortController's signal and transitions readyState to closed", async () => {
    const harness = installFetchHarness();
    const client = openSseClient("/api/admin/events");
    const stream = await harness.next();
    expect(stream.signal.aborted).toBe(false);

    // Wait for the readable to be wired up before closing.
    await flush();

    client.close();

    expect(stream.signal.aborted).toBe(true);
    expect(client.readyState).toBe("closed");

    // After close(), pushing more bytes must not dispatch — i.e. listeners
    // are torn down. We register a fresh listener and verify it never fires.
    const heard: unknown[] = [];
    client.on<unknown>("message", (e) => {
      heard.push(e);
    });
    try {
      stream.push('data: "should-not-arrive"\n\n');
    } catch {
      /* the stream may already be torn down — that's fine */
    }
    await flush();
    expect(heard).toHaveLength(0);
  });
});
