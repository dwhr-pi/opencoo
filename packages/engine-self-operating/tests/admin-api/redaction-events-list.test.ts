/**
 * `GET /api/admin/redaction-events` — metadata-only redaction events list.
 *
 * Test-first artifact for PR-D (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Returns 401 without admin auth.
 *   2. Returns empty array when no events exist.
 *   3. Each row carries: id, pipeline, domainId, bindingId, guardSlug,
 *      category, patternVersion, matchedByteRangesCount (integer),
 *      failMode, createdAt.
 *   4. matchedByteRanges (the actual ranges) is NEVER returned —
 *      only matchedByteRangesCount.
 *   5. Source bytes are NEVER returned (THREAT-MODEL §3.3).
 *   6. Supports ?pipeline= filter.
 *   7. Supports ?guard= filter.
 *   8. Supports ?category= filter.
 *   9. Supports ?limit= pagination (default 100, max 500).
 *  10. Returns rows newest-first (reverse-chrono).
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "redaction-events-pat";

// Helper to insert a redaction_events row via raw SQL.
async function insertRedactionEvent(
  raw: { exec: (sql: string) => Promise<unknown> },
  overrides: {
    pipeline?: string;
    domainId?: string | null;
    bindingId?: string | null;
    guardSlug?: string;
    category?: string;
    patternVersion?: string;
    matchedByteRanges?: Array<{ start: number; end: number }>;
    failMode?: string;
    createdAt?: string;
  } = {},
): Promise<void> {
  const pipeline = overrides.pipeline ?? "ingestion";
  const guardSlug = overrides.guardSlug ?? "guard-redaction-regex";
  const category = overrides.category ?? "pii.email";
  const patternVersion = overrides.patternVersion ?? "1.0.0";
  const matchedByteRanges = overrides.matchedByteRanges ?? [{ start: 10, end: 25 }];
  const failMode = overrides.failMode ?? "transform";
  const createdAt = overrides.createdAt ?? "NOW()";

  const domainVal =
    overrides.domainId !== undefined
      ? overrides.domainId === null
        ? "NULL"
        : `'${overrides.domainId}'::uuid`
      : "NULL";
  const bindingVal =
    overrides.bindingId !== undefined
      ? overrides.bindingId === null
        ? "NULL"
        : `'${overrides.bindingId}'::uuid`
      : "NULL";

  await raw.exec(`
    INSERT INTO redaction_events
      (pipeline, domain_id, binding_id, guard_slug, category,
       pattern_version, matched_byte_ranges, fail_mode, created_at)
    VALUES
      ('${pipeline}', ${domainVal}, ${bindingVal}, '${guardSlug}', '${category}',
       '${patternVersion}', '${JSON.stringify(matchedByteRanges).replace(/'/g, "''")}'::jsonb,
       '${failMode}', ${createdAt})
  `);
}

describe("admin-api GET /api/admin/redaction-events — metadata list", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns 401 without admin auth", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty array when no events exist", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { events: unknown[]; total: number };
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns metadata rows with required fields", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await insertRedactionEvent(f.raw, {
      pipeline: "ingestion",
      guardSlug: "guard-redaction-regex",
      category: "pii.email",
      patternVersion: "1.2.0",
      matchedByteRanges: [
        { start: 10, end: 25 },
        { start: 100, end: 115 },
      ],
      failMode: "transform",
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      events: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.events).toHaveLength(1);
    const row = body.events[0]!;

    // Required metadata fields
    expect(typeof row["id"]).toBe("string");
    expect(row["pipeline"]).toBe("ingestion");
    expect(row["guardSlug"]).toBe("guard-redaction-regex");
    expect(row["category"]).toBe("pii.email");
    expect(row["patternVersion"]).toBe("1.2.0");
    expect(row["failMode"]).toBe("transform");
    expect(typeof row["createdAt"]).toBe("string");

    // matchedByteRangesCount is a count (integer), not the actual ranges
    expect(row["matchedByteRangesCount"]).toBe(2);
    expect(typeof row["matchedByteRangesCount"]).toBe("number");
  });

  it("SECURITY: matchedByteRanges (actual ranges) is NEVER in the response", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await insertRedactionEvent(f.raw, {
      matchedByteRanges: [{ start: 42, end: 99 }],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    const body = JSON.parse(res.body) as { events: Array<Record<string, unknown>> };
    const row = body.events[0]!;

    // matchedByteRanges key must NOT be present
    expect("matchedByteRanges" in row).toBe(false);
    // matched_byte_ranges key must NOT be present
    expect("matched_byte_ranges" in row).toBe(false);
  });

  it("supports ?pipeline= filter", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await insertRedactionEvent(f.raw, { pipeline: "ingestion" });
    await insertRedactionEvent(f.raw, { pipeline: "miner" });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events?pipeline=miner",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { events: Array<{ pipeline: string }>; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.pipeline).toBe("miner");
    expect(body.total).toBe(1);
  });

  it("supports ?guard= filter", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await insertRedactionEvent(f.raw, { guardSlug: "guard-redaction-regex" });
    await insertRedactionEvent(f.raw, { guardSlug: "guard-custom-pii" });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events?guard=guard-custom-pii",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { events: Array<{ guardSlug: string }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.guardSlug).toBe("guard-custom-pii");
  });

  it("supports ?category= filter", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await insertRedactionEvent(f.raw, { category: "pii.email" });
    await insertRedactionEvent(f.raw, { category: "pii.phone" });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events?category=pii.phone",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { events: Array<{ category: string }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.category).toBe("pii.phone");
  });

  it("returns rows newest-first", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date(Date.now() - 10_000).toISOString();

    await insertRedactionEvent(f.raw, {
      pipeline: "ingestion-older",
      createdAt: `'${older}'`,
    });
    await insertRedactionEvent(f.raw, {
      pipeline: "ingestion-newer",
      createdAt: `'${newer}'`,
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    const body = JSON.parse(res.body) as {
      events: Array<{ pipeline: string }>;
    };
    expect(body.events[0]!.pipeline).toBe("ingestion-newer");
    expect(body.events[1]!.pipeline).toBe("ingestion-older");
  });

  it("clamps negative and zero ?limit= to 1 (DoS guard)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // Insert 3 events.
    for (let i = 0; i < 3; i++) {
      await insertRedactionEvent(f.raw, { pipeline: `q${i}` });
    }

    // ?limit=-1 must not return all rows — it must clamp to 1.
    const resNeg = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events?limit=-1",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(resNeg.statusCode).toBe(200);
    const bodyNeg = JSON.parse(resNeg.body) as { events: unknown[] };
    expect(bodyNeg.events).toHaveLength(1);

    // ?limit=0 must also clamp to 1.
    const resZero = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events?limit=0",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(resZero.statusCode).toBe(200);
    const bodyZero = JSON.parse(resZero.body) as { events: unknown[] };
    expect(bodyZero.events).toHaveLength(1);
  });

  it("respects ?limit= param (default 100)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // Insert 3 events.
    for (let i = 0; i < 3; i++) {
      await insertRedactionEvent(f.raw, { pipeline: `p${i}` });
    }

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events?limit=2",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    const body = JSON.parse(res.body) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(2);
    expect(body.total).toBe(3); // total count unaffected by limit
  });
});
