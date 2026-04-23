import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-runs.js";
import {
  createdAt,
  primaryKeyId,
  requiredRestrictFk,
  restrictFk,
  updatedAt,
} from "./columns.js";
import { automationCandidateStatus } from "./enums.js";
import { users } from "./users.js";
import type { PageRef, Proposal } from "../types/index.js";

// Five-state review queue for Surfacer-produced automation proposals
// (architecture §7.2.4). Surfacer reads the wiki and proposes
// automations as `proposed`; operators approve / reject; Builder
// picks up `approved` rows and produces `built`; otherwise the
// candidate ends as `rejected` or `skipped`.
//
// MUTATION-ADJACENT — `status`, `rationale`, `reviewed_*` mutate as
// the operator moves rows through the queue.
export const automationCandidates = pgTable(
  "automation_candidates",
  {
    id: primaryKeyId(),
    surfacerRunId: requiredRestrictFk("surfacer_run_id", () => agentRuns.id),
    sourcePageRefs: jsonb("source_page_refs")
      .$type<PageRef[]>()
      .notNull(),
    proposal: jsonb("proposal").$type<Proposal>().notNull(),
    status: automationCandidateStatus("status")
      .notNull()
      .default("proposed"),
    rationale: text("rationale"),
    reviewedBy: restrictFk("reviewed_by", () => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("automation_candidates_status_idx").on(t.status),
    index("automation_candidates_surfacer_run_id_idx").on(t.surfacerRunId),
  ],
);
