/**
 * `opencoo agents fire <slug>` (PR-O2, phase-a appendix #7).
 *
 * Manual-trigger verb for scheduled-class agents. Resolves a
 * definition slug to an `agent_instances` row, looks up the runner
 * closure in the production registry, and invokes the harness
 * directly — bypassing BullMQ. The harness records the run with
 * `trigger='http'` (the `agent_trigger` Postgres enum has no
 * `'manual'` value in v0.1 and this PR explicitly avoids a schema
 * change) plus `inputs.firedBy='cli'` so the audit trail
 * distinguishes operator-CLI runs from cron dispatches and from
 * future admin-UI "Run now" presses.
 *
 * # Why this exists
 *
 * Without this verb, an operator who wants to verify the
 * Heartbeat / Lint chain works against their data has to wait
 * for the next cron tick (next weekday 8am for Heartbeat) or
 * insert directly into `agent_runs` via psql — neither of which
 * exercises the runner registry, the LLM router, or the MCP
 * wiki-read path. `agents fire heartbeat` is the cutover-readiness
 * smoke: one command, one harness invocation, one `agent_runs`
 * row recorded.
 *
 * # Asymmetry: no SSE bus
 *
 * The CLI is operator-side; no UI is listening. Manual-fire runs
 * still record an `agent_runs` row (audit), but they don't emit
 * onto the Activity-feed bus. Operators who want feed visibility
 * trigger via the management UI's per-instance "Run now" surface
 * (phase-b) — for v0.1 the runbook §4 documents the asymmetry so
 * operators don't bisect missing-event noise.
 *
 * # Exit codes
 *
 *   - 0 — dispatch succeeded (the run row may be `success` OR
 *         `failed`; status is in the stdout line)
 *   - 1 — operator error: slug not found, ambiguous slug,
 *         `--instance-id` mismatch, runner not in registry
 *   - 2 — runtime error: agent runners unavailable
 *         (`MCP_BEARER_TOKEN` unset / DB unreachable),
 *         harness threw before recording the run row
 */
import pc from "picocolors";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  AgentInstanceNotFoundError,
  invokeAgent,
  loadInstanceById,
  type AgentInstance,
} from "@opencoo/engine-self-operating";
import {
  ConsoleLogger,
  type Logger,
} from "@opencoo/shared/logger";
import { scrubPat } from "@opencoo/shared/scrub";

import {
  exitOk,
  exitRuntimeError,
  exitUserError,
  isExitSentinel,
} from "../lib/exit.js";
import {
  tryComposeAgentRunnersBundleFromEnv,
} from "../provision/production-composition.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Cap matches the THREAT-MODEL §3.6 invariant 11 ceiling used by
 *  `production-composition.ts:safeError`. The runner-throw branch
 *  surfaces `Error.message`; if a future runner closes over a
 *  credential value, the scrub + cap pipeline keeps it out of
 *  stderr. */
const ERROR_MESSAGE_MAX_LENGTH = 200;
function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubPat(raw).slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

interface MinimalInstanceRow {
  readonly id: string;
  readonly definitionSlug: string;
}

/** RFC-4122 UUID matcher. The CLI validates `--instance-id`
 *  upfront so a typo gives an operator-friendly message instead
 *  of a Postgres-side `invalid input syntax for type uuid`
 *  bubbling through the runtime-error catch as exit 2. */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentsFireArgs {
  readonly env: Record<string, string | undefined>;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  readonly slug: string;
  readonly instanceId?: string;
  readonly dryRun?: boolean;
  /** @internal Test seam — defaults to a silent `ConsoleLogger`. */
  readonly logger?: Logger;
  /** @internal Test seam — defaults to
   *  `tryComposeAgentRunnersBundleFromEnv`. Tests stub this to
   *  swap the bundle (in-memory pool, registered-runner set). */
  readonly composeBundle?: typeof tryComposeAgentRunnersBundleFromEnv;
  /** @internal Test seam — defaults to the harness's
   *  `invokeAgent`. Tests stub this to assert the call arguments
   *  without standing up a real harness loop. */
  readonly invokeAgentFn?: typeof invokeAgent;
  /** @internal Test seam — derives a drizzle Db handle from the
   *  bundle's `pgPool`. Defaults to `drizzle(pool)` from
   *  drizzle-orm/node-postgres. The test fixture builds a pglite-
   *  backed drizzle handle and uses this seam to skip the
   *  node-postgres wrapping (PGlite uses a different drizzle
   *  dialect). */
  readonly dbFromPool?: (pool: unknown) => Db;
}

