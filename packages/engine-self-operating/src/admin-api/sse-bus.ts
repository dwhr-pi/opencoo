/**
 * In-process SSE event bus for the Activity tab (phase-a appendix #4 PR-B).
 *
 * A simple EventEmitter-backed bus that:
 *   - carries per-token streaming events from the LLM router
 *   - carries agent-run lifecycle events (started / completed / failed)
 *   - carries output-delivery DLQ alerts (PR-L)
 *
 * The bus lives in engine-self-operating's process and is passed to:
 *   1. The SSE route handler (`routes/events.ts`) which subscribes on
 *      connect and sends events to the browser over the SSE stream.
 *   2. The LLM router streaming path, which calls `emitToken` for each
 *      chunk of an in-flight run.
 *   3. OutputAdapter construction sites, which inject `onDlq` via
 *      `sseBus.bindOutputDlq()` so permanent delivery failures surface
 *      in the Activity feed.
 *
 * THREAT-MODEL §2 invariant 11: `emitToken` with `includePrompt=false`
 * strips the `promptText` field before broadcasting. The SSE route
 * always sets `includePrompt` to the value of `LLM_DEBUG_LOG`. No
 * prompt content reaches subscribers unless the gate is open.
 *
 * The bus is intentionally simple:
 *   - No persistence. The SSE stream is live-only; a reconnecting
 *     client gets a fresh `connected` event and sees only future events.
 *   - No backpressure. Engine-self-operating is single-process; the
 *     burst of tokens from one LLM call is bounded by the provider's
 *     chunk rate.
 *
 * ## Wiring output-webhook onDlq (PR-L)
 *
 * When constructing a `WebhookOutputAdapter` for production output
 * delivery, callers MUST inject:
 *
 *   ```ts
 *   onDlq: sseBus.bindOutputDlq()
 *   ```
 *
 * This wires permanent delivery failures to the Activity feed so
 * operators see them without polling the audit log. The
 * `bindOutputDlq()` helper returns a closure that stamps `occurredAt`
 * and calls `emitOutputDeliveryDlq` — no extra bookkeeping at the
 * call site.
 *
 * Production `output_bindings` admin endpoint (deferred, no endpoint
 * yet) must inject `onDlq: sseBus.bindOutputDlq()` when constructing
 * output adapters. The wiring point is `server-factory.ts` where
 * `sseBus` is in scope.
 */
import { EventEmitter } from "node:events";

/** A single LLM token emitted during a streaming run. */
export interface TokenEvent {
  readonly runId: string;
  readonly token: string;
  readonly promptText?: string; // present only when includePrompt=true
}

/** A structured run lifecycle event (started / completed / failed). */
export interface RunEvent {
  readonly runId: string;
  readonly definitionSlug: string;
  readonly status: "running" | "success" | "failed" | "timeout";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: string;
  readonly latencyMs?: number;
  readonly errorClass?: string;
}

export interface EmitTokenArgs {
  readonly runId: string;
  readonly token: string;
  /** Optional prompt text to attach. Only emitted when
   *  `includePrompt=true`. THREAT-MODEL §2 invariant 11. */
  readonly promptText?: string;
  /** Set to `true` only when `LLM_DEBUG_LOG=1`. */
  readonly includePrompt: boolean;
}

/** A permanent output-delivery failure surfaced to the Activity feed
 *  when an OutputAdapter's retry loop exhausts all attempts (DLQ). */
export interface OutputDeliveryDlqEvent {
  readonly type: "output_delivery_dlq";
  readonly outputBindingId: string;
  readonly deliveryId: string;
  /** Stringified error message. THREAT-MODEL §3.6 inv 11: no secret bytes. */
  readonly error: string;
  /** ISO timestamp when the DLQ event was emitted. */
  readonly occurredAt: string;
}

export interface SseBus {
  /** Emit a streaming token event. Gated by `includePrompt`. */
  emitToken(args: EmitTokenArgs): void;
  /** Subscribe to token events. Returns an unsubscribe function. */
  onToken(listener: (e: TokenEvent) => void): () => void;

