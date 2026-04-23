import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, restrictFk, updatedAt } from "./columns.js";
import { marketplaceUpdateStatus } from "./enums.js";
import { users } from "./users.js";
import type { SkillsDiff } from "../types/index.js";

// Feed of marketplace-side skill-bundle releases the engine's live-
// fetch poll has observed (architecture §7.2.4 "Marketplace live-fetch
// loop"). One row per (marketplace_source, release_tag); `skills_diff`
// captures which bundles were added/changed/removed vs the prior
// snapshot. Operators review in the Review Dashboard and accept or
// skip — `pending` → `accepted` means the orchestrator can now hand
// the updated bundles to the Builder overlay loader.
//
// MUTATION-ADJACENT. `status` + `reviewed_*` mutate on review.
export const marketplaceUpdates = pgTable(
  "marketplace_updates",
  {
    id: primaryKeyId(),
    marketplaceSource: text("marketplace_source").notNull(),
    releaseTag: text("release_tag").notNull(),
    targetCommitish: text("target_commitish").notNull(),
    treeSha: text("tree_sha").notNull(),
    skillsDiff: jsonb("skills_diff").$type<SkillsDiff>().notNull(),
    status: marketplaceUpdateStatus("status").notNull().default("pending"),
    reviewedBy: restrictFk("reviewed_by", () => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("marketplace_updates_source_release_tag_unique").on(
      t.marketplaceSource,
      t.releaseTag,
    ),
    index("marketplace_updates_status_idx").on(t.status),
  ],
);
