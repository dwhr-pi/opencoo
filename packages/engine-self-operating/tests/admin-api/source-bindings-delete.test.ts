/**
 * `DELETE /api/admin/source-bindings/:id` — delete a binding
 * (PR-Q10, phase-a appendix #9).
 *
 * The Sources tab drill-down modal exposes a "Delete" action.
 * The endpoint deletes the binding row in a transaction with its
 * children in `webhook_events` + `ingestion_intake`. The schema
 * uses `ON DELETE RESTRICT`, so the explicit child-row deletes
 * are required for the parent delete to succeed.
 *
 * Pin matrix:
 *   1. 200/204 happy: deletes binding + cascades through webhook_events + ingestion_intake
 *   2. Audit row 'source_binding.delete' written with binding_id + caller_username
 *   3. 400 on invalid uuid
 *   4. 404 when binding id does not exist
 *   5. 401 without auth header
 *   6. 403 without CSRF token
 *   7. 409 when other FKs (e.g. page_citations, redaction_events) block delete
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-binding-delete";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
): Promise<{ readonly bindingId: string; readonly domainId: string }> {
  await raw.exec(`
    INSERT INTO domains (slug, name)
    VALUES ('test-domain-delete', 'Test')
    ON CONFLICT (slug) DO NOTHING;
  `);
  const dr = await raw.query<{ id: string }>(
    `SELECT id FROM domains WHERE slug = 'test-domain-delete' LIMIT 1`,
  );
  const domainId = dr.rows[0]!.id;
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
     VALUES ($1::uuid, 'drive', 'auto'::review_mode, true)
     RETURNING id`,
    [domainId],
  );
  return { bindingId: r.rows[0]!.id, domainId };
}

describe("admin-api DELETE /api/admin/source-bindings/:id", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy: deletes a fresh binding (no children) + writes audit row", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { deleted: boolean }).deleted).toBe(true);

    // Verify row gone.
    const dbRow = await f.raw.query(
      `SELECT id FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(dbRow.rows.length).toBe(0);

    // Verify audit row.
    const auditRows = await f.raw.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'source_binding.delete'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata as Record<string, unknown>;
    expect(meta["binding_id"]).toBe(bindingId);
    expect(meta["caller_username"]).toBe("alice");
  });

  it("200 happy: cascades through webhook_events + ingestion_intake", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);

    // Seed children — these would block the DELETE under RESTRICT
    // unless the endpoint clears them first.
    await f.raw.query(
      `INSERT INTO webhook_events (provider, payload_hash, signature_ok, binding_id, status)
       VALUES ('test', 'h1', true, $1::uuid, 'pending')`,
      [bindingId],
    );
    await f.raw.query(
      `INSERT INTO webhook_events (provider, payload_hash, signature_ok, binding_id, status)
       VALUES ('test', 'h2', true, $1::uuid, 'processed')`,
      [bindingId],
    );
    await f.raw.query(
      `INSERT INTO ingestion_intake (binding_id, source_doc_id, source_revision, content_hash, status)
       VALUES ($1::uuid, 'doc-1', 'rev-1', 'h1', 'pending')`,
      [bindingId],
    );

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);

    // Children gone.
    const we = await f.raw.query(
      `SELECT id FROM webhook_events WHERE binding_id = $1::uuid`,
      [bindingId],
    );
    expect(we.rows.length).toBe(0);
    const ii = await f.raw.query(
      `SELECT id FROM ingestion_intake WHERE binding_id = $1::uuid`,
      [bindingId],
    );
    expect(ii.rows.length).toBe(0);
    // Parent gone.
    const sb = await f.raw.query(
      `SELECT id FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(sb.rows.length).toBe(0);
  });

  it("400 on invalid uuid", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "DELETE",
      url: "/api/admin/source-bindings/not-a-uuid",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404 when binding id does not exist", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "DELETE",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000000",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("401 without auth header", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "DELETE",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409 when other FKs (page_citations, redaction_events, etc.) block delete", async () => {
    // The endpoint cascades only through webhook_events + ingestion_intake.
    // Other tables (page_citations, redaction_events, erasure_log, miner_runs)
    // are append-only audit; their FKs are RESTRICT and the endpoint must
    // surface a 409 rather than silently delete that history.
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId, domainId } = await seedBinding(f.raw);

    // Seed a redaction_events row pointing at the binding — RESTRICT FK.
    await f.raw.query(
      `INSERT INTO redaction_events
         (pipeline, domain_id, binding_id, guard_slug, category, pattern_version, matched_byte_ranges, fail_mode)
       VALUES ('ingest', $1::uuid, $2::uuid, 'redaction-regex', 'pii', 'v1', '[]'::jsonb, 'transform'::guard_fail_mode)`,
      [domainId, bindingId],
    );

    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/source-bindings/${bindingId}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    // 409 — the operator must clear append-only audit dependencies first
    // (or, in practice, just disable the binding instead of deleting).
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "fk_restricted",
    );
    // The parent row must still be there — transaction rolled back.
    const sb = await f.raw.query(
      `SELECT id FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(sb.rows.length).toBe(1);
  });

  it("500 when transaction fails for a non-FK reason (db connectivity, mock throw)", async () => {
    // PR-Q10b — narrow the catch from PR-Q10's "any error → 409"
    // to "FK violation (SQLSTATE 23503) only → 409". Other errors
    // (DB connectivity, syntax, permissions) must surface as 500
    // so they're not masked as fk_restricted.
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);

    // Mock db.transaction to throw a non-FK error.
    const originalTx = f.db.transaction.bind(f.db);
    (f.db as unknown as { transaction: typeof originalTx }).transaction =
      (async () => {
        throw new Error("connection terminated unexpectedly");
      }) as unknown as typeof originalTx;

    try {
      const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
      const res = await f.app.inject({
        method: "DELETE",
        url: `/api/admin/source-bindings/${bindingId}`,
        headers: {
          authorization: `Bearer ${ADMIN_PAT}`,
          "x-csrf-token": csrfToken,
          cookie: `opencoo_csrf=${cookie}`,
        },
      });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("internal_error");
      expect(body.error).not.toBe("fk_restricted");
    } finally {
      (f.db as unknown as { transaction: typeof originalTx }).transaction =
        originalTx;
    }
  });

  it("404 + no audit row when concurrent delete races inside the transaction (TOCTOU)", async () => {
    // PR-Q10b — close the TOCTOU between the existence pre-check and
    // the transactional DELETE. RETURNING id + rowcount check inside
    // the tx detects "0 rows deleted" (concurrent delete already ran)
    // and rolls back with 404 instead of returning 200 + writing a
    // spurious audit row.
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);

    // Simulate the race by deleting the row directly between the
    // pre-check and the transaction. We do this by intercepting the
    // db.transaction call: when the route enters the tx, we already
    // pulled the row out from underneath it. The cleanest seam is to
    // wrap db.transaction so the FIRST tx body run sees an
    // already-deleted row.
    const originalTx = f.db.transaction.bind(f.db);
    let deletedExternally = false;
    (f.db as unknown as { transaction: typeof originalTx }).transaction =
      (async (cb: Parameters<typeof originalTx>[0]) => {
        if (!deletedExternally) {
          await f.raw.query(`DELETE FROM sources_bindings WHERE id = $1::uuid`, [
            bindingId,
          ]);
          deletedExternally = true;
        }
        return originalTx(cb);
      }) as unknown as typeof originalTx;

    try {
      const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
      const res = await f.app.inject({
        method: "DELETE",
        url: `/api/admin/source-bindings/${bindingId}`,
        headers: {
          authorization: `Bearer ${ADMIN_PAT}`,
          "x-csrf-token": csrfToken,
          cookie: `opencoo_csrf=${cookie}`,
        },
      });
      expect(res.statusCode).toBe(404);

      // No source_binding.delete audit row — the transaction rolled
      // back because the DELETE returned 0 rows.
      const auditRows = await f.raw.query(
        `SELECT id FROM admin_audit_log WHERE action = 'source_binding.delete'`,
      );
      expect(auditRows.rows.length).toBe(0);
    } finally {
      (f.db as unknown as { transaction: typeof originalTx }).transaction =
        originalTx;
    }
  });
});
