/**
 * Cleanup pipeline (PR-W5+, wave-17) — `sources_bindings.retention_days_override`
 * honored at sweep-time.
 *
 * Wave-15 PR-W5 (`983a41b` / #145) shipped the column write path:
 * the management UI can set `retention_days_override` per binding,
 * the admin-API PATCH enforces the audit-write-before-mutate
 * invariant, and the row column persists. Until this PR the Cleanup
 * worker ignored the column and used `domains.retention_days` only.
 *
 * Override semantics (per the W5 docstring):
 *
 *   effective retention =
 *     COALESCE(sources_bindings.retention_days_override,
 *              domains.retention_days,
 *              DEFAULT_DEBUG_RETENTION_DAYS)
 *
 * Today the only age-out sweep target is `llm_usage_debug` (joined
 * via `llm_usage.domain_id` to attribute rows to a domain). The
 * schema does NOT carry a `binding_id` on `llm_usage`, so debug
 * rows cannot be attributed to a specific binding — the per-binding
 * override semantics collapse to a per-domain cutoff. The collapse
 * picks the STRICTEST policy: `MIN(retention_days_override)` across
 * the domain's bindings (falling back to `domains.retention_days`
 * when every binding override is NULL). The privacy rationale is
 * THREAT-MODEL §2 invariant 11: a binding's explicit "keep my
 * debug data <= N days" must never be silently bypassed by another
 * binding under the same domain wanting a longer horizon. The
 * minority of operators who want per-binding granular cutoffs on
 * debug rows will need a future schema change to add `binding_id`
 * to `llm_usage` (out of scope for W5+).
 *
 * Test cases below model the four scenarios from the brief, framed
 * for the per-domain MIN-collapse semantics. The "mixed bindings"
 * test is the one that materially differs from the brief's literal
 * wording (which assumed per-row binding attribution); the test
 * comment names this deviation explicitly.
 *
 * Cross-binding isolation is also pinned: a row attributable to
 * domain-A's bindings must never be deleted by a sweep of domain-B,
 * regardless of override values. This guards against the "JOIN
 * accidentally drops the WHERE on domain_id" failure mode.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

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

async function addBinding(
  f: PipelineFixture,
  args: { domainId: string; override: number | null; adapterSlug?: string },
): Promise<string> {
  const r = await f.raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, allowed_paths, retention_days_override)
     VALUES ($1, $2, '{}'::text[], $3) RETURNING id`,
    [args.domainId, args.adapterSlug ?? "drive", args.override],
  );
  return r.rows[0]!.id;
}

async function addDomain(
  f: PipelineFixture,
  args: { slug: string; retentionDays: number | null },
): Promise<string> {
  const r = await f.raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, retention_days) VALUES ($1, $2, $3) RETURNING id`,
    [args.slug, args.slug, args.retentionDays],
  );
  return r.rows[0]!.id;
}

async function setBindingOverride(
  f: PipelineFixture,
  bindingId: string,
  override: number | null,
): Promise<void> {
  await f.raw.query(
    `UPDATE sources_bindings SET retention_days_override = $1 WHERE id = $2`,
    [override, bindingId],
  );
}

async function seedDebugRows(
  f: PipelineFixture,
  args: { count: number; ageDaysAgo: number; domainId: string | null },
): Promise<void> {
  for (let i = 0; i < args.count; i++) {
    const usageResult = await f.raw.query<{ id: string }>(
      `INSERT INTO llm_usage (engine, tier, model, pipeline_or_agent, domain_id, tokens_in, tokens_out, cost_usd, latency_ms, timestamp, created_at)
       VALUES ('ingestion', 'worker', 'gpt-4o-mini', 'classifier', $1::uuid, 1, 1, '0.000001', 1, NOW() - ($2::text || ' days')::interval, NOW() - ($2::text || ' days')::interval)
       RETURNING id`,
      [args.domainId, String(args.ageDaysAgo)],
    );
    const usageId = usageResult.rows[0]!.id;
    await f.raw.query(
      `INSERT INTO llm_usage_debug (usage_id, prompt_text, response_text, created_at)
       VALUES ($1, 'p', 'r', NOW() - ($2::text || ' days')::interval)`,
      [usageId, String(args.ageDaysAgo)],
    );
  }
}

async function countDebugRows(
  f: PipelineFixture,
  domainId: string | null,
): Promise<number> {
  if (domainId === null) {
    const r = await f.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM llm_usage_debug d
       JOIN llm_usage u ON u.id = d.usage_id
       WHERE u.domain_id IS NULL`,
    );
    return Number(r.rows[0]!.count);
  }
  const r = await f.raw.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM llm_usage_debug d
     JOIN llm_usage u ON u.id = d.usage_id
     WHERE u.domain_id = $1::uuid`,
    [domainId],
  );
  return Number(r.rows[0]!.count);
}

describe("runCleanup — retention_days_override semantics (PR-W5+, wave-17)", () => {
  it("override null: domain default retains current behavior", async () => {
    // Single binding, override null. Domain retention_days = 90.
    // Rows 100 days old delete; rows 1 day old remain.
    const f = await freshPipelineDb({ retentionDays: 90 });
    // The fixture's default binding has override = null by default.
    await seedDebugRows(f, { count: 1, ageDaysAgo: 100, domainId: f.domainId });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 1, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(1);
    expect(await countDebugRows(f, f.domainId)).toBe(1);
  });

  it("override set: binding override wins over domain default", async () => {
    // Single binding, override = 7. Domain retention_days = 90.
    // Rows older than 7 days delete (override wins), not 90.
    const f = await freshPipelineDb({ retentionDays: 90 });
    await setBindingOverride(f, f.bindingId, 7);
    // 10-day-old row should delete under the 7-day override; under
    // the 90-day default it would survive.
    await seedDebugRows(f, { count: 1, ageDaysAgo: 10, domainId: f.domainId });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 3, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(1);
    expect(await countDebugRows(f, f.domainId)).toBe(1);
  });

  it("mixed bindings under one domain: strictest override wins (per-domain MIN collapse)", async () => {
    // Two bindings under one domain. Binding-A override = 7; binding-B
    // override = null. Domain retention_days = 90. The privacy-
    // preserving collapse picks MIN(7, 90) = 7 as the per-domain
    // effective cutoff — binding-A's strict policy is honored even
    // though debug rows under this domain cannot be attributed to a
    // specific binding (llm_usage has no binding_id; documented
    // schema limitation deferred to a future PR).
    //
    // This is the test case that deviates from the brief's literal
    // wording. The brief assumed per-row binding attribution; the
    // current schema requires the collapse. The semantic
    // alternative — picking MAX so binding-B's loose policy bypasses
    // binding-A's strict one — would silently weaken a security
    // setting and violate THREAT-MODEL §2 invariant 11.
    const f = await freshPipelineDb({ retentionDays: 90 });
    // Default binding stays as binding-B (override = null).
    await addBinding(f, {
      domainId: f.domainId,
      override: 7,
      adapterSlug: "asana",
    });
    // 10 days old — between 7 (strictest override) and 90 (domain).
    // Under MIN collapse, this row deletes; under domain-only it
    // would survive.
    await seedDebugRows(f, { count: 1, ageDaysAgo: 10, domainId: f.domainId });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 3, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(1);
    expect(await countDebugRows(f, f.domainId)).toBe(1);
  });

  it("override > domain retention: longer-keep override is honored when it is the only binding", async () => {
    // Single binding, override = 365. Domain retention_days = 30.
    // Rows on this binding's domain keep for 365 days (override
    // wins). 60-day-old row survives; 400-day-old row deletes.
    const f = await freshPipelineDb({ retentionDays: 30 });
    await setBindingOverride(f, f.bindingId, 365);
    await seedDebugRows(f, { count: 1, ageDaysAgo: 60, domainId: f.domainId });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 400, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(1);
    // The 60-day-old row survives because 60 < 365.
    expect(await countDebugRows(f, f.domainId)).toBe(1);
  });

  it("override > domain retention WITH a sibling NULL-override binding: sibling's domain-default policy wins (per-binding effective, then MIN)", async () => {
    // PR #182 Copilot regression test. Two bindings under one
    // domain. Binding-A override = 365 (loose). Binding-B override =
    // NULL, which means "use the domain default" = 30. The per-
    // binding effective retentions are 365 and 30; their MIN is 30,
    // so the per-domain cutoff is 30 days — binding-B's stricter
    // policy is honored, NOT silently weakened by binding-A's 365.
    //
    // The earlier shape of this PR took MIN only over non-null
    // overrides (skipping binding-B's NULL), which would have made
    // the cutoff 365 and let one long override weaken every sibling
    // binding's policy. Copilot review caught it; this test pins
    // the correction.
    const f = await freshPipelineDb({ retentionDays: 30 });
    await setBindingOverride(f, f.bindingId, 365);
    await addBinding(f, {
      domainId: f.domainId,
      override: null,
      adapterSlug: "fireflies",
    });
    // 60-day-old row: under broken MIN-skipping-NULL → 365 cutoff →
    // survives. Under correct per-binding-effective MIN → 30 cutoff
    // → deletes.
    await seedDebugRows(f, { count: 1, ageDaysAgo: 60, domainId: f.domainId });
    // 1-day-old row: always survives (1 < 30).
    await seedDebugRows(f, { count: 1, ageDaysAgo: 1, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(1);
    expect(await countDebugRows(f, f.domainId)).toBe(1);
    expect(result.perDomain[0]!.retentionDays).toBe(30);
  });

  it("cross-domain isolation: a sweep of one domain never deletes rows from another", async () => {
    // Two domains, each with its own binding. Domain-A
    // retention_days = 7 (strict). Domain-B retention_days = 365
    // (lenient). A 30-day-old row under domain-B must NOT be
    // deleted by the sweep, even though it is older than domain-A's
    // 7-day cutoff. The COALESCE join in the new query must scope
    // the WHERE clause to (domain_id, effective_horizon) per
    // domain.
    const f = await freshPipelineDb({ retentionDays: 7 });
    const domainBId = await addDomain(f, {
      slug: "domain-b",
      retentionDays: 365,
    });
    await addBinding(f, { domainId: domainBId, override: null });

    await seedDebugRows(f, { count: 1, ageDaysAgo: 30, domainId: f.domainId });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 30, domainId: domainBId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    // Domain-A's 30-day-old row deletes (>7d); domain-B's survives
    // (<365d).
    expect(result.debugRowsDeleted).toBe(1);
    expect(await countDebugRows(f, f.domainId)).toBe(0);
    expect(await countDebugRows(f, domainBId)).toBe(1);
  });

  it("domain with bindings all having NULL override falls back to domains.retention_days", async () => {
    // Two bindings under one domain; both have override = null.
    // Domain retention_days = 30. Behavior matches pre-W5+ default.
    const f = await freshPipelineDb({ retentionDays: 30 });
    await addBinding(f, {
      domainId: f.domainId,
      override: null,
      adapterSlug: "fireflies",
    });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 60, domainId: f.domainId });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 1, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(1);
    expect(await countDebugRows(f, f.domainId)).toBe(1);
  });

  it("domain with NULL retention_days AND null override falls back to DEFAULT_DEBUG_RETENTION_DAYS", async () => {
    // No domain retention configured AND no binding override.
    // Result: default 7-day horizon applies (unchanged from
    // pre-W5+).
    const f = await freshPipelineDb({});
    expect(DEFAULT_DEBUG_RETENTION_DAYS).toBe(7);
    await seedDebugRows(f, { count: 1, ageDaysAgo: 10, domainId: f.domainId });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 1, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.debugRowsDeleted).toBe(1);
    expect(await countDebugRows(f, f.domainId)).toBe(1);
  });

  it("override applied even when domains.retention_days is NULL", async () => {
    // Domain retention_days = NULL; binding override = 14. The
    // COALESCE chain picks the override before the
    // DEFAULT_DEBUG_RETENTION_DAYS fallback.
    const f = await freshPipelineDb({});
    await setBindingOverride(f, f.bindingId, 14);
    await seedDebugRows(f, { count: 1, ageDaysAgo: 20, domainId: f.domainId });
    await seedDebugRows(f, { count: 1, ageDaysAgo: 10, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    // 20-day-old row exceeds the 14-day override and deletes; the
    // 10-day-old row survives (10 < 14). Under the pre-W5+ default
    // fallback (7 days) the 10-day-old row would have deleted too.
    expect(result.debugRowsDeleted).toBe(1);
    expect(await countDebugRows(f, f.domainId)).toBe(1);
  });

  it("perDomain result records the effective retention used per domain", async () => {
    // Effective retention reported back to the operator includes
    // the override-driven value, not just domains.retention_days.
    const f = await freshPipelineDb({ retentionDays: 90 });
    await setBindingOverride(f, f.bindingId, 7);
    await seedDebugRows(f, { count: 1, ageDaysAgo: 10, domainId: f.domainId });

    const result = await runCleanup({
      db: f.db as unknown as Parameters<typeof runCleanup>[0]["db"],
      logger: silentLogger(),
    });

    expect(result.perDomain).toHaveLength(1);
    expect(result.perDomain[0]!.retentionDays).toBe(7);
    expect(result.perDomain[0]!.deleted).toBe(1);
  });
});
