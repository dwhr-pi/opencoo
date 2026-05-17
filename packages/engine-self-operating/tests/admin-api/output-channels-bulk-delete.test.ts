/**
 * `/api/admin/output-channels/bulk-delete` — PR-W6 (phase-a
 * appendix #15) tests.
 *
 * The bulk-delete admin-API route lets the Outputs tab clear out
 * a multi-select selection in one round-trip. Behavior pinned by
 * the tests below:
 *
 *   - happy path: every supplied id is DELETEd; one
 *     `output_channel.delete` audit row is written PER id (never
 *     one row per batch) so the operator's history reads the
 *     deletion as a discrete event per channel
 *   - 422 on a malformed id (the bad id is surfaced in the error)
 *   - 422 on a batch larger than 50 (DB lock-storm guard)
 *   - idempotent on missing ids — the response reports
 *     {deleted, skipped}; missing ids never abort the batch
 *   - auth + CSRF gate
 *
 * The dispatcher already skip-on-missing-channel for dangling
 * references in `agent_instances.output_channel_ids[]`, so the
 * route does NOT need to FK-cascade — jsonb arrays don't FK in
 * Postgres without triggers anyway.
 */
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";
import {
  buildOutputAdapterValidator,
  type OutputAdapterDescriptor,
  type OutputAdapterSlug,
} from "../../src/admin-api/routes/output-channels.js";

const ADMIN_PAT = "admin-pat-output-channels-bulk-delete";

function buildStubRegistry(): Readonly<
  Record<OutputAdapterSlug, OutputAdapterDescriptor>
> {
  const channelConfigJsonSchema = {
    type: "object" as const,
    properties: {
      project_gid: { type: "string" as const },
    },
    required: ["project_gid"] as const,
  };
  const credentialJsonSchema = {
    type: "object" as const,
    properties: {
      asanaPersonalAccessToken: {
        type: "string" as const,
        secret: true,
      },
    },
    required: ["asanaPersonalAccessToken"] as const,
  };
  return {
    asana: {
      channelConfigJsonSchema,
      credentialJsonSchema,
      validateConfig: buildOutputAdapterValidator(
        z
          .object({
            project_gid: z.string().min(1),
          })
          .strict(),
      ),
      validateCredentials: buildOutputAdapterValidator(
        z
          .object({
            asanaPersonalAccessToken: z.string().min(1),
          })
          .strict(),
      ),
    },
  };
}

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

/** Seed N channels via POST so the row + credential pair lands
 *  through the same path the operator exercises. Returns the
 *  inserted ids. */
async function seedChannels(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  names: readonly string[],
): Promise<readonly string[]> {
  const { csrfToken, cookie } = await getCsrf(fixture, ADMIN_PAT);
  const headers = {
    authorization: `Bearer ${ADMIN_PAT}`,
    "x-csrf-token": csrfToken,
    cookie: `opencoo_csrf=${cookie}`,
    "content-type": "application/json",
  };
  const ids: string[] = [];
  for (const name of names) {
    const r = await fixture.app.inject({
      method: "POST",
      url: "/api/admin/output-channels",
      headers,
      payload: {
        adapter_slug: "asana",
        name,
        config: { project_gid: `gid-${name}` },
        credentials: { asanaPersonalAccessToken: `1/${name}` },
      },
    });
    if (r.statusCode !== 201) {
      throw new Error(`seed failed (${r.statusCode}): ${r.body}`);
    }
    ids.push((JSON.parse(r.body) as { id: string }).id);
  }
  return ids;
}

