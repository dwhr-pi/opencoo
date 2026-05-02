/**
 * `opencoo agents seed` (PR-M2, phase-a appendix #5).
 *
 * Idempotent default-instance seeder. For every agent definition
 * that carries a `defaultScheduleCron`, INSERT one
 * `agent_instances` row with:
 *
 *   name             = `<slug>-default`
 *   definition_slug  = <slug>
 *   schedule_cron    = <definition.defaultScheduleCron>
 *   scope_domain_ids = `{}` (empty — operator scopes later via UI)
 *   output_channel_ids = `[]`
 *   enabled          = true
 *   locale           = 'en'
 *
 * The INSERT uses
 * `ON CONFLICT (definition_slug, name) DO NOTHING` against the
 * existing unique constraint so re-running the verb is a no-op
 * once the rows exist.
 *
 * Exit codes:
 *   - 0 — seeding finished (with or without new rows inserted)
 *   - 2 — DB unreachable / SQL failure
 *
 * The verb is wired in `bin.ts` alongside `migrate` / `setup` /
 * `doctor`. The dispatcher reads the seeded rows on engine boot.
 */
import pc from "picocolors";
import type { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

import {
  HEARTBEAT_DEFINITION,
  LINT_DEFINITION,
  SURFACER_DEFINITION,
  type AgentDefinition,
} from "@opencoo/engine-self-operating";

import {
  exitOk,
  exitRuntimeError,
  isExitSentinel,
} from "../lib/exit.js";
import { openPool } from "../lib/db.js";

/** Definitions seeded by this verb. v0.1: Heartbeat, Lint, Surfacer
 *  — every scheduled-class agent. Chat + Builder are on-demand and
 *  intentionally excluded. */
const SEEDABLE_DEFINITIONS: readonly AgentDefinition[] = [
  HEARTBEAT_DEFINITION,
  LINT_DEFINITION,
  SURFACER_DEFINITION,
];

type Db = NodePgDatabase<Record<string, never>>;

export interface AgentsSeedArgs {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to a `pg.Pool` via `openPool`
   *  + a fresh Drizzle handle. Tests inject a pglite-backed Drizzle
   *  to avoid spinning up Postgres. */
  readonly dbFactory?: (env: Record<string, string | undefined>) => Db;
  /** @internal Test seam — defaults to `pool.end()`. When the test
   *  injects `dbFactory`, it also injects `closePool` so the
   *  in-memory DB is not double-closed. */
  readonly closePool?: () => Promise<void>;
}

interface SeedRow {
  readonly definitionSlug: string;
  readonly name: string;
  readonly scheduleCron: string;
}

interface ExecResult {
  readonly rowCount?: number;
  readonly affectedRows?: number;
  readonly rows: ReadonlyArray<unknown>;
}

function buildRows(): readonly SeedRow[] {
  // SEEDABLE_DEFINITIONS is curated to only include scheduled-class
  // agents (Heartbeat, Lint, Surfacer) — every entry has a
  // defaultScheduleCron. The defensive narrow keeps a future
  // entry without a schedule from accidentally seeding a NULL
  // schedule_cron value.
  return SEEDABLE_DEFINITIONS.flatMap((def) =>
    def.defaultScheduleCron === undefined
      ? []
      : [
          {
            definitionSlug: def.slug,
            name: `${def.slug}-default`,
            scheduleCron: def.defaultScheduleCron,
          },
        ],
  );
}

export async function runAgentsSeed(args: AgentsSeedArgs): Promise<void> {
  // Test path supplies dbFactory + (optionally) closePool. Production
  // path opens a pg.Pool here and drains it in the finally block.
  let db: Db;
  let closePool: () => Promise<void>;
  if (args.dbFactory !== undefined) {
    db = args.dbFactory(args.env);
    closePool = args.closePool ?? (async (): Promise<void> => undefined);
  } else {
    const pool: Pool = openPool({ env: args.env });
    db = drizzle(pool);
    closePool =
      args.closePool ??
      (async (): Promise<void> => {
        await pool.end().catch(() => undefined);
      });
  }

  try {
    const rows = buildRows();
    let inserted = 0;
    for (const row of rows) {
      const result = (await db.execute(sql`
        INSERT INTO agent_instances
          (definition_slug, name, scope_domain_ids, output_channel_ids,
           schedule_cron, memory, locale, enabled)
        VALUES (
          ${row.definitionSlug},
          ${row.name},
          '{}'::uuid[],
          '[]'::jsonb,
          ${row.scheduleCron},
          '{}'::jsonb,
          'en',
          true
        )
        ON CONFLICT (definition_slug, name) DO NOTHING
        RETURNING id
      `)) as unknown as ExecResult;
      const affected =
        result.rowCount ?? result.affectedRows ?? result.rows.length;
      if (affected > 0) inserted += 1;
    }
    if (inserted === rows.length) {
      args.stdout.write(
        pc.green(
          `agents seed: ${inserted} created (heartbeat, lint, surfacer)\n`,
        ),
      );
    } else if (inserted === 0) {
      args.stdout.write(
        pc.dim(
          `agents seed: 0 created (already seeded; ${rows.length} default rows present)\n`,
        ),
      );
    } else {
      args.stdout.write(
        pc.green(
          `agents seed: ${inserted} created, ${rows.length - inserted} already present\n`,
        ),
      );
    }
    return exitOk();
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(
        `agents seed: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return exitRuntimeError();
  } finally {
    await closePool();
  }
}
