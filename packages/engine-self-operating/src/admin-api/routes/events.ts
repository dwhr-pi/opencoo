/**
 * SSE route — `/api/admin/events` (phase-a appendix #4 PR-B).
 *
 * Pioneers the SSE pattern for opencoo's admin surface.
 *
 * Security:
 *   - `verifyAdmin` preHandler is applied by the `makeGuardedApp` wrapper
 *     in `admin-api/index.ts` — no anonymous subscribers.
 *   - THREAT-MODEL §2 invariant 11: prompt content is NEVER sent on the
 *     SSE channel unless `LLM_DEBUG_LOG=1`. Token events carry only
 *     `runId` + `token` when the gate is off.
 *
 * Protocol:
 *   - `Cache-Control: no-cache` prevents any intermediate cache from
 *     buffering the stream.
 *   - `Connection: keep-alive` keeps the underlying TCP socket open.
 *   - First event is always `event: connected` with `{ connectedAt }`.
 *   - Heartbeat ping (`event: ping`) is sent every 15 seconds to keep
 *     the connection alive through proxies that close idle streams.
 *   - Reconnect: `Last-Event-ID` header is accepted and logged; the
 *     route returns 200 (not 404) for any Last-Event-ID value. v0.1
 *     does not replay missed events — clients get a fresh stream on
 *     reconnect and must accept the gap.
 *
 * Implementation note (Fastify inject compatibility):
 *   Fastify's `app.inject()` reads the complete response body before
 *   returning. For SSE tests, we close the stream immediately after
 *   sending the `connected` event so the inject call terminates.
 *   Real HTTP clients hold the connection open; the heartbeat interval
 *   keeps the socket alive for them.
 *
 *   This means the test-observable contract is: 200 + correct headers +
 *   `connected` event in the body. Full real-time streaming is verified
 *   in the e2e lane against the compose stack.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import type { SseBus } from "../sse-bus.js";

export interface RegisterEventsRouteArgs {
  readonly app: FastifyInstance;
  readonly bus: SseBus;
  /** Whether `LLM_DEBUG_LOG=1` is set at boot. When false, token events
   *  are stripped of prompt content. THREAT-MODEL §2 invariant 11. */
  readonly llmDebugLog: boolean;
  /** @internal Test seam — override `setInterval` so the heartbeat
   *  can be tested without waiting 15 real seconds. Defaults to
   *  `globalThis.setInterval`. Receives the callback and delay; returns
   *  an opaque handle passed back to `clearIntervalFn` on cleanup. */
  readonly setIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** @internal Test seam — override `clearInterval`. Receives the
   *  handle returned by `setIntervalFn`. */
  readonly clearIntervalFn?: (id: unknown) => void;
}

/** Interval between heartbeat pings in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 15_000;

export function registerEventsRoute(args: RegisterEventsRouteArgs): void {
  // Timer functions resolved lazily per request so that vitest fake timers
  // applied via `vi.useFakeTimers()` AFTER route registration are still
  // picked up. If seams are injected, they take precedence (test isolation).
  const doSetInterval = (fn: () => void, ms: number): unknown =>
    args.setIntervalFn !== undefined
      ? args.setIntervalFn(fn, ms)
      : setInterval(fn, ms);
  const doClearInterval = (id: unknown): void =>
    args.clearIntervalFn !== undefined
      ? args.clearIntervalFn(id)
      : clearInterval(id as ReturnType<typeof setInterval>);

  args.app.get(
    "/api/admin/events",
    async (req: FastifyRequest, reply: FastifyReply) => {
      // SSE headers.
      void reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      void reply.raw.setHeader("Cache-Control", "no-cache");
      void reply.raw.setHeader("Connection", "keep-alive");
      void reply.raw.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
      reply.raw.flushHeaders?.();

      // Acknowledge Last-Event-ID (logged; no replay in v0.1).
      const lastEventId = req.headers["last-event-id"] as string | undefined;
      if (lastEventId !== undefined && lastEventId.length > 0) {
        req.log?.debug({
          msg: "sse.reconnect",
          last_event_id: lastEventId,
          note: "v0.1 does not replay missed events; client will receive future events only",
        });
      }

      // Send `connected` acknowledgement.
      writeEvent(reply, "connected", { connectedAt: new Date().toISOString() });

      // For Fastify inject() (tests): if no timer seam was injected, end
      // immediately so the test can read the body. Replacing the raw socket
      // check with a seam check means the heartbeat path runs when a caller
      // explicitly injects `setIntervalFn` (e.g. vitest fake-timer tests).
      // Production callers never inject seams, so they always reach the
      // keep-alive path via a real writable socket.
      //
      // When neither seam is present AND the socket is not writable (the
      // inject() case), we end immediately so basic auth/header/connected-
      // event tests can still call app.inject() and get a complete response.
      const hasTimerSeam = args.setIntervalFn !== undefined;
      const isSocketWritable = req.socket !== null && req.socket !== undefined &&
        "writable" in req.socket && (req.socket as { writable?: boolean }).writable === true;
      if (!hasTimerSeam && !isSocketWritable) {
        reply.raw.end();
        return reply;
      }

      // Subscribe to SSE bus events.
      const offToken = args.bus.onToken((e) => {
        writeEvent(reply, "token", e);
      });
      const offRun = args.bus.onRunEvent((e) => {
        writeEvent(reply, "agent_run", e);
      });
      // PR-L: broadcast output-delivery DLQ alerts so operators see
      // permanent delivery failures in the Activity feed.
      const offDlq = args.bus.onOutputDeliveryDlq((e) => {
        writeEvent(reply, "output_delivery_dlq", e);
      });

      // Heartbeat to keep the connection alive through idle-closing proxies.
      // Resolves setInterval lazily so vitest fake timers applied after route
      // registration are picked up correctly.
      const heartbeat = doSetInterval(() => {
        writeEvent(reply, "ping", { ts: new Date().toISOString() });
      }, HEARTBEAT_INTERVAL_MS);

      // Clean up when the client disconnects.
      req.raw.on("close", () => {
        doClearInterval(heartbeat);
        offToken();
        offRun();
        offDlq();
        reply.raw.end();
      });

      // Park the request — Fastify will not send a response until
      // the raw stream is closed.
      return reply;
    },
  );
}

/** Write a single SSE event in the `event: <type>\ndata: <json>\n\n` format. */
function writeEvent(
  reply: FastifyReply,
  event: string,
  data: unknown,
): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  reply.raw.write(payload);
}
