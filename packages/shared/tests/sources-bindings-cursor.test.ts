/**
 * Migration 0004 — `sources_bindings.last_scan_cursor: text` (nullable).
 *
 * The Scanner pipeline (PR 17) persists per-binding pagination state
 * (e.g. Drive change tokens, Asana sync cursors) so a 4h-cron run
 * picks up where the previous run left off without re-fetching the
 * whole source.
 *
 * The column is intentionally `text NULL` and opaque — the engine
 * stores whatever the SourceAdapter returns. Schema-side guarantees
 * are limited to "exists, nullable, text".
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { sourcesBindings } from "../src/db/schema/index.js";

describe("sources_bindings.last_scan_cursor (PR 17 / plan #77)", () => {
  it("exists as a column on the sources_bindings table", () => {
    const cols = getTableConfig(sourcesBindings).columns.map((c) => c.name);
    expect(cols).toContain("last_scan_cursor");
  });

  it("is nullable (no notNull marker)", () => {
    const col = getTableConfig(sourcesBindings).columns.find(
      (c) => c.name === "last_scan_cursor",
    );
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });

  it("is a text column (opaque pagination cursor)", () => {
    const col = getTableConfig(sourcesBindings).columns.find(
      (c) => c.name === "last_scan_cursor",
    );
    expect(col?.dataType).toBe("string");
  });
});