/** Pull every enabled instance row for the slug. We cap at 2 so
 *  the ambiguity branch can name both ids without listing dozens
 *  on a misconfigured deployment. */
async function listEnabledForSlug(
  db: Db,
  slug: string,
): Promise<readonly MinimalInstanceRow[]> {
  const result = (await db.execute(sql`
    SELECT id::text AS id, definition_slug
    FROM agent_instances
    WHERE definition_slug = ${slug} AND enabled = true
    ORDER BY created_at
    LIMIT 2
  `)) as unknown as {
    rows: Array<{ id: string; definition_slug: string }>;
  };
  return result.rows.map((r) => ({
    id: r.id,
    definitionSlug: r.definition_slug,
  }));
}

/** Render the dry-run instance summary. JSON-ish key/value lines
 *  rather than full JSON so the output stays human-readable in a
 *  terminal — operators are typically grepping for the id /
 *  schedule / scope. */
function formatDryRun(
  instance: AgentInstance,
  runnerRegistered: boolean,
): string {
  const lines: string[] = [];
  lines.push(pc.bold(`agents fire: ${instance.definitionSlug} (dry-run)`));
  lines.push(`  id:               ${instance.id}`);
  lines.push(`  name:             ${instance.name}`);
  lines.push(`  definition_slug:  ${instance.definitionSlug}`);
  lines.push(`  enabled:          ${instance.enabled}`);
  lines.push(
    `  schedule_cron:    ${instance.scheduleCron ?? "(none)"}`,
  );
  lines.push(
    `  scope_domain_ids: [${instance.scopeDomainIds.join(", ")}]`,
  );
  lines.push(
    `  runner:           ${runnerRegistered ? "registered" : "NOT in registry"}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function runAgentsFire(args: AgentsFireArgs): Promise<void> {
  const logger =
    args.logger ??
    new ConsoleLogger({ stream: { write: (): boolean => true } });
  const composeBundle =
    args.composeBundle ?? tryComposeAgentRunnersBundleFromEnv;
  const invokeAgentFn = args.invokeAgentFn ?? invokeAgent;
  const dbFromPool =
    args.dbFromPool ??
    ((pool: unknown): Db =>
      drizzlePg(pool as Pool) as unknown as Db);

  // Boot-tolerance branch: matches the dispatcher path.
  // `tryComposeAgentRunnersBundleFromEnv` returns null for several
  // reasons (production-composition.ts:475-549) — narrowing the
  // stderr to one cause misdirects operators with the other
  // failures. The composition itself logs the precise cause at
  // warn level (`mcp_http.unavailable` for both the missing token
  // and the pg.Pool path); the operator-facing line names every
  // check so they know where to look.
  const bundle = composeBundle({ env: args.env, logger });
  if (bundle === null) {
    args.stderr.write(
      pc.red(
        "agents fire: agent runners unavailable. Check (1) DATABASE_URL is set + Postgres is reachable, (2) MCP_BEARER_TOKEN is set (or N8N_MCP_BEARER_TOKEN if relying on n8n-mcp), (3) compose-time logs above for the specific reason. See runbook §1.\n",
      ),
    );
    return exitRuntimeError();
  }

  try {
    const db = dbFromPool(bundle.pgPool);

    // Slug → instance resolution.
    let instance: AgentInstance;
    if (args.instanceId !== undefined) {
      // Reject malformed UUIDs upfront so operators see a clear
      // "invalid uuid" message instead of either (a) the
      // Postgres-side cast error bubbling as a generic runtime
      // error (exit 2), or (b) a confusing "not found" report on
      // a UUID that could never match.
      if (!UUID_REGEX.test(args.instanceId)) {
        args.stderr.write(
          pc.red(
            `agents fire: invalid uuid: ${args.instanceId}\n`,
          ),
        );
        return exitUserError();
      }
      try {
        instance = await loadInstanceById(db, args.instanceId);
      } catch (err) {
        // Round-3 fix #1: only the typed not-found error maps to
        // exit 1 ("instance row missing or disabled — operator
        // problem"). Anything else (DB connection drop, transient
        // pg error, surprise schema change) re-throws to the
        // outer runtime-error handler so the operator gets exit 2
        // with the scrubbed underlying message instead of a
        // misdirecting "not found" on a healthy database.
        if (err instanceof AgentInstanceNotFoundError) {
          // loadInstanceById's SELECT carries `enabled = true`
          // (instances.ts:86), so a disabled row presents
          // identically to a deleted one — the CLI surfaces both
          // under the same message. Re-enabling is an admin-UI
          // action (out of scope for this verb).
          args.stderr.write(
            pc.red(
              `agents fire: agent_instances row ${args.instanceId} not found (or disabled)\n`,
            ),
          );
          return exitUserError();
        }
        throw err;
      }
      if (instance.definitionSlug !== args.slug) {
        args.stderr.write(
          pc.red(
            `agents fire: instance ${args.instanceId} has definition_slug=${instance.definitionSlug}, but you requested fire on ${args.slug}\n`,
          ),
        );
        return exitUserError();
      }
    } else {
      const matches = await listEnabledForSlug(db, args.slug);
      if (matches.length === 0) {
        args.stderr.write(
          pc.red(
            `agents fire: no enabled instance found for definition_slug=${args.slug}; run \`opencoo agents seed\` first\n`,
          ),
        );
        return exitUserError();
      }
      if (matches.length > 1) {
        const [a, b] = matches;
        args.stderr.write(
          pc.red(
            `agents fire: multiple enabled instances for definition_slug=${args.slug}: ${a?.id}, ${b?.id}; pass --instance-id <uuid>\n`,
          ),
        );
        return exitUserError();
      }
      const only = matches[0];
      if (only === undefined) {
        // Defensive — the length check above guarantees one row;
        // narrowing keeps strictNullChecks happy.
        args.stderr.write(
          pc.red(`agents fire: internal error resolving slug=${args.slug}\n`),
        );
        return exitRuntimeError();
      }
      instance = await loadInstanceById(db, only.id);
    }

    // Dry-run path: report the resolved instance + runner-registry
    // presence; do NOT touch the harness. The runner-presence
    // line is load-bearing for the appendix-#6 Surfacer-omitted
    // case — operators see "NOT in registry" and know to set
    // N8N_MCP_BEARER_TOKEN (or accept the omit) BEFORE attempting
    // the live fire.
    const runner = bundle.runners.get(instance.definitionSlug);
    if (args.dryRun === true) {
      args.stdout.write(formatDryRun(instance, runner !== undefined));
      return exitOk();
    }

    if (runner === undefined) {
      // Round-3 fix #5: the Surfacer-omitted hint is only
      // accurate when the requested slug IS surfacer. For other
      // slugs (typo like `heartbear`, or a v0.2 slug not yet
      // wired) the hint misdirects. Tailor the message per-slug
      // — the typo path lists the v0.1 valid scheduled slugs so
      // the operator can self-correct without grepping docs.
      const baseMsg = `agents fire: no runner registered for slug=${args.slug}`;
      const hint =
        args.slug === "surfacer"
          ? " (Surfacer is omitted by default per appendix #6 — see runbook §8; configure N8N_MCP env vars to enable)"
          : " (check spelling; valid scheduled slugs: heartbeat, lint, surfacer)";
      args.stderr.write(pc.red(`${baseMsg}${hint}\n`));
      return exitUserError();
    }

    // Fire path: the harness loads the instance again (its own
    // contract), threads the run into the recorder, and either
    // returns AgentInvocationResult on success/failed-body, or
    // throws when the load / record steps themselves break.
    // Either way we land in the success-printing branch when the
    // run row was recorded; the catch handles only the harness-
    // throw case.
    //
    // Trigger value: the `agent_trigger` Postgres enum is
    // `('scheduled', 'http', 'mcp')` — there's no `'manual'`
    // value in v0.1, and PR-O2 explicitly does NOT introduce a
    // schema migration. CLI operator-driven runs use `'http'` as
    // the closest-fit (operator-driven, not cron). The
    // `inputs.firedBy = 'cli'` field is the precise origin
    // discriminator the audit trail keys on (vs `firedBy:
    // 'admin-ui'` for a future per-instance Run-now button).
    let result: Awaited<ReturnType<typeof invokeAgentFn>>;
    try {
      result = await invokeAgentFn({
        definitions: bundle.definitions,
        db: db as unknown as Parameters<typeof invokeAgentFn>[0]["db"],
        router: bundle.router,
        logger,
        instanceId: instance.id,
        trigger: "http",
        inputs: { firedBy: "cli", slug: args.slug },
        run: runner as unknown as Parameters<typeof invokeAgentFn>[0]["run"],
      });
    } catch (err) {
      args.stderr.write(
        pc.red(`agents fire: runner threw: ${safeError(err)}\n`),
      );
      return exitRuntimeError();
    }

    args.stdout.write(
      pc.green(
        `✓ ${args.slug} instance ${instance.id} dispatched; agent_runs row ${result.runId} recorded; status ${result.status}\n`,
      ),
    );
    return exitOk();
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(`agents fire: ${safeError(err)}\n`),
    );
    return exitRuntimeError();
  } finally {
    await bundle.close();
  }
}
