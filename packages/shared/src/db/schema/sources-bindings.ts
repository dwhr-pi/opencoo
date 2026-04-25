import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, updatedAt } from "./columns.js";
import { credentials } from "./credentials.js";
import { domains } from "./domains.js";
import { reviewMode } from "./enums.js";

export const sourcesBindings = pgTable(
  "sources_bindings",
  {
    id: primaryKeyId(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    adapterSlug: text("adapter_slug").notNull(),
    sourceId: text("source_id"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    allowedPaths: text("allowed_paths")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reviewMode: reviewMode("review_mode").notNull().default("auto"),
    scheduleCron: text("schedule_cron"),
    credentialsId: uuid("credentials_id").references(() => credentials.id, {
      onDelete: "restrict",
    }),
    retentionDaysOverride: integer("retention_days_override"),
    enabled: boolean("enabled").notNull().default(true),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    /** Opaque pagination cursor persisted across Scanner runs so a
     *  4h-cron pickup resumes where the previous run left off
     *  (PR 17 / plan #77). The engine does not parse the value —
     *  shape is whatever the SourceAdapter returned last time. */
    lastScanCursor: text("last_scan_cursor"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sources_bindings_domain_id_adapter_slug_idx").on(
      t.domainId,
      t.adapterSlug,
    ),
  ],
);