describe("admin-api POST /api/admin/output-channels/bulk-delete (PR-W6 phase-a appendix #15)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("happy path: deletes every supplied id + writes ONE audit row per id", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const ids = await seedChannels(f, ["a", "b", "c"]);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels/bulk-delete",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { ids },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: 3, skipped: 0 });

    // Every row is gone.
    const remaining = await f.raw.query<{ id: string }>(
      `SELECT id::text AS id FROM output_channels`,
    );
    expect(remaining.rows).toEqual([]);

    // Exactly ONE audit row per id — never one row per batch.
    const audit = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'output_channel.delete' ORDER BY created_at ASC`,
    );
    expect(audit.rows).toHaveLength(3);
    const deletedIds = audit.rows.map(
      (r) => (r.metadata as { channel_id: string }).channel_id,
    );
    expect(new Set(deletedIds)).toEqual(new Set(ids));
    for (const row of audit.rows) {
      expect(row.metadata).toMatchObject({
        adapter_slug: "asana",
        caller_username: "alice",
      });
    }
  });

  it("422 on a malformed id (returns the bad id in the error)", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const [goodId] = await seedChannels(f, ["one"]);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels/bulk-delete",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { ids: [goodId, "not-a-uuid"] },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string; bad_id?: string };
    expect(body.error).toBe("invalid_id");
    expect(body.bad_id).toBe("not-a-uuid");

    // Nothing was deleted on the validation failure — the good id
    // still exists.
    const remaining = await f.raw.query<{ id: string }>(
      `SELECT id::text AS id FROM output_channels WHERE id = $1::uuid`,
      [goodId],
    );
    expect(remaining.rows).toHaveLength(1);
    // And NO audit row was written.
    const audit = await f.raw.query<{ id: string }>(
      `SELECT id FROM admin_audit_log WHERE action = 'output_channel.delete'`,
    );
    expect(audit.rows).toEqual([]);
  });

  it("422 when the batch exceeds the 50-id cap", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    // 51 syntactically-valid UUIDs (don't need to exist — the cap
    // check runs BEFORE the per-id existence pass).
    const ids = Array.from({ length: 51 }, (_, i) =>
      `01234567-89ab-4def-9012-${String(i).padStart(12, "0")}`,
    );
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels/bulk-delete",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { ids },
    });
    expect(res.statusCode).toBe(422);
  });

  it("idempotent: missing ids are skipped, existing ids are still deleted", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const [keepId, dropId] = await seedChannels(f, ["keep", "drop"]);
    const ghostId = "01234567-89ab-4def-9012-3456789abcde";
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels/bulk-delete",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { ids: [dropId, ghostId] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: 1, skipped: 1 });

    const remaining = await f.raw.query<{ id: string }>(
      `SELECT id::text AS id FROM output_channels`,
    );
    expect(remaining.rows.map((r) => r.id)).toEqual([keepId]);

    // Only the real delete produced an audit row — skipped ids
    // never get one, since nothing actually changed.
    const audit = await f.raw.query<{
      metadata: Record<string, unknown>;
    }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'output_channel.delete'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect((audit.rows[0]!.metadata as { channel_id: string }).channel_id).toBe(
      dropId,
    );
  });

  it("422 on empty ids array", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels/bulk-delete",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("dedupes ids so [X, X] is treated as one logical deletion", async () => {
    // Copilot review on PR-142 — without dedupe a caller sending the
    // same id twice sees `{deleted: 1, skipped: 1}`, which misreports
    // operator intent (they asked for one logical deletion). With
    // dedupe the response is `{deleted: 1, skipped: 0}` and exactly
    // ONE audit row is written.
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    const [id] = await seedChannels(f, ["only"]);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels/bulk-delete",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { ids: [id, id, id] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: 1, skipped: 0 });

    const audit = await f.raw.query<{ id: string }>(
      `SELECT id FROM admin_audit_log WHERE action = 'output_channel.delete'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("auth + CSRF gate", async () => {
    const f = await makeAdminFixture({
      outputChannelRegistry: buildStubRegistry(),
    });
    cleanup = f.close;
    await setupAdmin(f);
    // No auth → 401
    const r401 = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels/bulk-delete",
      payload: { ids: ["01234567-89ab-4def-9012-3456789abcde"] },
    });
    expect(r401.statusCode).toBe(401);
    // Auth but no CSRF → 403
    const r403 = await f.app.inject({
      method: "POST",
      url: "/api/admin/output-channels/bulk-delete",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
      payload: { ids: ["01234567-89ab-4def-9012-3456789abcde"] },
    });
    expect(r403.statusCode).toBe(403);
  });
});
