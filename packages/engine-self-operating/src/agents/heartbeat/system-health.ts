/**
 * `gatherSystemHealth` — pre-fetched operational-health context
 * for the Heartbeat agent (PR-W6, phase-a appendix #14).
 *
 * On a sparsely-populated wiki the Heartbeat agent's synthesis
 * collapses to "the wiki has no compiled pages yet" — a useless
 * daily briefing. This module is the read-only data path the
 * agent's prompt branch consults to surface OPERATIONAL signals
 * (intake backlog, source-binding lag, recent agent-run
 * failures, worldview staleness) instead of regurgitating the
 * worldview placeholder. The output is spotlighted into the
 * Heartbeat prompt under a `system-health://<domainSlug>`
 * envelope (run.ts) and consumed by the LLM.
 *
 * # Scope boundary (architecture.md §9.5 / THREAT-MODEL §3.5)
 *
 * The gatherer reads ONLY from the heartbeat's scope domain
 * ids. Every aggregate filters on `domain_id IN (:scope)` or a
 * scope-anchored join via `sources_bindings.domain_id`. The
 * test `system-health.test.ts > respects scope` is load-bearing
 * for this invariant — a row in domain X must NOT surface when
 * scope is [Y].
 *
 * # `intake_status='failed'` enum tolerance
 *
 * W3 (phase-a appendix #14) adds `'failed'` to the
 * `intake_status` enum + a try/catch in the compile-worker that
 * writes the failure terminal state. W6 (this module) ships in
 * parallel and uses `status::text = 'failed'` everywhere so the
 * SQL is enum-agnostic — it works whether the enum has
 * `'failed'` already or not. Once W3 lands, the gatherer keeps
 * returning correct counts without a change here.
 *
 * # Defense-in-depth chain for `error_text_snippet`
 *
 *   (1) SQL `LEFT(error_text, 1000)` — row-size bound. Prevents
 *       a hostile error message larger than the BullMQ job
 *       limit from flowing into the gatherer's in-memory rows.
 *   (2) JS `safeErrorMessage(...)` — credential scrub + cap to
 *       `ERROR_MESSAGE_MAX_LENGTH` (200). This is the gate that
 *       rejects credential-shaped substrings (`postgres://user:
 *       secret@host`, env-var-style tokens, etc.) before the
 *       snippet reaches the LLM prompt. Scrub-then-cap order
 *       per `safe-error.ts` docblock — cap-then-scrub would
 *       leave secret bytes straddling the boundary.
 *   (3) `spotlight()` envelope (run.ts) — XML sentinel guard
 *       only; NOT a secret-scrubber. It would XML-escape a
 *       leaked credential but the credential bytes would still
 *       reach the model. Hence the (2) scrub above is the
 *       load-bearing layer against credential leakage; (3) is
 *       structural injection defense.
 *
 * The (1)→(2)→(3) order is intentional: SQL bounds row size
 * cheaply, JS scrubs secrets, spotlight() XML-escapes. Reversing
 * (1) and (2) is wrong — scrubbing a 10 KB raw error_text in JS
 * is wasteful when SQL can cap it; reversing (2) and (3) is also
 * wrong — XML-escaping credential bytes still leaks the secret.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { safeErrorMessage } from "@opencoo/shared/scrub";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
}

/** Row-size bound — applied SQL-side via `LEFT(error_text, N)`.
 *  Caps how many bytes flow from PG into the gatherer's
 *  in-memory rows even if an upstream compile-worker wrote a
 *  multi-KB error message. The 1000 budget is comfortably above
 *  `ERROR_MESSAGE_MAX_LENGTH` (200) so the JS-side scrub still
 *  sees enough of the message to match credential patterns
 *  that straddle byte boundaries. */
const ERROR_TEXT_ROW_MAX_CHARS = 1000;
const INTAKE_FAILURES_RECENT_CAP = 3;
const RECENT_AGENT_RUNS_WINDOW_HOURS = 24;

/** Bounded operational-health snapshot for one Heartbeat run.
 *  Spotlighted as `system-health://<domainSlug>` in the prompt. */
