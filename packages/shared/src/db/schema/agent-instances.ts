import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, updatedAt } from "./columns.js";
import type {
  InstanceMemory,
  OutputChannelRef,
} from "../types/index.js";

// A per-deployment configuration of an agent definition: which
// definition to run, under what name, over which domains, writing to
// which output channels, on what schedule (or unscheduled — the
// harness may trigger on-demand via MCP).
//
// `definition_slug` is a logical text reference rather than a FK —
// the canonical definition lives in TypeScript under
// `packages/engine-self-operating/`. `scope_domain_ids` is uuid[]
// without an FK by design: domain deletion should NOT cascade-
// invalidate instance config (admin review of what to do with
// orphaned scopes is a §6.5 read-time concern, not a schema-time
// cascade).
export const agentInstances = pgTable(
  "agent_instances",
  {
    id: primaryKeyId(),
    definitionSlug: text("definition_slug").notNull(),
    name: text("name").notNull(),
    scopeDomainIds: uuid("scope_domain_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    outputChannelIds: jsonb("output_channel_ids")
      .$type<OutputChannelRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    scheduleCron: text("schedule_cron"),
    memory: jsonb("memory")
      .$type<InstanceMemory>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    locale: text("locale").notNull().default("en"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "agent_instances_locale_allowed",
      sql`${t.locale} IN ('en', 'pl', 'auto')`,
    ),
    unique("agent_instances_definition_slug_name_unique").on(
      t.definitionSlug,
      t.name,
    ),
  ],
);
