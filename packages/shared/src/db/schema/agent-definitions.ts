import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, updatedAt } from "./columns.js";

// Metadata-only mirror of the TypeScript-authored agent definitions
// (architecture §17 Resolved "Agent harness shape" — the canonical
// definition lives in `packages/engine-self-operating/src/agents/*`).
// This table records registration metadata (slug, version, output
// schema name, default memory config) so the UI can render the agent
// catalog and the Review Dashboard can look up an agent by slug without
// importing from the engine package.
//
// Mutation-adjacent: `updated_at` ticks on re-registration, e.g. when
// the harness boots with a bumped `version`.
export const agentDefinitions = pgTable("agent_definitions", {
  id: primaryKeyId(),
  slug: text("slug").notNull().unique(),
  version: text("version").notNull(),
  description: text("description").notNull(),
  outputSchemaName: text("output_schema_name").notNull(),
  defaultMemory: jsonb("default_memory").notNull().default(sql`'{}'::jsonb`),
  registeredAt: timestamp("registered_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
