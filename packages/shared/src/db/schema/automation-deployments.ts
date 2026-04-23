import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-runs.js";
import { automationCandidates } from "./automation-candidates.js";
import {
  createdAt,
  primaryKeyId,
  requiredRestrictFk,
  updatedAt,
} from "./columns.js";
import { automationDeploymentStatus } from "./enums.js";
import type { SkillsUsed } from "../types/index.js";

// One row per n8n workflow the Builder agent produced from an
// approved candidate. Snapshots the `skills_used` set at build time —
// if the marketplace later bumps a skill bundle's version, the
// snapshot still shows which SHA the deployed workflow was built
// against.
//
// MUTATION-ADJACENT. `status` transitions `deployed` → `activated` →
// `deactivated` / `removed` as the Lint agent's automation-drift
// check observes n8n state.
//
// IMPORTANT — `activated_at` is observation-only. opencoo NEVER
// writes to n8n activation (Gate 3 invariant: activation stays a
// manual n8n-side step, no admin toggle, no CLI override per
// THREAT-MODEL §2 invariant 7). Lint reads n8n, observes the
// `active: true` state, and mirrors it here. If you find yourself
// adding a code path that writes this column from a user action,
// stop — that's Gate 3 bypass.
export const automationDeployments = pgTable(
  "automation_deployments",
  {
    id: primaryKeyId(),
    candidateId: requiredRestrictFk(
      "candidate_id",
      () => automationCandidates.id,
    ),
    builderRunId: requiredRestrictFk("builder_run_id", () => agentRuns.id),
    n8nWorkflowId: text("n8n_workflow_id").notNull().unique(),
    skillsUsedSnapshot: jsonb("skills_used_snapshot")
      .$type<SkillsUsed>()
      .notNull(),
    status: automationDeploymentStatus("status")
      .notNull()
      .default("deployed"),
    deployedAt: timestamp("deployed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** observation-only — see file header; Gate 3 invariant */
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("automation_deployments_status_idx").on(t.status),
    index("automation_deployments_candidate_id_idx").on(t.candidateId),
  ],
);
