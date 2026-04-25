/**
 * Cleanup pipeline (architecture §9 pipeline 6, plan #77).
 *
 * Weekly: prune `llm_usage_debug` rows older than the per-domain
 * retention horizon. Per planner Q11: 'retention_days_override'
 * is read from `sources_bindings`, but the binding-to-domain
 * relation is many-to-one and the debug row's owner is the
 * domain (not the binding), so the precedence is:
 *
 *   per-domain effective horizon =
 *     domain.retention_days  ?? DEFAULT_DEBUG_RETENTION_DAYS
 *
 * Per-binding override is reserved for v0.2 (per Q11 fallback).
 * The default is 7 days (THREAT-MODEL §2 invariant 11).
 *
 * Two-pass design:
 *
 *   Pass 1 — for each domain, DELETE FROM llm_usage_debug d
 *            USING llm_usage u WHERE d.usage_id = u.id
 *            AND u.domain_id = $domain AND d.created_at < $horizon.
 *   Pass 2 — orphan pass. DELETE FROM llm_usage_debug d
 *            USING llm_usage u WHERE d.usage_id = u.id
 *            AND u.domain_id IS NULL AND d.created_at < $defaultHorizon.
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
  readonly retentionDays: number | null;
}

export async function runCleanup(args: RunCleanupArgs): Promise<CleanupResult> {
  const now = (args.now ?? ((): Date => new Date()))();

  const domainRows = (await args.db.execute(
    sql`SELECT id::text AS id, slug, retention_days FROM domains`,
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
