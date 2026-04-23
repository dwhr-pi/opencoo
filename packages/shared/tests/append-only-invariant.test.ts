import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import {
  agentRuns,
  erasureLog,
  minerSuppressions,
  pageCitations,
  redactionEvents,
} from "../src/db/schema/index.js";

// The tables named in THREAT-MODEL §2 invariant 8 as "append-only".
// `catalog_candidate` is MUTATION-ADJACENT (sanctioned status/reviewed_*
// UPDATE targets) and explicitly excluded from this invariant.
const APPEND_ONLY_TABLES: ReadonlyArray<{ name: string; table: PgTable }> = [
  { name: "page_citations", table: pageCitations },
  { name: "redaction_events", table: redactionEvents },
  { name: "erasure_log", table: erasureLog },
  { name: "miner_suppressions", table: minerSuppressions },
  { name: "agent_runs", table: agentRuns },
];

// Any column name matching this regex is a potential mutation-timestamp
// leak, unless it's in the allow-list below.
const TIMESTAMP_RE = /_at$/;

// `created_at` is the insertion timestamp every table carries and is
// not a mutation record. `started_at` + `ended_at` on `agent_runs` are
// the run's open/close markers — the row is INSERTed at start with
// `ended_at` NULL, and one-shot UPDATEd at close to set `ended_at` +
// `status`/`output`. That single terminal update is the sanctioned
// close transition (not a mutation-history column) and is enforced
// separately by the `opencoo/no-update-append-only` ESLint rule.
const APPEND_ONLY_TIMESTAMP_ALLOW_LIST: ReadonlySet<string> = new Set([
  "created_at",
  "started_at",
  "ended_at",
]);

describe("append-only invariant (THREAT-MODEL §2 invariant 8)", () => {
  for (const { name, table } of APPEND_ONLY_TABLES) {
    describe(name, () => {
      it("has no updated_at / modified_at / edited_at column", () => {
        const cols = getTableConfig(table).columns.map((c) => c.name);
        for (const forbidden of ["updated_at", "modified_at", "edited_at"]) {
          expect(cols).not.toContain(forbidden);
        }
      });

      it("has no other mutation-timestamp columns (anything *_at except created_at)", () => {
        const cols = getTableConfig(table).columns.map((c) => c.name);
        const offenders = cols
          .filter((c) => TIMESTAMP_RE.test(c))
          .filter((c) => !APPEND_ONLY_TIMESTAMP_ALLOW_LIST.has(c));
        expect(offenders).toEqual([]);
      });
    });
  }
});
