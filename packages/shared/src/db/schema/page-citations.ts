import { index, pgTable, text } from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-runs.js";
import {
  createdAt,
  primaryKeyId,
  requiredRestrictFk,
  setNullFk,
} from "./columns.js";
import { sourcesBindings } from "./sources-bindings.js";

// APPEND-ONLY per THREAT-MODEL §2 invariant 8: no updated_at, no $onUpdate,
// no mutation-path writes after insert. Source forgetting happens via
// DELETE (retention/erasure), not UPDATE.
export const pageCitations = pgTable(
  "page_citations",
  {
    id: primaryKeyId(),
    domainSlug: text("domain_slug").notNull(),
    pagePath: text("page_path").notNull(),
    sourceBindingId: requiredRestrictFk(
      "source_binding_id",
      () => sourcesBindings.id,
    ),
    sourceRef: text("source_ref").notNull(),
    // FK to agent_runs(id) is ON DELETE SET NULL — audit history
    // (which page got compiled when + from which source) outlives the
    // run row after Cleanup prunes `agent_runs` per retention policy.
    // Nulling the ref is safe; losing the citation would not be.
    compiledByRunId: setNullFk("compiled_by_run_id", () => agentRuns.id),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [
    index("page_citations_domain_slug_page_path_idx").on(
      t.domainSlug,
      t.pagePath,
    ),
    index("page_citations_source_binding_id_idx").on(t.sourceBindingId),
  ],
);
