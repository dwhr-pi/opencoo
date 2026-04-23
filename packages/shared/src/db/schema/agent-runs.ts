import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { agentInstances } from "./agent-instances.js";
import { createdAt, primaryKeyId, requiredRestrictFk } from "./columns.js";
import {
  agentRunStatus,
  agentTrigger,
  errorClass,
} from "./enums.js";
import type { SkillsUsed, ToolCall } from "../types/index.js";

// APPEND-ONLY per THREAT-MODEL §2 invariant 8. One row per agent
// invocation; the harness records inputs/outputs/tokens/cost/latency
// plus the tool-call trace. `skills_used` is Builder-only — other
// agents default to `[]`.
//
// `definition_slug` is a logical text ref (same rationale as
// `agent_instances.definition_slug`). `instance_id` is a hard FK
// ON DELETE RESTRICT — deleting an instance with run history is an
// explicit admin action, not a cascade.
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: primaryKeyId(),
    definitionSlug: text("definition_slug").notNull(),
    instanceId: requiredRestrictFk("instance_id", () => agentInstances.id),
    trigger: agentTrigger("trigger").notNull(),
    inputs: jsonb("inputs").notNull().default(sql`'{}'::jsonb`),
    toolCalls: jsonb("tool_calls")
      .$type<ToolCall[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    output: jsonb("output").$type<unknown>(),
    skillsUsed: jsonb("skills_used")
      .$type<SkillsUsed>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 })
      .notNull()
      .default(sql`'0'`),
    latencyMs: integer("latency_ms").notNull().default(0),
    status: agentRunStatus("status").notNull(),
    errorClass: errorClass("error_class"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_runs_instance_id_started_at_idx").on(
      t.instanceId,
      t.startedAt.desc(),
    ),
    index("agent_runs_definition_slug_started_at_idx").on(
      t.definitionSlug,
      t.startedAt.desc(),
    ),
    index("agent_runs_status_idx").on(t.status),
  ],
);
