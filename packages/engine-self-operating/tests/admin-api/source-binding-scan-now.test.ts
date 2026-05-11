/**
 * `POST /api/admin/source-bindings/:id/scan-now` — on-demand
 * scanner dispatch (PR-Z3, phase-a appendix #12).
 *
 * Pin matrix:
 *   1. 202 happy: enqueue called + body returns `{enqueued: true, jobId}`.
 *   2. Audit row 'source_binding.scan_now' written with binding_id +
 *      caller_username.
 *   3. 400 on invalid uuid.
 *   4. 404 when binding id does not exist.
 *   5. 409 when binding is disabled.
 *   6. 401 without auth header.
 *   7. 403 without CSRF token.
 *   8. 503 when scanner queue is not wired (composition incomplete).
 *   9. 500 + audit-before-enqueue: a queue.add throw leaves the audit
 *      row in place so the operator has a forensic trail.
 *  10. Distinct jobId per click — back-to-back POSTs each enqueue with
 *      a unique jobId (no dedupe collision).
 *  11. `name` argument passed to queue.add is `scan-now` (so the
 *      scanner worker can distinguish marker jobs from cron ticks if
 *      it ever needs to).
 *
 * Plus the post-create initial-scan path (closes G6):
 *  12. POST /api/admin/source-bindings WITH an ingestionQueue wired:
 *      the binding row INSERT triggers an immediate scan enqueue.
 *  13. Without an ingestionQueue: the binding still creates cleanly
 *      (no exception); the next 4h cron tick picks it up.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-scan-now";

interface EnqueueCall {
  readonly name: string;
  readonly data: unknown;
  readonly opts: unknown;
}

function makeQueueMock(
  opts: { readonly addThrows?: Error } = {},
): {
  readonly queue: {
    getJobCounts: (...states: string[]) => Promise<Record<string, number>>;
    add: (name: string, data: unknown, opts?: unknown) => Promise<unknown>;
    name: string;
  };
  readonly calls: EnqueueCall[];
} {
  const calls: EnqueueCall[] = [];
  return {
    calls,
    queue: {
      name: "ingestion.scanner",
      getJobCounts: async () => ({}),
      add: async (name, data, addOpts) => {
        calls.push({ name, data, opts: addOpts });
        if (opts.addThrows !== undefined) throw opts.addThrows;
        return { id: `job-${calls.length}` };
      },
    },
  };
}

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  username = "alice",
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username,
    teams: ["opencoo-admins"],
  });
}

async function seedBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  enabled = true,
): Promise<{ readonly bindingId: string; readonly domainId: string }> {
  await raw.exec(`
    INSERT INTO domains (slug, name)
    VALUES ('test-domain-scan-now', 'Test')
    ON CONFLICT (slug) DO NOTHING;
  `);
  const dr = await raw.query<{ id: string }>(
    `SELECT id FROM domains WHERE slug = 'test-domain-scan-now' LIMIT 1`,
  );
  const domainId = dr.rows[0]!.id;
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
     VALUES ($1::uuid, 'drive', 'auto'::review_mode, $2)
     RETURNING id`,
    [domainId, enabled],
  );
  return { bindingId: r.rows[0]!.id, domainId };
}

describe("admin-api POST /api/admin/source-bindings/:id/scan-now", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("202 happy: enqueue called + body returns {enqueued, jobId}", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/scan-now`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { enqueued: boolean; jobId: string };
    expect(body.enqueued).toBe(true);
    expect(body.jobId).toMatch(/^scan-now-/);
    expect(body.jobId).toContain(bindingId);

    // The post-create-scan from the seed INSERT would also call add
    // ONLY if the binding was created via the admin POST handler.
    // The fixture seeds via raw SQL so the only `add` call should be
    // from the scan-now POST.
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.name).toBe("scan-now");
    expect(call.data).toEqual({});
    const callOpts = call.opts as { jobId: string };
    expect(callOpts.jobId).toBe(body.jobId);
  });

  it("audit row 'source_binding.scan_now' written with binding_id + caller_username", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f, "alice");
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/scan-now`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(202);

    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'source_binding.scan_now'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata;
    expect(meta["binding_id"]).toBe(bindingId);
    expect(meta["caller_username"]).toBe("alice");
  });

  it("400 on invalid uuid", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings/not-a-uuid/scan-now",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("invalid_id");
  });

  it("404 when binding id does not exist", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000000/scan-now",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("409 when binding is disabled", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, /* enabled */ false);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/scan-now`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("binding_disabled");

    // No audit row + no enqueue call for the disabled case — the
    // route bails before either side effect.
    const auditRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log
       WHERE action = 'source_binding.scan_now'`,
    );
    expect(auditRows.rows.length).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });

  it("401 without auth header", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    const { bindingId } = await seedBinding(f.raw);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/scan-now`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF token", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    // Issue session but deliberately omit CSRF on the POST.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/scan-now`,
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("503 when scanner queue is not wired (composition incomplete)", async () => {
    // No `ingestionQueue` injected → the route's composition gate
    // surfaces 503. Same boot-tolerance pattern as forget/dispatch.
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/scan-now`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("scanner_queue_unavailable");

    // Audit row NOT written — composition gate fires before the
    // audit-write step (the 503 means "engine misconfig", not
    // "operator action attempted").
    const auditRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log
       WHERE action = 'source_binding.scan_now'`,
    );
    expect(auditRows.rows.length).toBe(0);
  });

  it("500 + audit-before-enqueue: a queue.add throw leaves the audit row in place", async () => {
    // Pin the audit-before-side-effect invariant. The route writes
    // the audit row BEFORE calling enqueue, so a transport blip
    // still leaves a forensic trail for the operator.
    const mock = makeQueueMock({
      addThrows: new Error("simulated bullmq transport failure"),
    });
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/scan-now`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("enqueue_failed");

    // Audit row exists — written BEFORE the enqueue.
    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'source_binding.scan_now'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]!.metadata["binding_id"]).toBe(bindingId);
  });

  it("distinct jobId per back-to-back click — no dedupe collision", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Fire two POSTs in sequence — both should land with distinct
    // jobIds (the route includes Date.now() in the jobId).
    const fire = async () =>
      f.app.inject({
        method: "POST",
        url: `/api/admin/source-bindings/${bindingId}/scan-now`,
        headers: {
          authorization: `Bearer ${ADMIN_PAT}`,
          "x-csrf-token": csrfToken,
          cookie: `opencoo_csrf=${cookie}`,
        },
      });
    const res1 = await fire();
    // Tiny sleep so Date.now() advances even on the fastest hosts.
    await new Promise((r) => setTimeout(r, 5));
    const res2 = await fire();
    expect(res1.statusCode).toBe(202);
    expect(res2.statusCode).toBe(202);
    const body1 = JSON.parse(res1.body) as { jobId: string };
    const body2 = JSON.parse(res2.body) as { jobId: string };
    expect(body1.jobId).not.toBe(body2.jobId);
    expect(mock.calls).toHaveLength(2);
  });
});

describe("admin-api POST /api/admin/source-bindings — post-create initial scan (PR-Z3 closes G6)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  async function seedDomain(
    raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
    slug: string,
  ): Promise<void> {
    await raw.query(
      `INSERT INTO domains (slug, name, locale, class)
       VALUES ($1, 'Test', 'en', 'knowledge'::domain_class)`,
      [slug],
    );
  }

  it("creates the binding AND enqueues a post-create-scan when ingestionQueue is wired", async () => {
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-create-scan");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-create-scan",
        credentials: {
          service_account_json: "x".repeat(20),
          root_folder_id: "1ABC",
        },
        config: { folderId: "1ABC" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };

    // Exactly ONE add call — the post-create-scan enqueue.
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.name).toBe("post-create-scan");
    expect(call.data).toEqual({});
    const callOpts = call.opts as { jobId: string };
    expect(callOpts.jobId).toBe(`post-create-scan-${body.id}`);
  });

  it("creates the binding cleanly when ingestionQueue is undefined (cron picks it up)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-create-no-queue");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-create-no-queue",
        credentials: {
          service_account_json: "x".repeat(20),
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
      },
    });
    // The binding row still creates — the missing queue silently
    // skips the immediate-scan enqueue. The next 4h cron tick (if
    // registered) will pick it up.
    expect(res.statusCode).toBe(201);
  });

  it("creates the binding even when ingestionQueue.add throws (best-effort enqueue)", async () => {
    // A transport blip on the post-create enqueue must NOT roll
    // back the binding row — the operator already saw 201 in the
    // UI, the binding is live, and the next 4h cron tick still
    // picks it up.
    const failingMock = makeQueueMock({
      addThrows: new Error("simulated redis outage"),
    });
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: failingMock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-create-flaky");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-create-flaky",
        credentials: {
          service_account_json: "x".repeat(20),
          root_folder_id: "1FOO",
        },
        config: { folderId: "1FOO" },
      },
    });
    expect(res.statusCode).toBe(201);
    // The queue.add was attempted (the call was recorded BEFORE
    // the simulated throw fired).
    expect(failingMock.calls).toHaveLength(1);
    // We avoid vi.spyOn — the inlined makeQueueMock already records
    // calls. Just assert the call shape:
    expect(failingMock.calls[0]!.name).toBe("post-create-scan");
  });

  it("does NOT enqueue post-create-scan when the binding-create request 4xx-fails", async () => {
    // A validation failure (missing required credential field) must
    // not fire a post-create scan — there's no binding row to scan.
    const mock = makeQueueMock();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      ingestionQueue: mock.queue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-create-bad-body");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-create-bad-body",
        credentials: {}, // Missing required fields → 422.
        config: {},
      },
    });
    expect(res.statusCode).toBe(422);
    expect(mock.calls).toHaveLength(0);
  });
});
