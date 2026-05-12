/**
 * `OutputChannelAdapter` — engine-internal port for delivery
 * of agent JSON payloads to a downstream channel post-LLM
 * (Slack, email, Asana, webhooks).
 *
 * # Naming note — distinct from `OutputAdapter`
 *
 * This port is the engine-internal Q10 binding-enforcement
 * surface (architecture §9.4, THREAT-MODEL §3.5). The
 * `OutputChannelRegistry` cross-checks the agent's invocation
 * against `agent_instances.output_channel_ids[]` BEFORE
 * dispatching, so a prompt-injection attack on the agent
 * cannot redirect the payload to a different audience.
 *
 * `OutputAdapter<TPayload>` (`@opencoo/shared/output-adapter`,
 * PR 24 / plan #115) is the broader architectural port for
 * "writes to external systems" — concrete adapter packages
 * (`@opencoo/output-asana`, future Slack / email) implement
 * THAT. In v0.1 the two are decoupled; a future bridge package
 * will fan an `OutputChannelAdapter.deliver` call out to one
 * or more `OutputAdapter.write` calls. Keeping them separate
 * preserves Q10 binding enforcement at the engine layer
 * independently of where the actual external write lives.
 *
 * Each delivery carries:
 *   - `payload` — the agent's JSON output (already validated
 *     against the agent's `outputSchemaName`).
 *   - `config` — the per-binding adapter config from
 *     `agent_instances.output_channel_ids[].config` (e.g.
 *     `{ channel: "#opencoo-heartbeat" }` for Slack). The
 *     binding's config is the closed set; the registry uses
 *     it verbatim.
 */
export interface OutputChannelAdapter {
  /** Stable slug identifying the adapter. Concrete adapters
   *  declare a single slug and are looked up by it via
   *  `OutputChannelRegistry.get(slug)`. */
  readonly adapterSlug: string;
  /** Deliver one payload. Concrete implementations implement
   *  the side-effecting step (HTTP POST, SDK call, etc.).
   *  Failures throw — the caller (registry / agent post-run
   *  hook) maps to error class. */
  deliver(args: OutputChannelDeliverArgs): Promise<void>;
}

export interface OutputChannelDeliverArgs {
  readonly payload: unknown;
  readonly config: Record<string, unknown>;
  /** PR-W2 (phase-a appendix #13) — the agent's
   *  `agent_instances.definition_slug` so the bridge can
   *  dispatch the right per-(agent, adapter) payload
   *  transformer. Optional for backward-compat with adapters
   *  that don't care (e.g. mock adapters used in unit tests);
   *  the production CLI bridge threads it through the
   *  registry → adapter chain. */
  readonly agentSlug?: string;
}
