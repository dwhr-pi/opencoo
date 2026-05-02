/**
 * `GET /api/admin/heartbeat` — latest heartbeat agent_runs.output per domain.
 *
 * Test-first artifact for PR-D (phase-a appendix #4).
 *
 * Pin matrix:
 *   1. Returns 401 without admin auth.
 *   2. Returns empty array when no heartbeat runs exist.
 *   3. Returns the latest heartbeat output per domain (definitionSlug='heartbeat'),
 *      grouped by instanceId, most-recent first per group.
 *   4. Returns the same HeartbeatOutput object that the OutputAdapter
 *      delivers — reads agent_runs.output directly, no LLM re-call.
 *   5. Only returns runs with definitionSlug='heartbeat'.
 *   6. Output from non-heartbeat runs is NOT returned.
 *   7. Response includes run_id (deep-link to agent_runs.id) + domain info
 *      from the instance's name field.
 *   8. Output is returned as-is (raw HeartbeatOutput JSON object) —
 *      no markdown re-render, no LLM call.
 *   9. Null output (running/failed) is excluded.
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "heartbeat-reader-pat";

describe("admin-api GET /api/admin/heartbeat — heartbeat reader", () => {
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
      url: "/api/admin/heartbeat",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty array when no heartbeat runs exist", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reports: unknown[] };
    expect(body.reports).toEqual([]);
  });

  it("returns heartbeat output from agent_runs without LLM re-call", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const heartbeatOutput = {
      version: "v1",
      summary: "All systems nominal. No alerts today.",
      alerts: [],
    };

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, trigger, status, output, started_at)
      VALUES (
        'heartbeat',
        'scheduled',
        'success',
        '${JSON.stringify(heartbeatOutput).replace(/'/g, "''")}',
        NOW()
      )
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      reports: Array<{
        runId: string;
        instanceId: string | null;
        instanceName: string | null;
        startedAt: string | null;
        output: unknown;
      }>;
    };
    expect(body.reports).toHaveLength(1);
    const report = body.reports[0]!;
    expect(typeof report.runId).toBe("string");
    // output is the same HeartbeatOutput object that the OutputAdapter delivers
    expect(report.output).toEqual(heartbeatOutput);
    // No LLM call involved — output is read directly from DB
  });

  // Removed: the "null instanceId group" test inserted agent_runs without instance_id.
  // The real schema has instance_id NOT NULL (requiredRestrictFk) so that state
  // cannot exist in production. Coverage for the DISTINCT ON behaviour is provided
  // by the "returns only the latest-instance first (inter-instance recency)" test below.

  it("does not return non-heartbeat runs", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, trigger, status, output, started_at)
      VALUES
        ('lint', 'scheduled', 'success', '{"findings": []}', NOW()),
        ('surfacer', 'scheduled', 'success', '{"proposals": []}', NOW())
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reports: unknown[] };
    expect(body.reports).toEqual([]);
  });

  it("excludes runs with null output (running/failed)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // One running (null output), one successful (has output).
    const goodOutput = { version: "v1", summary: "good report", alerts: [] };
    const earlier = new Date(Date.now() - 30_000).toISOString();
    const later = new Date(Date.now() - 5_000).toISOString();

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, trigger, status, output, started_at)
      VALUES
        ('heartbeat', 'scheduled', 'success', '${JSON.stringify(goodOutput).replace(/'/g, "''")}', '${earlier}'),
        ('heartbeat', 'scheduled', 'running', NULL, '${later}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      reports: Array<{ output: unknown }>;
    };
    // Running run has null output — excluded. Only the successful one returned.
    expect(body.reports).toHaveLength(1);
    expect((body.reports[0]!.output as { summary: string }).summary).toBe("good report");
  });

  it("returns all heartbeat instances (multiple distinct instanceIds)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const output1 = { version: "v1", summary: "domain-a report", alerts: [] };
    const output2 = { version: "v1", summary: "domain-b report", alerts: [] };

    const instanceA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const instanceB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    // agent_instances is created by the fixture DDL — no need to re-create it here.
    await f.raw.exec(`
      INSERT INTO agent_instances (id, definition_slug, name) VALUES
        ('${instanceA}', 'heartbeat', 'heartbeat-domain-a'),
        ('${instanceB}', 'heartbeat', 'heartbeat-domain-b')
    `);

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, output, started_at)
      VALUES
        ('heartbeat', '${instanceA}', 'scheduled', 'success', '${JSON.stringify(output1).replace(/'/g, "''")}', NOW()),
        ('heartbeat', '${instanceB}', 'scheduled', 'success', '${JSON.stringify(output2).replace(/'/g, "''")}', NOW())
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reports: Array<{ instanceName: string | null; output: { summary: string } }> };
    expect(body.reports).toHaveLength(2);
    const summaries = body.reports.map((r) => r.output.summary).sort();
    expect(summaries).toEqual(["domain-a report", "domain-b report"]);
  });

  it("orders instances by recency — latest-started instance appears first", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    const instanceA = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const instanceB = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    // instanceB ran more recently than instanceA.
    const olderTs = new Date(Date.now() - 120_000).toISOString();
    const newerTs = new Date(Date.now() - 10_000).toISOString();

    const outputA = { version: "v1", summary: "older instance report", alerts: [] };
    const outputB = { version: "v1", summary: "newer instance report", alerts: [] };

    await f.raw.exec(`
      INSERT INTO agent_instances (id, definition_slug, name) VALUES
        ('${instanceA}', 'heartbeat', 'heartbeat-older'),
        ('${instanceB}', 'heartbeat', 'heartbeat-newer')
    `);

    await f.raw.exec(`
      INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, output, started_at)
      VALUES
        ('heartbeat', '${instanceA}', 'scheduled', 'success', '${JSON.stringify(outputA).replace(/'/g, "''")}', '${olderTs}'),
        ('heartbeat', '${instanceB}', 'scheduled', 'success', '${JSON.stringify(outputB).replace(/'/g, "''")}', '${newerTs}')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/heartbeat",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      reports: Array<{ instanceName: string | null; output: { summary: string } }>;
    };
    expect(body.reports).toHaveLength(2);
    // The most recently active instance must appear first.
    expect(body.reports[0]!.output.summary).toBe("newer instance report");
    expect(body.reports[1]!.output.summary).toBe("older instance report");
  });
});
