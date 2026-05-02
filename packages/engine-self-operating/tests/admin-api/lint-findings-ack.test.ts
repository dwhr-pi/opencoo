/**
 * `POST /api/admin/lint-findings/:runId/acknowledge`
 *
 * Findings live in `agent_runs.output` jsonb; there is no
 * `lint_findings` table. Acknowledgement is audit-only — a
 * `lint_finding.acknowledge` row is written to `admin_audit_log`.
 * The GET endpoint annotates each finding with `acknowledgedAt`
 * by joining against the audit log.
 *
 * Pin matrix:
 *   1. 200 happy path — ack row written, run_id + finding_id in
 *      metadata.
 *   2. Audit row is present in the log after ack.
 *   3. GET /api/admin/lint-findings reflects acknowledgedAt on
 *      the acked finding.
 *   4. 404 when runId does not belong to a lint run.
 *   5. 401 without auth, 403 without CSRF.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-lint-ack";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedLintRun(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
): Promise<{ readonly runId: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO agent_runs (definition_slug, trigger, status, output)
     VALUES (
       'lint',
       'scheduled',
       'success',
       '{"findings": [{"kind": "stale-page", "path": "wiki-exec/ops/planning.md", "detail": "Old page."}]}'::jsonb
     )
     RETURNING id`,
  );
  return { runId: r.rows[0]!.id };
}

describe("admin-api POST /api/admin/lint-findings/:runId/acknowledge", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy path — audit row written with run_id + finding_id", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { runId } = await seedLintRun(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const findingId = "stale-page:wiki-exec/ops/planning.md";
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/lint-findings/${runId}/acknowledge`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { findingId, note: "triaged by alice" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; runId: string; findingId: string };
    expect(body.ok).toBe(true);
    expect(body.runId).toBe(runId);
    expect(body.findingId).toBe(findingId);
  });

  it("audit row is written to admin_audit_log", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { runId } = await seedLintRun(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const findingId = "stale-page:wiki-exec/ops/planning.md";
    await f.app.inject({
      method: "POST",
      url: `/api/admin/lint-findings/${runId}/acknowledge`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { findingId },
    });

    const rows = await f.raw.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'lint_finding.acknowledge'`,
    );
    expect(rows.rows.length).toBe(1);
    const meta = rows.rows[0]!.metadata as Record<string, unknown>;
    expect(meta["run_id"]).toBe(runId);
    expect(meta["finding_id"]).toBe(findingId);
    expect(meta["caller_username"]).toBe("alice");
  });

  it("GET /api/admin/lint-findings annotates acked findings with acknowledgedAt", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { runId } = await seedLintRun(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const findingId = "stale-page:wiki-exec/ops/planning.md";
    // Acknowledge.
    await f.app.inject({
      method: "POST",
      url: `/api/admin/lint-findings/${runId}/acknowledge`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { findingId },
    });

    // Now GET should reflect acknowledgedAt.
    const getRes = await f.app.inject({
      method: "GET",
      url: "/api/admin/lint-findings",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body) as {
      runs: Array<{
        runId: string;
        findings: Array<{ kind: string; path: string; acknowledgedAt: string | null }>;
      }>;
    };
    const run = getBody.runs.find((r) => r.runId === runId);
    expect(run).toBeDefined();
    const finding = run!.findings.find((f) => f.kind === "stale-page");
    expect(finding).toBeDefined();
    // acknowledgedAt must be an ISO timestamp string (not null) after ack.
    expect(typeof finding!.acknowledgedAt).toBe("string");
  });

  it("404 when runId does not belong to a lint run", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/lint-findings/00000000-0000-0000-0000-000000000000/acknowledge",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { findingId: "stale-page:wiki/page.md" },
    });
    expect(res.statusCode).toBe(404);
    expect((JSON.parse(res.body) as { error: string }).error).toBe("run_not_found");
  });

  it("401 without auth header", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/lint-findings/00000000-0000-0000-0000-000000000001/acknowledge",
      headers: { "content-type": "application/json" },
      payload: { findingId: "stale-page:wiki/page.md" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { runId } = await seedLintRun(f.raw);
    // Issue a session but send no CSRF headers.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/lint-findings/${runId}/acknowledge`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { findingId: "stale-page:wiki/page.md" },
    });
    expect(res.statusCode).toBe(403);
  });
});
