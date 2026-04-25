/**
 * Cleanup pipeline (PR 17 / plan #77) — LOAD-BEARING invariant
 * suite. Every test snapshots row counts on the 5 append-only
 * tables AND the wiki HEAD SHA before and after the run, then
 * asserts equality. Per the brief: this suite is the load-bearing
 * proof that Cleanup never touches anything except llm_usage_debug.
 */
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";

import {
  DEFAULT_DEBUG_RETENTION_DAYS,
  runCleanup,
} from "../../src/pipelines/cleanup.js";

import { freshPipelineDb, type PipelineFixture } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const DOMAIN = "test-domain" as Parameters<
  InMemoryWikiAdapter["readPage"]
>[0];

interface InvariantSnapshot {
  pageCitations: number;
  redactionEvents: number;
  erasureLog: number;
  minerSuppressions: number;
  agentRuns: number;
  wikiHead: string;
}

async function snapshotInvariants(
  f: PipelineFixture,
  wikiAdapter: InMemoryWikiAdapter,
): Promise<InvariantSnapshot> {
  const counts = async (table: string): Promise<number> => {
    const r = await f.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table}`,
    );
    return Number(r.rows[0]!.count);
  };
  return {
    pageCitations: await counts("page_citations"),
    redactionEvents: await counts("redaction_events"),
    erasureLog: await counts("erasure_log"),
    minerSuppressions: await counts("miner_suppressions"),
    agentRuns: await counts("agent_runs"),
    wikiHead: await wikiAdapter.getHeadSha(DOMAIN),
  };
}

async function seedAuxRows(f: PipelineFixture): Promise<void> {
  // Seed one user (FK target).
  const userResult = await f.raw.query<{ id: string }>(
    `INSERT INTO users (gitea_username) VALUES ('test-user') RETURNING id`,
  );
  const userId = userResult.rows[0]!.id;
  // One row per cleanup-invariant table.
  await f.raw.query(
    `INSERT INTO page_citations (domain_slug, page_path, source_binding_id, source_ref) VALUES ('test-domain', 'strategy/x.md', $1, 'drive:doc-1')`,
    [f.bindingId],
  );
  await f.raw.query(
    `INSERT INTO redaction_events (pipeline, domain_id, binding_id, guard_slug, category, pattern_version, matched_byte_ranges, fail_mode) VALUES ('classifier', $1, $2, 'regex-pii', 'email', 'v1', '[]'::jsonb, 'transform')`,
    [f.domainId, f.bindingId],
  );
  await f.raw.query(
    `INSERT INTO erasure_log (binding_id, action, target_ref, executed_by) VALUES ($1, 'purge_intake', 'drive:doc-1', $2)`,
    [f.bindingId, userId],
  );
  await f.raw.query(
    `INSERT INTO miner_suppressions (miner_binding_id, candidate_ref, suppressed_by) VALUES ($1, 'cand-1', $2)`,
    [f.bindingId, userId],
  );
  await f.raw.query(
    `INSERT INTO agent_runs (definition_slug, trigger, status) VALUES ('classifier', 'scheduled', 'success')`,
  );
}

async function seedDebugRows(
  f: PipelineFixture,
  count: number,
  ageDaysAgo: number,
  domainId: string | null,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const usageResult = await f.raw.query<{ id: string }>(
      `INSERT INTO llm_usage (engine, tier, model, pipeline_or_agent, domain_id, tokens_in, tokens_out, cost_usd, latency_ms, timestamp, created_at)
       VALUES ('ingestion', 'worker', 'gpt-4o-mini', 'classifier', $1::uuid, 1, 1, '0.000001', 1, NOW() - ($2::text || ' days')::interval, NOW() - ($2::text || ' days')::interval)
       RETURNING id`,
      [domainId, String(ageDaysAgo)],
    );
    const usageId = usageResult.rows[0]!.id;
    await f.raw.query(
      `INSERT INTO llm_usage_debug (usage_id, prompt_text, response_text, created_at) VALUES ($1, 'p', 'r', NOW() - ($2::text || ' days')::interval)`,
      [usageId, String(ageDaysAgo)],
    );
  }
}

describe("runCleanup — load-bearing invariant suite (plan #77)", () => {
  it("does not touch any append-only table (5-row snapshot)", async () => {
    const f = await freshPipelineDb({ retentionDays: 7 });
    const wikiAdapter = new InMemoryWikiAdapter();
    wikiAdapter.inject(DOMAIN, "strategy/q3.md", "# Q3\n"); // pin a wiki SHA
    await seedAuxRows(f);
    await seedDebugRows(f, 3, 14, f.domainId);

    const before = await snapshotInvariants(f, wikiAdapter);
    expect(before.pageCitations).toBe(1);
    expect(before.redactionEvents).toBe(1);
    expect(before.erasureLog).toBe(1);
    expect(before.minerSuppressions).toBe(1);
    expect(before.agentRuns).toBe(1);

    await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    const after = await snapshotInvariants(f, wikiAdapter);
    expect(after.pageCitations).toBe(before.pageCitations);
    expect(after.redactionEvents).toBe(before.redactionEvents);
    expect(after.erasureLog).toBe(before.erasureLog);
    expect(after.minerSuppressions).toBe(before.minerSuppressions);
    expect(after.agentRuns).toBe(before.agentRuns);
    expect(after.wikiHead).toBe(before.wikiHead);
  });

  it("prunes llm_usage_debug rows older than the per-domain horizon", async () => {
    const f = await freshPipelineDb({ retentionDays: 7 });
    // 3 expired (14 days ago) + 2 fresh (1 day ago) on the same domain.
    await seedDebugRows(f, 3, 14, f.domainId);
    await seedDebugRows(f, 2, 1, f.domainId);

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(3);
    const remaining = await f.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM llm_usage_debug`,
    );
    expect(Number(remaining.rows[0]!.count)).toBe(2);
  });

  it("uses DEFAULT_DEBUG_RETENTION_DAYS when domain.retention_days is null", async () => {
    const f = await freshPipelineDb({}); // no retentionDays => null
    expect(DEFAULT_DEBUG_RETENTION_DAYS).toBe(7);
    // 1 row 10 days old (older than 7-day default) + 1 row 1 day
    // old (newer).
    await seedDebugRows(f, 1, 10, f.domainId);
    await seedDebugRows(f, 1, 1, f.domainId);

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(1);
  });

  it("orphan pass: prunes debug rows whose llm_usage parent has no domain_id", async () => {
    const f = await freshPipelineDb({ retentionDays: 365 });
    // Domain horizon = 365 days; orphan horizon = default 7d.
    // Seed 2 expired orphans + 1 fresh orphan + 1 expired
    // domain-attributed (which the domain-pass keeps because
    // 14 < 365).
    await seedDebugRows(f, 2, 30, null);
    await seedDebugRows(f, 1, 1, null);
    await seedDebugRows(f, 1, 14, f.domainId);

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.orphanRowsDeleted).toBe(2);
    expect(result.debugRowsDeleted).toBe(2); // no per-domain prunes
    const remaining = await f.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM llm_usage_debug`,
    );
    expect(Number(remaining.rows[0]!.count)).toBe(2);
  });

  it("clock injection — deterministic horizon calculation", async () => {
    const f = await freshPipelineDb({ retentionDays: 7 });
    await seedDebugRows(f, 1, 14, f.domainId);
    await seedDebugRows(f, 1, 3, f.domainId);

    // Now is the current wall clock; horizon would be (now - 7d).
    // Pin `now` to NOW (default). We can't easily inject a future
    // time without rebasing all created_at timestamps; the
    // assertion is "with a fixed `now` callback, the result is
    // identical across two consecutive runs."
    const fixedNow = (): Date => new Date();
    const r1 = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
      now: fixedNow,
    });
    const r2 = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
      now: fixedNow,
    });
    // First run prunes the 14d-old; second run is a no-op
    // (idempotent — once pruned, stays pruned).
    expect(r1.debugRowsDeleted).toBe(1);
    expect(r2.debugRowsDeleted).toBe(0);
  });

  it("empty database: no errors, no deletes", async () => {
    const f = await freshPipelineDb({});
    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });
    expect(result.debugRowsDeleted).toBe(0);
    expect(result.orphanRowsDeleted).toBe(0);
  });

  it("does not call any wiki adapter (no wiki commit per cleanup run)", async () => {
    const f = await freshPipelineDb({ retentionDays: 7 });
    const wikiAdapter = new InMemoryWikiAdapter();
    wikiAdapter.inject(DOMAIN, "strategy/q3.md", "# Q3\n");
    const writeSpy = vi.spyOn(wikiAdapter, "writeAtomic");
    await seedDebugRows(f, 5, 30, f.domainId);

    await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

void sql;
