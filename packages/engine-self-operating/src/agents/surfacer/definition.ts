/**
 * Surfacer agent definition (architecture §7.2.4 / plan #102).
 * Read-only proposer — emits candidates at status='proposed'
 * via insertCandidate (Gate 1). The Review Dashboard surfaces
 * them to a human operator who approves or rejects.
 *
 * `defaultMemory: 'none'` — Surfacer is single-shot per
 * scheduled cadence; multi-run continuity isn't needed.
 */
import type { AgentDefinition } from "../../agent-harness/index.js";

export const SURFACER_DEFINITION: AgentDefinition = {
  slug: "surfacer",
  version: "1.0.0",
  description:
    "Read-only automation proposer. Reads wiki, emits candidates at status='proposed' (Gate 1).",
  outputSchemaName: "SurfacerOutput",
  defaultMemory: { type: "none" },
  // Read-only tool surface; Lint's automation_drift detector
  // flags any past tool_calls[].name not in this set.
  toolNames: ["worldview.read", "index.search", "wiki.read_page"],
  // Daily 7am UTC — Surfacer runs once per day so candidate
  // proposals land in the operator's morning Review queue. PR-M2.
  defaultScheduleCron: "0 7 * * *",
};
