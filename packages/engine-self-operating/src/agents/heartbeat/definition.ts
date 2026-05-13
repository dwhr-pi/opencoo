/**
 * Heartbeat agent definition (architecture §9.4). Read-only;
 * the engine post-run hook delivers the JSON output to the
 * channels in the instance's `output_channel_ids` binding.
 *
 * `defaultMemory` is `run-history` (count 5) so the agent can
 * see its previous briefings and avoid duplicating yesterday's
 * lead. The harness spotlights every memory entry before the
 * prompt sees it (THREAT-MODEL §3.5).
 */
import type { AgentDefinition } from "../../agent-harness/index.js";

export const HEARTBEAT_DEFINITION: AgentDefinition = {
  slug: "heartbeat",
  version: "1.0.0",
  description:
    "Daily proactive briefing. Read-only — emits ≤5 alerts, leads with priority-1.",
  outputSchemaName: "HeartbeatOutput",
  defaultMemory: { type: "run-history", count: 5 },
  // Read-only tool surface. The automation_drift Lint detector
  // (plan #97 Q6) flags any past tool_calls[].name not in this
  // set — evidence of a tool slipped in without being declared.
  //
  // `wiki.read_page` (added in PR-Y10) is used by the runner to
  // drill into worldview-referenced pages (≤5 per run, gated by
  // page-index intersection — see `page-drilldown.ts`). The
  // runner picks the paths deterministically; the LLM doesn't
  // get a tool-use loop. The drill-down stays domain-scoped
  // because the page index is domain-scoped by the wiki adapter
  // and the domain was scope-checked at the top of the run.
  toolNames: ["worldview.read", "index.search", "wiki.read_page"],
  // Weekday mornings, 8am UTC. The PoC heartbeat fires at the
  // start of the operator's working day; the OSS spec carries
  // that cadence forward (architecture.md §9.4). PR-M2.
  defaultScheduleCron: "0 8 * * 1-5",
};
