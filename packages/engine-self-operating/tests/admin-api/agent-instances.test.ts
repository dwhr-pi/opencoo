/**
 * `/api/admin/agent-instances` admin routes (PR-W2,
 * phase-a appendix #13 — closes G2).
 *
 * Pin matrix:
 *   GET
 *     1. 200: returns rows with outputChannelCount + lastRun fields
 *     2. 200: empty result when no instances seeded
 *
 *   PATCH {output_channel_ids}
 *     3. 200: replaces the binding array + writes audit
 *     4. 422: unknown_output_channel_ids when any UUID dangles
 *     5. 200: empty array is a legal value (operator un-binds everything)
 *
 *   PATCH {enabled}
 *     6. 200: flips the row + writes audit
 *
 *   PATCH {schedule_cron}
 *     7. 200: valid cron updates + writes audit
 *     8. 422: invalid_cron rejects a garbage pattern
 *
 *   Mixed body
 *     9. 400: mixed_patch_body on >1 branch in one request
 *
 *   404 / 400 / auth
 *    10. 404 on unknown instance id
 *    11. 400 on invalid :id uuid
 *    12. 401 without auth
 *    13. 403 without CSRF
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-agent-instances";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
): Promise<string> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name) VALUES ('w-agent-instances', 'AI') RETURNING id`,
  );
  return r.rows[0]!.id;
}

async function seedInstance(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  domainId: string,
  args: {
    readonly definitionSlug?: string;
    readonly name?: string;
    readonly scheduleCron?: string | null;
    readonly enabled?: boolean;
    readonly outputChannelIds?: ReadonlyArray<{
      readonly adapter_slug: string;
      readonly config: Record<string, unknown>;
    }>;
  } = {},
): Promise<string> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO agent_instances
       (definition_slug, name, scope_domain_ids, schedule_cron, enabled, output_channel_ids)
     VALUES ($1, $2, ARRAY[$3]::uuid[], $4, $5, $6::jsonb)
     RETURNING id`,
    [
      args.definitionSlug ?? "heartbeat",
      args.name ?? "Heartbeat",
      domainId,
      args.scheduleCron ?? null,
      args.enabled ?? true,
      JSON.stringify(args.outputChannelIds ?? []),
    ],
  );
  return r.rows[0]!.id;
}

async function seedChannel(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  args: {
    readonly adapterSlug?: string;
    readonly name?: string;
    readonly config?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO output_channels (adapter_slug, name, config)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [
      args.adapterSlug ?? "asana",
      args.name ?? `channel-${Math.random().toString(36).slice(2, 8)}`,
      JSON.stringify(args.config ?? { project_gid: "p-1" }),
    ],
  );
  return r.rows[0]!.id;
}

describe("admin-api /api/admin/agent-instances (PR-W2)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  // ── GET ────────────────────────────────────────────────────────────────

  it("GET returns rows with outputChannelCount + lastRun fields", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const c1 = await seedChannel(f.raw);
    await seedInstance(f.raw, domainId, {
      definitionSlug: "heartbeat",
      name: "Heartbeat 06:00",
      scheduleCron: "0 6 * * 1-5",
      outputChannelIds: [
        { adapter_slug: "asana", config: { channel_id: c1 } },
      ],
    });

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-instances",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: ReadonlyArray<{
        id: string;
        definitionSlug: string;
        name: string;
        scheduleCron: string | null;
        enabled: boolean;
        outputChannelCount: number;
        lastRunStartedAt: string | null;
        lastRunStatus: string | null;
      }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.definitionSlug).toBe("heartbeat");
    expect(body.rows[0]!.name).toBe("Heartbeat 06:00");
    expect(body.rows[0]!.scheduleCron).toBe("0 6 * * 1-5");
    expect(body.rows[0]!.enabled).toBe(true);
    expect(body.rows[0]!.outputChannelCount).toBe(1);
    expect(body.rows[0]!.lastRunStartedAt).toBe(null);
    expect(body.rows[0]!.lastRunStatus).toBe(null);
  });

  it("GET returns empty rows when no instances seeded", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/agent-instances",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  // ── PATCH {output_channel_ids} ─────────────────────────────────────────

  it("PATCH {output_channel_ids} replaces bindings + audits", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const instanceId = await seedInstance(f.raw, domainId);
    const c1 = await seedChannel(f.raw, { name: "ch-1" });
    const c2 = await seedChannel(f.raw, { name: "ch-2" });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/agent-instances/${instanceId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { output_channel_ids: [c1, c2] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ updated: true });

    // DB row carries the constructed `[{adapter_slug, config: {channel_id}}]`.
    const dbRow = await f.raw.query<{ output_channel_ids: unknown }>(
      `SELECT output_channel_ids FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    const bindings = dbRow.rows[0]!.output_channel_ids as ReadonlyArray<{
      adapter_slug: string;
      config: Record<string, unknown>;
    }>;
    expect(bindings).toHaveLength(2);
    expect(bindings[0]!.adapter_slug).toBe("asana");
    expect(bindings[0]!.config["channel_id"]).toBe(c1);
    expect(bindings[1]!.config["channel_id"]).toBe(c2);

    // Audit row recorded with the UUID list (no credential bytes).
    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'agent_instance.bind_outputs'`,
    );
    expect(auditRows.rows).toHaveLength(1);
    const meta = auditRows.rows[0]!.metadata;
    expect(meta["binding_id"]).toBe(instanceId);
    expect(meta["output_channel_ids"]).toEqual([c1, c2]);
    expect(meta["caller_username"]).toBe("alice");
  });

  it("PATCH {output_channel_ids} rejects dangling UUIDs with 422", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const instanceId = await seedInstance(f.raw, domainId);
    const c1 = await seedChannel(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Well-formed v4 UUID that isn't in the output_channels table.
    const danglingId = "deadbeef-1234-4567-89ab-cdef01234567";
    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/agent-instances/${instanceId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { output_channel_ids: [c1, danglingId] },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as {
      error: string;
      missing: string[];
    };
    expect(body.error).toBe("unknown_output_channel_ids");
    expect(body.missing).toContain(danglingId);
    // The DB row remained at its prior empty-binding state.
    const dbRow = await f.raw.query<{ output_channel_ids: unknown }>(
      `SELECT output_channel_ids FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    expect(dbRow.rows[0]!.output_channel_ids).toEqual([]);
    // No audit row written on the failure path.
    const auditRows = await f.raw.query(
      `SELECT id FROM admin_audit_log WHERE action = 'agent_instance.bind_outputs'`,
    );
    expect(auditRows.rows).toHaveLength(0);
  });

  it("PATCH {output_channel_ids} rejects duplicate UUIDs with 422", async () => {
    // Copilot triage #3 — duplicate UUIDs in the binding array
    // would otherwise let the dispatcher deliver to the same
    // channel multiple times per run. Strict 422 so the operator
    // is made aware of the double-binding intent (matches the
    // existing 422 pattern for unknown_output_channel_ids).
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const instanceId = await seedInstance(f.raw, domainId);
    const c1 = await seedChannel(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/agent-instances/${instanceId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { output_channel_ids: [c1, c1] },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as {
      error: string;
      duplicates: string[];
    };
    expect(body.error).toBe("duplicate_output_channel_ids");
    expect(body.duplicates).toEqual([c1]);
    // Audit NOT written on validation failure.
    const auditRows = await f.raw.query(
      `SELECT id FROM admin_audit_log WHERE action = 'agent_instance.bind_outputs'`,
    );
    expect(auditRows.rows).toHaveLength(0);
    // DB row unchanged.
    const dbRow = await f.raw.query<{ output_channel_ids: unknown }>(
      `SELECT output_channel_ids FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    expect(dbRow.rows[0]!.output_channel_ids).toEqual([]);
  });

  it("PATCH {output_channel_ids: []} is a legal un-bind", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const c1 = await seedChannel(f.raw);
    const instanceId = await seedInstance(f.raw, domainId, {
      outputChannelIds: [
        { adapter_slug: "asana", config: { channel_id: c1 } },
      ],
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/agent-instances/${instanceId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { output_channel_ids: [] },
    });
    expect(res.statusCode).toBe(200);
    const dbRow = await f.raw.query<{ output_channel_ids: unknown }>(
      `SELECT output_channel_ids FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    expect(dbRow.rows[0]!.output_channel_ids).toEqual([]);
  });

  // ── PATCH {enabled} ────────────────────────────────────────────────────

  it("PATCH {enabled: false} flips + audits", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const instanceId = await seedInstance(f.raw, domainId, { enabled: true });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/agent-instances/${instanceId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const dbRow = await f.raw.query<{ enabled: boolean }>(
      `SELECT enabled FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    expect(dbRow.rows[0]!.enabled).toBe(false);
    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'agent_instance.set_enabled'`,
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]!.metadata["enabled"]).toBe(false);
    expect(auditRows.rows[0]!.metadata["caller_username"]).toBe("alice");
  });

  // ── PATCH {schedule_cron} ──────────────────────────────────────────────

  it("PATCH {schedule_cron} valid pattern updates + audits", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const instanceId = await seedInstance(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/agent-instances/${instanceId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { schedule_cron: "0 7 * * 1-5" },
    });
    expect(res.statusCode).toBe(200);
    const dbRow = await f.raw.query<{ schedule_cron: string }>(
      `SELECT schedule_cron FROM agent_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    expect(dbRow.rows[0]!.schedule_cron).toBe("0 7 * * 1-5");
    const auditRows = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'agent_instance.set_schedule'`,
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]!.metadata["schedule_cron"]).toBe("0 7 * * 1-5");
  });

  it("PATCH {schedule_cron} rejects garbage cron with 422 invalid_cron", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const instanceId = await seedInstance(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/agent-instances/${instanceId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { schedule_cron: "not a cron" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toBe("invalid_cron");
    // Audit NOT written on validation failure.
    const auditRows = await f.raw.query(
      `SELECT id FROM admin_audit_log WHERE action = 'agent_instance.set_schedule'`,
    );
    expect(auditRows.rows).toHaveLength(0);
  });

  // ── Mixed body ─────────────────────────────────────────────────────────

  it("PATCH with >1 branch in body returns 400 mixed_patch_body", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const domainId = await seedDomain(f.raw);
    const instanceId = await seedInstance(f.raw, domainId);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/agent-instances/${instanceId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        enabled: false,
        schedule_cron: "0 6 * * 1-5",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("mixed_patch_body");
  });

  // ── 404 / 400 / auth ───────────────────────────────────────────────────

  it("PATCH 404 on unknown instance id", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/agent-instances/00000000-0000-0000-0000-000000000000",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH 400 on invalid :id uuid", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/agent-instances/not-a-uuid",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH 401 without auth header", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/agent-instances/00000000-0000-0000-0000-000000000001",
      headers: { "content-type": "application/json" },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(401);
  });

  it("PATCH 403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/agent-instances/00000000-0000-0000-0000-000000000001",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
  });
});
