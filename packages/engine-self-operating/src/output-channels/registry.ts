/**
 * `OutputChannelRegistry` — engine-internal router that wires
 * concrete `OutputChannelAdapter` implementations and enforces
 * the per-instance binding before dispatching.
 *
 * The registry is the load-bearing security gate for Q10:
 *   - The agent's JSON output is delivered post-LLM; the LLM
 *     itself never has an `output_channel_deliver` tool.
 *   - The instance's `outputChannelIds[]` is the closed set of
 *     channels this instance is authorised to deliver to.
 *   - `deliver({ bindings, delivery })` cross-checks the
 *     delivery's `adapterSlug` against `bindings`'s
 *     `adapter_slug` list before dispatching. Mismatch →
 *     `OutputChannelMismatchError` (validation, DLQ).
 *
 * The registry holds adapters; the agent-instance row holds the
 * per-instance subset + per-instance config. The two pieces meet
 * at `deliver()`.
 */
import type {
  OutputChannelAdapter,
  OutputChannelDeliverArgs,
} from "./interface.js";
import {
  OutputChannelMismatchError,
  OutputChannelUnknownAdapterError,
} from "./errors.js";

/** One row from `agent_instances.output_channel_ids[]`. The
 *  binding pairs an adapter slug with the per-instance config
 *  the registry passes verbatim into the adapter at delivery. */
export interface OutputChannelBinding {
  readonly adapter_slug: string;
  readonly config: Record<string, unknown>;
}

/** A delivery requested by the agent's post-run hook. Pure
 *  data — `OutputChannelRegistry.deliver` does the dispatch. */
export interface OutputChannelDelivery {
  readonly adapterSlug: string;
  readonly payload: unknown;
  /** PR-W2 (phase-a appendix #13) — the agent's
   *  `agent_instances.definition_slug`. Threaded through the
   *  bridge so the per-(agent, adapter) transformer dispatch
   *  can pick the right merge closure. Optional for
   *  backward-compat; the production CLI dispatcher in
   *  `agent-dispatcher.ts` always populates it. */
  readonly agentSlug?: string;
}

export interface OutputChannelDeliverInvocation {
  readonly bindings: readonly OutputChannelBinding[];
  readonly delivery: OutputChannelDelivery;
}

export class OutputChannelRegistry {
  private readonly bySlug = new Map<string, OutputChannelAdapter>();

  register(adapter: OutputChannelAdapter): void {
    if (this.bySlug.has(adapter.adapterSlug)) {
      throw new Error(
        `OutputChannelRegistry: duplicate adapter slug '${adapter.adapterSlug}' — registry rejects re-registration`,
      );
    }
    this.bySlug.set(adapter.adapterSlug, adapter);
  }

  get(slug: string): OutputChannelAdapter | undefined {
    return this.bySlug.get(slug);
  }

  /**
   * Dispatch one delivery to the bound adapter. Two-layer
   * validation:
   *   1. The delivery's slug must be in the instance's
   *      `bindings[].adapter_slug` set (closed set per Q10).
   *   2. The registry must know an adapter for that slug.
   * Either failure throws a `validation`-class error so the
   * harness's error router DLQs the run.
   */
  async deliver(invocation: OutputChannelDeliverInvocation): Promise<void> {
    const binding = invocation.bindings.find(
      (b) => b.adapter_slug === invocation.delivery.adapterSlug,
    );
    if (binding === undefined) {
      throw new OutputChannelMismatchError(
        invocation.delivery.adapterSlug,
        invocation.bindings.map((b) => b.adapter_slug),
      );
    }
    const adapter = this.bySlug.get(invocation.delivery.adapterSlug);
    if (adapter === undefined) {
      throw new OutputChannelUnknownAdapterError(
        invocation.delivery.adapterSlug,
      );
    }
    const args: OutputChannelDeliverArgs = {
      payload: invocation.delivery.payload,
      config: binding.config,
      ...(invocation.delivery.agentSlug !== undefined
        ? { agentSlug: invocation.delivery.agentSlug }
        : {}),
    };
    await adapter.deliver(args);
  }
}