  /** Emit a run lifecycle event. */
  emitRunEvent(event: RunEvent): void;
  /** Subscribe to run events. Returns an unsubscribe function. */
  onRunEvent(listener: (e: RunEvent) => void): () => void;

  /** Emit an output-delivery DLQ alert to the Activity feed. */
  emitOutputDeliveryDlq(event: OutputDeliveryDlqEvent): void;
  /** Subscribe to output-delivery DLQ events. Returns an unsubscribe fn. */
  onOutputDeliveryDlq(listener: (e: OutputDeliveryDlqEvent) => void): () => void;

  /**
   * Returns a closure suitable for direct injection as the `onDlq`
   * callback in `CreateWebhookOutputAdapterArgs`.
   *
   * Usage:
   *   ```ts
   *   createWebhookOutputAdapter({ ..., onDlq: sseBus.bindOutputDlq() })
   *   ```
   *
   * The closure stamps `occurredAt: new Date().toISOString()` and
   * stringifies `error` from the raw unknown thrown value.
   *
   * Callers must inject this when constructing output adapters so
   * permanent delivery failures surface in the Activity tab feed.
   *
   * TODO(v0.2 / phase-b): ready for the first production caller of
   * `createWebhookOutputAdapter`, which lands when the `output_bindings`
   * admin endpoint ships. At that point, `server-factory.ts` (where
   * `sseBus` is in scope) must inject `onDlq: sseBus.bindOutputDlq()`
   * when constructing output adapters so permanent delivery failures
   * surface in the Activity feed without polling the audit log.
   */
  bindOutputDlq(): (args: {
    readonly outputBindingId: string;
    readonly deliveryId: string;
    readonly error: unknown;
  }) => void;
}

const TOKEN_EVENT = "token";
const RUN_EVENT = "run";
const OUTPUT_DLQ_EVENT = "output_dlq";

/** Factory that returns a fresh SSE bus backed by a Node EventEmitter. */
export function createSseBus(): SseBus {
  const emitter = new EventEmitter();
  // Bump the listener ceiling — the SSE route registers one listener per
  // connected admin session; a deployment with a handful of concurrent
  // operators may exceed the default of 10. 100 is a generous ceiling
  // for a single-instance self-hosted product.
  emitter.setMaxListeners(100);

  return {
    emitToken(args: EmitTokenArgs): void {
      const event: TokenEvent = args.includePrompt && args.promptText !== undefined
        ? { runId: args.runId, token: args.token, promptText: args.promptText }
        : { runId: args.runId, token: args.token };
      emitter.emit(TOKEN_EVENT, event);
    },

    onToken(listener: (e: TokenEvent) => void): () => void {
      emitter.on(TOKEN_EVENT, listener);
      return () => emitter.off(TOKEN_EVENT, listener);
    },

    emitRunEvent(event: RunEvent): void {
      emitter.emit(RUN_EVENT, event);
    },

    onRunEvent(listener: (e: RunEvent) => void): () => void {
      emitter.on(RUN_EVENT, listener);
      return () => emitter.off(RUN_EVENT, listener);
    },

    emitOutputDeliveryDlq(event: OutputDeliveryDlqEvent): void {
      emitter.emit(OUTPUT_DLQ_EVENT, event);
    },

    onOutputDeliveryDlq(listener: (e: OutputDeliveryDlqEvent) => void): () => void {
      emitter.on(OUTPUT_DLQ_EVENT, listener);
      return () => emitter.off(OUTPUT_DLQ_EVENT, listener);
    },

    bindOutputDlq(): (args: {
      readonly outputBindingId: string;
      readonly deliveryId: string;
      readonly error: unknown;
    }) => void {
      // Capture `this`-like reference via the emitter directly (closure).
      return (args) => {
        const errorStr = args.error instanceof Error
          ? args.error.message
          : String(args.error);
        emitter.emit(OUTPUT_DLQ_EVENT, {
          type: "output_delivery_dlq",
          outputBindingId: args.outputBindingId,
          deliveryId: args.deliveryId,
          error: errorStr,
          occurredAt: new Date().toISOString(),
        } satisfies OutputDeliveryDlqEvent);
      };
    },
  };
}
