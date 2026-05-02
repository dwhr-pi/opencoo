/**
 * `GET /api/admin/heartbeat` — latest Heartbeat agent run output per domain.
 *
 * Phase-a appendix #4 PR-D.
 *
 * Returns the latest `agent_runs.output` per `instance_id` group for
 * `definition_slug='heartbeat'` runs that have a non-null output
 * (i.e. completed runs only).
 *
 * IMPORTANT: this endpoint reads agent_runs.output directly — the same
 * HeartbeatOutput object that the OutputAdapter delivers. No LLM re-call
 * is made. (THREAT-MODEL §2 invariant 11 is satisfied because we are reading
 * already-stored output, not logging prompts; the output field itself is
 * the structured JSON artifact, not raw LLM text.)
 *
 * Response shape per report:
 *   - runId: string (UUID) — deep-link into /api/admin/agent-runs/:id
 *   - instanceId: string | null
 *   - instanceName: string | null — resolved from agent_instances.name
 *   - startedAt: string | null
 *   - output: HeartbeatOutput (version, summary, alerts[])
 *
 * Append-only — GET only, no state mutations.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegisterHeartbeatRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerHeartbeatRoutes(
  args: RegisterHeartbeatRoutesArgs,
): void {
  args.app.get("/api/admin/heartbeat", async () => {
    // Fetch the latest completed heartbeat run per instance_id group.
    // NULL instance_id is treated as its own group (no-instance runs).
    // Only rows with non-null output are returned (running/failed excluded).
    // Inner query: pick the latest completed run per instance_id group.
    // Outer query: order groups by recency so the most recently active
    // instance appears first in the response.
    const result = (await args.db.execute(sql`
      SELECT *
      FROM (
        SELECT DISTINCT ON (ar.instance_id)
          ar.id::text           AS "runId",
          ar.instance_id::text  AS "instanceId",
          ai.name               AS "instanceName",
          ar.started_at         AS "startedAt",
          ar.output             AS output
        FROM agent_runs ar
        LEFT JOIN agent_instances ai ON ai.id = ar.instance_id
        WHERE ar.definition_slug = 'heartbeat'
          AND ar.output IS NOT NULL
        ORDER BY ar.instance_id, ar.started_at DESC
      ) latest
      ORDER BY "startedAt" DESC
    `)) as unknown as {
      rows: Array<Record<string, unknown>>;
    };

    const reports = result.rows.map((r) => ({
      runId: r["runId"] as string,
      instanceId: (r["instanceId"] as string | null) ?? null,
      instanceName: (r["instanceName"] as string | null) ?? null,
      startedAt: toIso(r["startedAt"] as Date | string | null),
      output: r["output"] as unknown,
    }));

    return { reports };
  });
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
