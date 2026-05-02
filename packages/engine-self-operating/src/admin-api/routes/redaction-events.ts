/**
 * `GET /api/admin/redaction-events` — metadata-only redaction events list.
 *
 * Phase-a appendix #4 PR-D.
 *
 * THREAT-MODEL §3.3 COMPLIANCE — CRITICAL:
 *   This endpoint MUST NEVER return:
 *   - The `matched_byte_ranges` column (start/end offsets that allow content slicing).
 *   - Any source bytes or content that was redacted.
 *   - Any field that enables reconstruction of the original redacted content.
 *
 *   It returns ONLY metadata:
 *   - matchedByteRangesCount: the COUNT of match hits (integer), not the ranges.
 *
 * Query params:
 *   - pipeline: filter by pipeline name
 *   - guard: filter by guard_slug
 *   - category: filter by category
 *   - limit: number of rows (default 100, max 500)
 *   - offset: pagination offset (default 0)
 *
 * Append-only — GET only, no state mutations.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegisterRedactionEventsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function registerRedactionEventsRoutes(
  args: RegisterRedactionEventsRoutesArgs,
): void {
  args.app.get("/api/admin/redaction-events", async (req) => {
    const query = req.query as Record<string, string | undefined>;

    const rawLimit =
      query["limit"] !== undefined ? parseInt(query["limit"], 10) : DEFAULT_LIMIT;
    const rawOffset =
      query["offset"] !== undefined ? parseInt(query["offset"], 10) : 0;
    const parsed = isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit;
    const limit = Math.max(1, Math.min(MAX_LIMIT, parsed));
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

    const pipelineFilter = query["pipeline"] ?? null;
    const guardFilter = query["guard"] ?? null;
    const categoryFilter = query["category"] ?? null;

    // Build WHERE clause fragments dynamically. Each filter is only appended
    // when a non-null value is provided, avoiding the null-parameter pitfall
    // with PGlite (which does not reliably handle `$1 IS NULL OR col = $1`).
    //
    // NOTE: matched_byte_ranges is intentionally EXCLUDED from both SELECT
    // and COUNT — per THREAT-MODEL §3.3. We compute the count server-side
    // using jsonb_array_length() so no range data ever crosses the wire.

    // Build filter as a list of sql`` fragments composed with AND.
    const filters: ReturnType<typeof sql>[] = [];
    if (pipelineFilter !== null) {
      filters.push(sql`pipeline = ${pipelineFilter}`);
    }
    if (guardFilter !== null) {
      filters.push(sql`guard_slug = ${guardFilter}`);
    }
    if (categoryFilter !== null) {
      filters.push(sql`category = ${categoryFilter}`);
    }

    const whereClause =
      filters.length === 0
        ? sql`1=1`
        : filters.reduce((acc, f) => sql`${acc} AND ${f}`);

    const [rowsResult, countResult] = await Promise.all([
      args.db.execute(sql`
        SELECT
          id::text                                  AS id,
          pipeline                                  AS pipeline,
          domain_id::text                           AS "domainId",
          binding_id::text                          AS "bindingId",
          guard_slug                                AS "guardSlug",
          category                                  AS category,
          pattern_version                           AS "patternVersion",
          jsonb_array_length(matched_byte_ranges)   AS "matchedByteRangesCount",
          fail_mode::text                           AS "failMode",
          created_at                                AS "createdAt"
        FROM redaction_events
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `) as unknown as { rows: Array<Record<string, unknown>> },
      args.db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM redaction_events
        WHERE ${whereClause}
      `) as unknown as { rows: Array<{ total: number }> },
    ]);

    const total = countResult.rows[0]?.total ?? 0;
    const events = rowsResult.rows.map(serializeRedactionEventRow);

    return { events, total };
  });
}

/**
 * Serialize a redaction_events row for the API response.
 *
 * SECURITY: `matched_byte_ranges` is NEVER included.
 * Only `matchedByteRangesCount` (integer) is returned.
 * This is the sole sanctioned field for communicating "how many matches"
 * without enabling reconstruction of the matched content.
 */
function serializeRedactionEventRow(
  r: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: r["id"],
    pipeline: r["pipeline"],
    domainId: (r["domainId"] as string | null) ?? null,
    bindingId: (r["bindingId"] as string | null) ?? null,
    guardSlug: r["guardSlug"],
    category: r["category"],
    patternVersion: r["patternVersion"],
    // COUNT only — no byte offsets, no content bytes.
    matchedByteRangesCount: (r["matchedByteRangesCount"] as number) ?? 0,
    failMode: r["failMode"],
    createdAt: toIso(r["createdAt"] as Date | string | null),
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
