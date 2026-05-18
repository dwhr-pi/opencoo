/**
 * Cleanup pipeline (architecture §9 pipeline 6, plan #77).
 *
 * Weekly: prune `llm_usage_debug` rows older than the per-domain
 * retention horizon.
 *
 * Per-binding `sources_bindings.retention_days_override` is honored
 * at sweep-time (PR-W5+, wave-17). The W5 PATCH path (wave-15 #145)
 * writes the column from the management UI; this worker reads it.
 *
 * Effective retention precedence (per binding, then collapsed
 * across the domain's bindings):
 *
 *   per-binding effective retention =
 *     COALESCE(b.retention_days_override, d.retention_days)
 *
 *   per-domain effective horizon =
 *     COALESCE(
 *       MIN(per-binding effective retention)
 *           OVER bindings of this domain,
 *       d.retention_days,
 *       DEFAULT_DEBUG_RETENTION_DAYS
 *     )
 *
 * The MIN collapse is deliberate. The schema does NOT carry a
 * binding_id on `llm_usage` (the debug row's parent), so a debug
 * row attributed to a domain cannot be resolved back to a specific
 * binding. The privacy-preserving choice is to honor the STRICTEST
 * binding's policy: a binding with override=7 explicitly says
 * "keep my debug telemetry <= 7 days," and that policy must not be
 * silently bypassed by another binding under the same domain
 * wanting a longer horizon (THREAT-MODEL §2 invariant 11). A
 * binding with override=NULL contributes the domain default to the
 * MIN — that's its intent ("use the domain policy"), and skipping
 * NULL overrides would let one long override silently weaken the
 * stricter sibling-binding-with-NULL policy (PR #182 Copilot
 * review). A future schema change adding binding_id to llm_usage
 * would lift the collapse and allow truly per-binding cutoffs.
 *
 * The default is 7 days (THREAT-MODEL §2 invariant 11) — applied
 * when both override and domain retention are NULL.
 *
 * Two-pass design:
 *
 *   Pass 1 — for each domain, DELETE FROM llm_usage_debug d
 *            USING llm_usage u WHERE d.usage_id = u.id
 *            AND u.domain_id = $domain AND d.created_at < $horizon.
 *            The horizon is the effective retention above; the
 *            WHERE clause is strictly scoped to the domain so no
 *            JOIN can leak deletes across domains.
 *   Pass 2 — orphan pass. DELETE FROM llm_usage_debug d
 *            USING llm_usage u WHERE d.usage_id = u.id
 *            AND u.domain_id IS NULL AND d.created_at < $defaultHorizon.
 *            Orphan rows have no domain (and therefore no binding)
 *            attribution, so they always use the default horizon.
 *
 * THE LOAD-BEARING INVARIANT (load-bearing per the brief): every
 * other append-only table is UNTOUCHED. Cleanup never deletes
 * from page_citations, redaction_events, erasure_log,
 * miner_suppressions, agent_runs, or the wiki repo. The pipeline
 * tests verify this by snapshotting row counts + the wiki HEAD
 * SHA before and after the run and asserting equality.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Logger } from "@opencoo/shared/logger";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
  readonly rowCount?: number;
  readonly affectedRows?: number;
}

export const DEFAULT_DEBUG_RETENTION_DAYS = 7;

export interface RunCleanupArgs {
  readonly db: Db;
  readonly logger: Logger;
  /** Optional clock injection for deterministic tests. Production
   *  defaults to wall clock. */
  readonly now?: () => Date;
}

export interface CleanupResult {
  /** Total rows deleted across both passes. */
  readonly debugRowsDeleted: number;
  /** Per-domain breakdown for the operator log. */
  readonly perDomain: ReadonlyArray<{
    readonly domainId: string;
    readonly domainSlug: string;
    readonly retentionDays: number;
    readonly deleted: number;
  }>;
  /** Orphan-pass count (debug rows whose llm_usage row has no
   *  domain_id; pruned at the default horizon). */
  readonly orphanRowsDeleted: number;
}

interface DomainRow {
  readonly id: string;
  readonly slug: string;
  /** Effective retention horizon in days: COALESCE(MIN(binding
   *  override) over bindings of this domain, domains.retention_days).
   *  NULL when both legs are NULL — caller falls back to
   *  DEFAULT_DEBUG_RETENTION_DAYS. */
  readonly retentionDays: number | null;
}

