import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Canonical column builders reused across every `pgTable`. Centralising
 * these keeps the schema files focused on the columns that make each
 * table distinctive, and guarantees `id` / `created_at` / `updated_at`
 * stay byte-identical in generated migrations (the differ reads the
 * builder output, not this call site).
 */

export const primaryKeyId = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Nullable `ON DELETE RESTRICT` foreign-key column. The `target` thunk
 * preserves lazy resolution so table modules can FK into each other
 * regardless of ES-module evaluation order.
 */
export const restrictFk = (name: string, target: () => PgColumn) =>
  uuid(name).references(target, { onDelete: "restrict" });

/** `NOT NULL` variant of `restrictFk`. */
export const requiredRestrictFk = (name: string, target: () => PgColumn) =>
  uuid(name).notNull().references(target, { onDelete: "restrict" });

/**
 * Nullable `ON DELETE SET NULL` foreign-key column. Used when audit
 * history must outlive the referenced row: e.g. `llm_usage.run_id` and
 * `page_citations.compiled_by_run_id` keep attribution intact even
 * after Cleanup prunes the `agent_runs` row per retention policy.
 */
export const setNullFk = (name: string, target: () => PgColumn) =>
  uuid(name).references(target, { onDelete: "set null" });
