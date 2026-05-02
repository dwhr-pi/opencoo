/**
 * Scheduler tab — read-only listing of every recurring agent
 * dispatch the in-process scheduler currently has registered
 * (PR-M2, phase-a appendix #5).
 *
 * `GET /api/admin/scheduler`
 *   Returns a flat `{ schedules: [...] }` snapshot with
 *   `instanceId`, `definitionSlug`, `name`, `scheduleCron`,
 *   `nextFireAt` (computed via `cron-parser`), and `lastFireAt`
 *   (most recent `agent_runs.started_at` for the instance, or
 *   `null` if the instance has never fired).
 *
 * The route reads the schedule snapshot from an injected
 * `SchedulerSource` (the production wiring passes the
 * AgentDispatcher); this keeps the route handler decoupled from
 * the dispatcher class for testability and to satisfy the
 * `no-cross-engine-import` lint rule (the route lives in
 * engine-self-operating, the dispatcher does too — no boundary
 * crossing here, but the source-injection pattern keeps the
 * surface narrow).
 *
 * Read-only; no state-changing actions per THREAT-MODEL §2
 * invariant 8. Auth is handled by the `verifyAdmin` wrapper that
 * `registerAdminApi` applies at registration time — this file
 * does not gate the route itself.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

import { nextFireAt } from "../../scheduler/cron-validate.js";
import type { RegisteredSchedule } from "../../scheduler/agent-dispatcher.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Narrow surface the route reads from. The production wiring
 *  passes the AgentDispatcher (which exposes `listSchedules()`);
 *  tests inject a literal stub. */
export interface SchedulerSource {
  listSchedules(): readonly RegisteredSchedule[];
}

export interface RegisterSchedulerRouteArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly source: SchedulerSource;
  /** Optional clock seam for deterministic nextFireAt tests. */
  readonly now?: () => Date;
}

interface AgentRunStartedRow {
  readonly instance_id: string;
  readonly started_at: Date | string | null;
}

export function registerSchedulerRoute(
  args: RegisterSchedulerRouteArgs,
): void {
  const now = args.now ?? ((): Date => new Date());
  args.app.get("/api/admin/scheduler", async () => {
    const schedules = args.source.listSchedules();
    if (schedules.length === 0) {
      return { schedules: [] };
    }
    const instanceIds = schedules.map((s) => s.instanceId);
    const lastFireMap = await loadLastFireMap(args.db, instanceIds);
    const fromTs = now();
    const enriched = schedules.map((s) => ({
      instanceId: s.instanceId,
      definitionSlug: s.definitionSlug,
      name: s.name,
      scheduleCron: s.scheduleCron,
      nextFireAt: toIso(nextFireAt(s.scheduleCron, fromTs)),
      lastFireAt: toIso(lastFireMap.get(s.instanceId) ?? null),
    }));
    return { schedules: enriched };
  });
}

/** Load the most recent `agent_runs.started_at` per instance id. */
async function loadLastFireMap(
  db: Db,
  instanceIds: readonly string[],
): Promise<Map<string, Date | string | null>> {
  const out = new Map<string, Date | string | null>();
  if (instanceIds.length === 0) return out;
  // Aggregate in one query rather than N+1 — operator may have
  // many scheduled instances. Use sql.join for parameterized IN
  // binding so Postgres treats the ids as values (not as SQL
  // text); ids are scheduler-internal but defence-in-depth keeps
  // the boundary clean if an upstream ever lets an attacker shape
  // a RegisteredSchedule.instanceId.
  const idParams = sql.join(
    instanceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = (await db.execute(sql`
    SELECT instance_id::text AS instance_id,
           MAX(started_at)   AS started_at
    FROM agent_runs
    WHERE instance_id::text IN (${idParams})
    GROUP BY instance_id
  `)) as unknown as { rows: AgentRunStartedRow[] };
  for (const row of result.rows) {
    out.set(row.instance_id, row.started_at);
  }
  return out;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