export interface SystemHealth {
  readonly intake_counts: {
    readonly pending: number;
    readonly classified: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly intake_failures_recent: ReadonlyArray<{
    readonly binding_name: string;
    readonly error_class: string;
    readonly error_text_snippet: string;
  }>;
  readonly source_bindings: ReadonlyArray<{
    readonly name: string;
    readonly last_scan_at: string | null;
    readonly hours_since_scan: number | null;
    readonly pending_count: number;
    readonly failed_count: number;
  }>;
  readonly recent_agent_runs: ReadonlyArray<{
    readonly agent_slug: string;
    readonly success_count: number;
    readonly failure_count: number;
    readonly last_failure_message: string | null;
  }>;
  readonly wiki_stats: {
    readonly page_count: number;
    readonly worldview_bytes: number;
    readonly worldview_last_compiled_at: string | null;
  };
}

/** Minimal WikiAdapter shape the gatherer needs — a structural
 *  subset of `@opencoo/shared/wiki-write`'s `WikiAdapter` so
 *  tests can stub without dragging the full interface. */
export interface WikiReader {
  listMarkdown(domainSlug: string): Promise<readonly string[]>;
  readPage(
    domainSlug: string,
    path: string,
  ): Promise<{ sha: string; content: string } | null>;
}

export interface GatherSystemHealthArgs {
  readonly db: Db;
  /** Heartbeat instance's `scope_domain_ids` (uuid[]). Every
   *  query filters on this list — the gatherer never reads
   *  outside scope. */
  readonly scopeDomainIds: readonly string[];
  /** Domain slug the heartbeat is summarising. Used for the
   *  WikiAdapter calls (`listMarkdown`, `readPage`) and for the
   *  spotlight envelope source attribute. */
  readonly domainSlug: string;
  /** Optional wikiAdapter — when omitted the wiki_stats branch
   *  returns `{page_count: 0, worldview_bytes: 0,
   *  worldview_last_compiled_at: null}` rather than throwing.
   *  Some test paths (and any future composition that skips
   *  Gitea on startup) need to gracefully degrade. */
  readonly wikiAdapter?: WikiReader;
  /** Clock seam — tests pin NOW so hours-since-scan / recent-
   *  agent-runs windowing is deterministic. */
  readonly now?: () => Date;
}

/** Wiki paths the gatherer EXCLUDES from `page_count` — the
 *  four engine-managed placeholders that exist on every wiki
 *  regardless of compiled content. A wiki with only these four
 *  is functionally empty. */
const PLACEHOLDER_PAGES = new Set([
  "index.md",
  "log.md",
  "schema.md",
  "worldview.md",
]);

interface IntakeCountRow {
  status_text: string;
  count: number;
}

interface IntakeFailureRow {
  binding_name: string;
  error_class: string | null;
  error_text: string | null;
}

interface BindingRow {
  name: string;
  last_scan_at: string | null;
  pending_count: number;
  failed_count: number;
}

interface AgentRunAggRow {
  agent_slug: string;
  success_count: number;
  failure_count: number;
  last_failure_message: string | null;
}

interface WorldviewCompiledRow {
  last_compiled_at: string | null;
}

/**
 * Read-only aggregator. Returns an envelope-safe shape the
 * Heartbeat agent's prompt branch can interpret. ALL queries
 * are scope-anchored — a row outside `scopeDomainIds` is
 * invisible to the result.
 */
export async function gatherSystemHealth(
  args: GatherSystemHealthArgs,
): Promise<SystemHealth> {
  const now = (args.now ?? ((): Date => new Date()))();

  // Empty scope is a programmer error (the heartbeat body
  // already rejects this at run.ts entry). Returning a zeroed
  // snapshot here would mask the misconfig — throw instead.
  if (args.scopeDomainIds.length === 0) {
    throw new Error(
      "gatherSystemHealth: scopeDomainIds is empty — refusing to run an unscoped read",
    );
  }

  const scopeIds = args.scopeDomainIds as readonly string[];
  // PG cannot bind a JS array of UUIDs as a parametrized
  // single value — drizzle's `${arr}` stringifies the array to
  // a comma-joined literal that the server rejects with
  // `malformed array literal`. The repo convention (see
  // `admin-api/routes/scheduler.ts`) is `sql.join` over the
  // ids cast individually. The ids come from `agent_instances.
  // scope_domain_ids` (UUID column), never operator input —
  // safe to inline as `$N::uuid` parameters.
  const scopeIdParams = sql.join(
    scopeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // 1. intake_counts — aggregated per-status over every intake
  //    row whose binding belongs to the scope. `status::text`
  //    keeps us enum-tolerant: pre-W3 the enum has 3 values,
  //    post-W3 it has 4, the comparison works in both.
  const intakeCountsRaw = (await args.db.execute(sql`
    SELECT i.status::text AS status_text, COUNT(*)::int AS count
      FROM ingestion_intake i
     WHERE i.binding_id IN (
       SELECT b.id FROM sources_bindings b
        WHERE b.domain_id IN (${scopeIdParams})
     )
     GROUP BY 1
  `)) as unknown as ExecResult<IntakeCountRow>;

  const intake_counts = {
    pending: 0,
    classified: 0,
    skipped: 0,
    failed: 0,
  };
  for (const row of intakeCountsRaw.rows) {
    if (row.status_text === "pending") intake_counts.pending = Number(row.count);
    else if (row.status_text === "classified")
      intake_counts.classified = Number(row.count);
    else if (row.status_text === "skipped")
      intake_counts.skipped = Number(row.count);
    else if (row.status_text === "failed")
      intake_counts.failed = Number(row.count);
    // Unknown future statuses are intentionally ignored — the
    // gatherer is a snapshot, not an enum-version oracle.
  }

  // 2. intake_failures_recent — top-N most-recent rows with
  //    status='failed', joined to the binding for a label.
  //
  //    Defense-in-depth chain for `error_text` (see module
  //    docblock "Defense-in-depth chain" section):
  //      (1) SQL `LEFT(error_text, 1000)` caps row size before
  //          PG ships bytes to the gatherer. Cheap; protects
  //          memory.
  //      (2) `safeErrorMessage(...)` (applied below in the
  //          mapper) scrubs credential-shaped substrings AND
  //          caps to `ERROR_MESSAGE_MAX_LENGTH` (200). This is
  //          the load-bearing layer for "no credentials in the
  //          LLM prompt" (THREAT-MODEL §2 invariant 11).
  //      (3) spotlight() in run.ts XML-escapes the JSON-encoded
  //          payload — structural injection defense only,
  //          NOT a secret-scrubber.
  const failuresRaw = (await args.db.execute(sql`
    SELECT
      COALESCE(NULLIF(b.notes, ''), b.adapter_slug || ':' || COALESCE(b.source_id, b.id::text)) AS binding_name,
      i.error_class::text AS error_class,
      LEFT(i.error_text, ${ERROR_TEXT_ROW_MAX_CHARS}) AS error_text
    FROM ingestion_intake i
    JOIN sources_bindings b ON b.id = i.binding_id
    WHERE i.status::text = 'failed'
      AND b.domain_id IN (${scopeIdParams})
    ORDER BY i.created_at DESC
    LIMIT ${INTAKE_FAILURES_RECENT_CAP}
  `)) as unknown as ExecResult<IntakeFailureRow>;

  const intake_failures_recent = failuresRaw.rows.map((r) => ({
    binding_name: r.binding_name,
    error_class: r.error_class ?? "unknown",
    // safeErrorMessage = scrub THEN cap to ERROR_MESSAGE_MAX_LENGTH
    // (200). Per `@opencoo/shared/scrub/safe-error.ts` the order
    // matters: cap-then-scrub would leave credential bytes
    // straddling the 200-char boundary unredacted.
    error_text_snippet: safeErrorMessage(r.error_text ?? ""),
  }));

  // 3. source_bindings — per-binding scan lag + per-status
  //    counts. The aggregate uses LEFT JOIN so bindings with
  //    zero intake rows still surface (operator can see a
  //    binding that has never run).
  const bindingsRaw = (await args.db.execute(sql`
    SELECT
      COALESCE(NULLIF(b.notes, ''), b.adapter_slug || ':' || COALESCE(b.source_id, b.id::text)) AS name,
      b.last_scanned_at::text AS last_scan_at,
      COUNT(i.id) FILTER (WHERE i.status::text = 'pending')::int AS pending_count,
      COUNT(i.id) FILTER (WHERE i.status::text = 'failed')::int AS failed_count
    FROM sources_bindings b
    LEFT JOIN ingestion_intake i ON i.binding_id = b.id
    WHERE b.domain_id IN (${scopeIdParams})
    GROUP BY b.id, b.notes, b.adapter_slug, b.source_id, b.last_scanned_at
    ORDER BY b.created_at ASC
  `)) as unknown as ExecResult<BindingRow>;

  const source_bindings = bindingsRaw.rows.map((r) => {
    const lastScanAt = r.last_scan_at;
    const hoursSinceScan =
      lastScanAt === null
        ? null
        : Math.floor(
            (now.getTime() - new Date(lastScanAt).getTime()) / (3600 * 1000),
          );
    return {
      name: r.name,
      last_scan_at: lastScanAt,
      hours_since_scan: hoursSinceScan,
      pending_count: Number(r.pending_count),
      failed_count: Number(r.failed_count),
    };
  });

  // 4. recent_agent_runs — last 24h, grouped by definition_slug,
  //    only counting runs on agent_instances whose scope
  //    intersects ours. (Multi-domain instances surface here as
  //    long as ANY of their scope ids overlaps.)
  const windowStart = new Date(
    now.getTime() - RECENT_AGENT_RUNS_WINDOW_HOURS * 3600 * 1000,
  ).toISOString();

  // For the agent-runs scope filter we need a `uuid[]` on the
  // right side of the array-overlap (`&&`) operator. Build the
  // array literal with `ARRAY[...]::uuid[]` from the same
  // bound parameters as the IN-list above so the boundary stays
  // a single `scopeIds` source of truth.
  const scopeIdArray = sql`ARRAY[${scopeIdParams}]::uuid[]`;
  const runsRaw = (await args.db.execute(sql`
    SELECT
      r.definition_slug AS agent_slug,
      COUNT(*) FILTER (WHERE r.status = 'success')::int AS success_count,
      COUNT(*) FILTER (WHERE r.status = 'failed' OR r.status = 'timeout')::int AS failure_count,
      (
        SELECT (r2.output->>'message')::text
          FROM agent_runs r2
         WHERE r2.definition_slug = r.definition_slug
           AND r2.instance_id IN (
             SELECT ai.id FROM agent_instances ai
              WHERE ai.scope_domain_ids && ${scopeIdArray}
           )
           AND (r2.status = 'failed' OR r2.status = 'timeout')
           AND r2.started_at >= ${windowStart}::timestamptz
           AND r2.output IS NOT NULL
         ORDER BY r2.started_at DESC
         LIMIT 1
      ) AS last_failure_message
    FROM agent_runs r
    WHERE r.instance_id IN (
      SELECT ai.id FROM agent_instances ai
       WHERE ai.scope_domain_ids && ${scopeIdArray}
    )
      AND r.started_at >= ${windowStart}::timestamptz
    GROUP BY r.definition_slug
    ORDER BY r.definition_slug ASC
  `)) as unknown as ExecResult<AgentRunAggRow>;

  const recent_agent_runs = runsRaw.rows.map((r) => ({
    agent_slug: r.agent_slug,
    success_count: Number(r.success_count),
    failure_count: Number(r.failure_count),
    // Apply the same scrub-then-cap chain as
    // `error_text_snippet`. Agent runs are engine-internal but
    // an upstream LLM provider error message can carry the API
    // key in `.message` (e.g. "401 Unauthorized: sk-…");
    // safeErrorMessage scrubs those families before the snippet
    // reaches the LLM prompt.
    last_failure_message:
      r.last_failure_message === null
        ? null
        : safeErrorMessage(r.last_failure_message),
  }));

  // 5. wiki_stats — page_count via wikiAdapter.listMarkdown,
  //    worldview_bytes via wikiAdapter.readPage. The placeholder
  //    pages (index/log/schema/worldview) are excluded from
  //    page_count so an empty domain reads `page_count: 0` even
  //    when those four exist as engine-managed scaffold pages.
  const wiki_stats = await readWikiStats({
    domainSlug: args.domainSlug,
    wikiAdapter: args.wikiAdapter,
    db: args.db,
    scopeIds,
  });

  return {
    intake_counts,
    intake_failures_recent,
    source_bindings,
    recent_agent_runs,
    wiki_stats,
  };
}

interface WikiStatsArgs {
  readonly domainSlug: string;
  readonly wikiAdapter: WikiReader | undefined;
  readonly db: Db;
  readonly scopeIds: readonly string[];
}

/** Compute `wiki_stats` from the wikiAdapter where available;
 *  fall back gracefully when the adapter throws or is absent. */
async function readWikiStats(args: WikiStatsArgs): Promise<{
  readonly page_count: number;
  readonly worldview_bytes: number;
  readonly worldview_last_compiled_at: string | null;
}> {
  let page_count = 0;
  let worldview_bytes = 0;

  if (args.wikiAdapter !== undefined) {
    try {
      const paths = await args.wikiAdapter.listMarkdown(args.domainSlug);
      page_count = paths.filter((p) => !PLACEHOLDER_PAGES.has(p)).length;
    } catch {
      // listMarkdown threw — record zero. The heartbeat prompt
      // treats `page_count: 0` as "empty wiki" and surfaces
      // operational-health alerts, which is the correct
      // behavior when the wiki backend is unavailable.
      page_count = 0;
    }

    try {
      const worldview = await args.wikiAdapter.readPage(
        args.domainSlug,
        "worldview.md",
      );
      worldview_bytes =
        worldview === null ? 0 : Buffer.byteLength(worldview.content, "utf8");
    } catch {
      worldview_bytes = 0;
    }
  }

  // worldview_last_compiled_at: most-recent `llm_usage` row for
  // `pipeline_or_agent='worldview-domain'` filtered to scope.
  const scopeIdParams = sql.join(
    args.scopeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const lastCompiledRaw = (await args.db.execute(sql`
    SELECT MAX(timestamp)::text AS last_compiled_at
      FROM llm_usage
     WHERE pipeline_or_agent = 'worldview-domain'
       AND domain_id IN (${scopeIdParams})
  `)) as unknown as ExecResult<WorldviewCompiledRow>;
  const worldview_last_compiled_at =
    lastCompiledRaw.rows[0]?.last_compiled_at ?? null;

  return {
    page_count,
    worldview_bytes,
    worldview_last_compiled_at,
  };
}
