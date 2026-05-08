/**
 * `opencoo agents seed` (PR-M2, phase-a appendix #5; PR-Q8 / appendix #9).
 *
 * Idempotent default-instance seeder. For every agent definition
 * that carries a `defaultScheduleCron`, INSERT one
 * `agent_instances` row with:
 *
 *   name             = `<slug>-default`
 *   definition_slug  = <slug>
 *   schedule_cron    = <definition.defaultScheduleCron>
 *   scope_domain_ids = `{<resolved-domain-uuid>}` (PR-Q8)
 *   output_channel_ids = `[]`
 *   memory           = `{"type":"none"}` (PR-Q8 — explicit; the
 *                       harness's exhaustive switch in
 *                       `loadInstanceMemory` throws on `{}`)
 *   enabled          = true
 *   locale           = 'en'
 *
 * Domain resolution (PR-Q8):
 *   - `--domain <slug>` provided → resolve to the matching `domains`
 *     row; fail cleanly when the slug doesn't exist.
 *   - `--domain` omitted AND exactly one domain row exists → auto-pick
 *     it (matches the first-boot single-domain pilot deployment).
 *   - `--domain` omitted AND multiple domain rows exist → fail with a
 *     clear list of available slugs. Operator must rerun with a flag.
 *   - `--domain` omitted AND zero domain rows exist → fail with a
 *     `+ New domain` UI hint.
 *
 * The INSERT uses
 * `ON CONFLICT (definition_slug, name) DO NOTHING` against the
 * existing unique constraint so re-running the verb is a no-op
 * once the rows exist.
 *
 * Exit codes:
 *   - 0 — seeding finished (with or without new rows inserted)
 *   - 2 — DB unreachable / SQL failure / domain resolution failure
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
  /** PR-Q8 — required-when-multi-domain-exists `--domain <slug>` flag.
   *  Resolves to the matching `domains.id`; the resolved UUID becomes
   *  the (single-element) `scope_domain_ids[]` for every seeded row.
   *  Omitted = auto-pick when exactly one domain exists. */
  readonly domainSlug?: string;
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

type DomainResolution =
  | { readonly ok: true; readonly domainId: string }
  | { readonly ok: false; readonly error: string };

interface DomainRow {
  id: string;
  slug: string;
}

/** PR-Q8 — resolve the seed scope-domain id from the operator's
 *  `--domain <slug>` arg, with single-domain auto-pick.
 *
 *  Four paths:
 *    1. `slug` provided — SELECT by slug; not-found is a clean fail.
 *    2. `slug` undefined + zero domains → fail with `+ New domain` hint.
 *    3. `slug` undefined + one domain → auto-pick; this is the typical
 *       first-boot pilot path.
 *    4. `slug` undefined + multiple domains → fail with the slug list
 *       so the operator can copy one back into the verb.
 */
async function resolveScopeDomainId(
  db: Db,
  domainSlug: string | undefined,
): Promise<DomainResolution> {
  if (domainSlug !== undefined) {
    const result = (await db.execute(sql`
      SELECT id::text AS id, slug FROM domains WHERE slug = ${domainSlug} LIMIT 1
    `)) as unknown as { rows: DomainRow[] };
    const row = result.rows[0];
    if (row === undefined) {
      return {
        ok: false,
        error: `--domain '${domainSlug}': no such domain (no row in domains table). Run \`opencoo agents seed\` after creating the domain via the management UI.`,
      };
    }
    return { ok: true, domainId: row.id };
  }
  // No flag — discover available domains.
  const result = (await db.execute(sql`
    SELECT id::text AS id, slug FROM domains ORDER BY slug
  `)) as unknown as { rows: DomainRow[] };
  const rows = result.rows;
  if (rows.length === 0) {
    return {
      ok: false,
      error:
        "no domains exist — open the management UI and use `+ New domain` to create one before seeding agent instances",
    };
  }
  if (rows.length === 1) {
    return { ok: true, domainId: rows[0]!.id };
  }
  const slugList = rows.map((r) => r.slug).join(", ");
  return {
    ok: false,
    error: `multiple domains exist (${slugList}); rerun with \`--domain <slug>\` to pick one`,
  };
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
    // PR-Q8 — resolve scope_domain_ids[] from `--domain <slug>` (or
    // auto-pick the sole domain). On any resolution failure, write a
    // clean stderr line and exit 2; agent_instances stays untouched.
    const resolution = await resolveScopeDomainId(db, args.domainSlug);
    if (!resolution.ok) {
      args.stderr.write(pc.red(`agents seed: ${resolution.error}\n`));
      return exitRuntimeError();
    }
    const scopeDomainId = resolution.domainId;

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
          ARRAY[${scopeDomainId}::uuid]::uuid[],
          '[]'::jsonb,
          ${row.scheduleCron},
          '{"type":"none"}'::jsonb,
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
