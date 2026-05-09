import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, updatedAt } from "./columns.js";
import { domainClass, governanceCadence } from "./enums.js";
import type { LlmPolicy } from "../types/llm-policy.js";

export const domains = pgTable(
  "domains",
  {
    id: primaryKeyId(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    class: domainClass("class").notNull().default("knowledge"),
    locale: text("locale").notNull().default("en"),
    governanceCadence: governanceCadence("governance_cadence")
      .notNull()
      .default("continuous"),
    reviewRole: text("review_role"),
    llmPolicy: jsonb("llm_policy")
      .$type<LlmPolicy>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    llmBudgetMonthlyCapUsd: numeric("llm_budget_monthly_cap_usd", {
      precision: 10,
      scale: 2,
    }),
    retentionDays: integer("retention_days"),
    worldviewEnabled: boolean("worldview_enabled").notNull().default(true),
    /**
     * `true` for the (at most one) aggregator domain that
     * compiles `company.md` from every other domain's
     * `worldview.md` (architecture §9.6 / plan #106).
     * Sovereignty constraint: the company-compile pipeline
     * MUST NOT read non-`worldview.md` paths from domains
     * where this is `false`. Test-pinned via a readPage spy.
     */
    isAggregator: boolean("is_aggregator").notNull().default(false),
    /**
     * Soft-delete marker (phase-a appendix #10 PR-R1). When non-null
     * the domain is retired: hidden from the default Domains listing
     * and from aggregator-uniqueness checks. Re-enabling is NOT in
     * v0.1 scope — soft-delete is a one-way valve, the operator
     * creates a new domain to recover. The Gitea repo is NOT deleted
     * by the soft-delete; ops removes that separately if desired.
     */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "domains_slug_format",
      sql`${t.slug} ~ '^[a-z][a-z0-9-]{1,62}$'`,
    ),
    check("domains_locale_allowed", sql`${t.locale} IN ('en', 'pl', 'auto')`),
    // Listing query filters `disabled_at IS NULL` and orders by slug.
    // Composite index keeps the default Domains tab fast even as the
    // disabled set grows.
    index("domains_disabled_at_slug_idx").on(t.disabledAt, t.slug),
  ],
);