export async function runCleanup(args: RunCleanupArgs): Promise<CleanupResult> {
  const now = (args.now ?? ((): Date => new Date()))();

  // LEFT JOIN sources_bindings so every domain row appears even when
  // it has no bindings yet. Per binding, the effective retention is
  // COALESCE(b.retention_days_override, d.retention_days) — a NULL
  // override means "use the domain default," so a binding with NULL
  // override contributes the domain default to the per-domain MIN
  // (not skipped). The outer COALESCE handles the no-bindings case:
  // when the LEFT JOIN produces no binding rows for a domain,
  // MIN(NULL) is NULL and we fall back to d.retention_days alone.
  // The aggregate is implemented in SQL rather than in JS so the
  // cost is one round-trip and the planner can use the existing
  // (domain_id) index on sources_bindings.
  //
  // The MIN-of-per-binding-effective rule is the privacy-preserving
  // choice (THREAT-MODEL §2 invariant 11): if binding-A has
  // override=365 and binding-B has NULL with domain default=30, the
  // per-domain cutoff is MIN(365, 30) = 30 — binding-B's stricter
  // intent is honored. Copilot review on PR #182 flagged the prior
  // shape that skipped NULL overrides as letting one long override
  // weaken sibling bindings' policy; this revision fixes that.
  const domainRows = (await args.db.execute(
    sql`SELECT
          d.id::text AS id,
          d.slug,
          COALESCE(
            MIN(COALESCE(b.retention_days_override, d.retention_days)),
            d.retention_days
          ) AS retention_days
        FROM domains d
        LEFT JOIN sources_bindings b ON b.domain_id = d.id
        GROUP BY d.id, d.slug, d.retention_days`,
  )) as unknown as ExecResult<{
    id: string;
    slug: string;
    retention_days: number | null;
  }>;
  const domains: DomainRow[] = domainRows.rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    retentionDays:
      r.retention_days === null || r.retention_days === undefined
        ? null
        : Number(r.retention_days),
  }));

  const perDomain: Array<{
    domainId: string;
    domainSlug: string;
    retentionDays: number;
    deleted: number;
  }> = [];

  let totalDeleted = 0;

  for (const domain of domains) {
    const days = domain.retentionDays ?? DEFAULT_DEBUG_RETENTION_DAYS;
    const horizon = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const result = (await args.db.execute(sql`
      DELETE FROM llm_usage_debug d
      USING llm_usage u
      WHERE d.usage_id = u.id
        AND u.domain_id = ${domain.id}::uuid
        AND d.created_at < ${horizon.toISOString()}
    `)) as unknown as ExecResult<unknown>;
    const deleted =
      result.rowCount ?? result.affectedRows ?? result.rows.length;
    perDomain.push({
      domainId: domain.id,
      domainSlug: domain.slug,
      retentionDays: days,
      deleted,
    });
    totalDeleted += deleted;
    if (deleted > 0) {
      args.logger.info("cleanup.debug.pruned", {
        domain_slug: domain.slug,
        retention_days: days,
        deleted,
      });
    }
  }

  // Orphan pass — debug rows whose llm_usage parent has no
  // domain_id (e.g. a budget-cap-breach row written without a
  // domain attribution). Pruned at the default horizon.
  const orphanHorizon = new Date(
    now.getTime() - DEFAULT_DEBUG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const orphanResult = (await args.db.execute(sql`
    DELETE FROM llm_usage_debug d
    USING llm_usage u
    WHERE d.usage_id = u.id
      AND u.domain_id IS NULL
      AND d.created_at < ${orphanHorizon.toISOString()}
  `)) as unknown as ExecResult<unknown>;
  const orphanDeleted =
    orphanResult.rowCount ??
    orphanResult.affectedRows ??
    orphanResult.rows.length;
  totalDeleted += orphanDeleted;
  if (orphanDeleted > 0) {
    args.logger.info("cleanup.debug.orphans_pruned", {
      retention_days: DEFAULT_DEBUG_RETENTION_DAYS,
      deleted: orphanDeleted,
    });
  }

  return {
    debugRowsDeleted: totalDeleted,
    perDomain,
    orphanRowsDeleted: orphanDeleted,
  };
}
