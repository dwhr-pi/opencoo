/**
 * `POST /api/admin/source-bindings/:id/retry-failed` — re-enqueue
 * failed classify jobs for a binding (PR-W2, phase-a appendix #14).
 *
 * Closes Layer A's "operator backfilled allowed_paths but the 260
 * already-failed BullMQ jobs are stale" gap. The route enumerates
 * the `ingestion.scanner.classify` failed-set, filters by payload
 * bindingId (and optionally intakeId), and re-enqueues each as a
 * fresh job so the compile-worker drives them through the (now
 * correctly-configured) classifier guard.
 *
 * Pin matrix:
 *   1. Bulk happy: enumerates all failed jobs for binding X,
 *      re-enqueues each, returns `{ retriedCount: N }`.
 *   2. Single-job (`?intakeId=...`): narrows to one intake.
 *   3. Idempotent: returns `{ retriedCount: 0 }` when no failed
 *      jobs exist (no error).
 *   4. 404 when the binding doesn't exist.
 *   5. 401 without auth header.
 *   6. 403 without CSRF token.
 *   7. 503 when the classify queue handle is not wired (composition
 *      incomplete) — same boot-tolerance as scan-now.
 *   8. Audit row `source_binding.retry_failed` written BEFORE the
 *      re-enqueue calls fire — a transport blip still leaves a
 *      forensic trail.
 *   9. 400 on invalid uuid.
 *  10. Audit metadata captures binding_id + target_count +
 *      intake_id (when single-job) + caller_username, NEVER any
 *      operator-supplied freeform text. The audit field is named
 *      `target_count` (NOT `retried_count`) because the value is
 *      captured BEFORE the enqueue loop runs and reflects operator
 *      INTENT — the HTTP response's `retriedCount` is the actual
 *      completed count post-loop. Copilot review #131 (id 3230502111).
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

/** Structural shape of a failed-jobs entry the composition wires
 *  into the admin-API. The real production path is
 *  `enumerateFailedJobsByBindingId` over the BullMQ
 *  `ingestion.scanner.classify` queue (see
 *  `@opencoo/engine-ingestion`); tests inject a simulated harness
 *  so the admin-API plane stays independent of bullmq. */
interface FailedJobEntry {
  readonly jobId: string;
  readonly data: {
    readonly bindingId: string;
    readonly intakeId?: string;
    readonly [k: string]: unknown;
  };
  readonly failedReason: string;
}

/** Structural shape of a BullMQ-failed-job dict the harness's
 *  pushFailed accepts. */
interface FailedJobLike {
  readonly id: string;
  readonly data: FailedJobEntry["data"];
  readonly failedReason: string;
}

const ADMIN_PAT = "admin-pat-retry-failed";

interface EnqueueCall {
  readonly name: string;
  readonly data: unknown;
  readonly opts: unknown;
}

interface FailedJobsHarness {
  readonly enumerate: (
    bindingId: string,
    intakeId?: string,
  ) => Promise<readonly FailedJobEntry[]>;
  readonly enqueue: (
    name: string,
    data: unknown,
    opts?: unknown,
  ) => Promise<unknown>;
  readonly calls: EnqueueCall[];
  /** Push a job into the simulated failed set. */
  readonly pushFailed: (job: FailedJobLike) => void;
}

function makeFailedJobsHarness(
  opts: { readonly enqueueThrows?: Error } = {},
): FailedJobsHarness {
  const jobs: FailedJobLike[] = [];
  const calls: EnqueueCall[] = [];
  return {
    // Inline filter — equivalent to the production
    // `enumerateFailedJobsByBindingId` (tested separately in
    // `packages/engine-ingestion/tests/enumerate-failed-jobs-by-binding-id.test.ts`)
    // but kept self-contained here so the admin-API test plane stays
    // independent of the bullmq import surface.
    enumerate: async (bindingId, intakeId) => {
      const out: FailedJobEntry[] = [];
      for (const j of jobs) {
        if (j.data.bindingId !== bindingId) continue;
        if (intakeId !== undefined && j.data.intakeId !== intakeId) continue;
        out.push({
          jobId: j.id,
          data: j.data,
          failedReason: j.failedReason,
        });
      }
      return out;
    },
    enqueue: async (name, data, addOpts) => {
      calls.push({ name, data, opts: addOpts });
      if (opts.enqueueThrows !== undefined) throw opts.enqueueThrows;
      return { id: `new-job-${calls.length}` };
    },
    calls,
    pushFailed: (job) => {
      jobs.push(job);
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
): Promise<{ readonly bindingId: string; readonly domainId: string }> {
  await raw.exec(`
    INSERT INTO domains (slug, name)
    VALUES ('wiki-retry-failed', 'Test')
    ON CONFLICT (slug) DO NOTHING;
  `);
  const dr = await raw.query<{ id: string }>(
    `SELECT id FROM domains WHERE slug = 'wiki-retry-failed' LIMIT 1`,
  );
  const domainId = dr.rows[0]!.id;
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled, allowed_paths)
     VALUES ($1::uuid, 'drive', 'auto'::review_mode, true, '{"meetings/**","docs/**"}'::text[])
     RETURNING id`,
    [domainId],
  );
  return { bindingId: r.rows[0]!.id, domainId };
}

describe("admin-api POST /api/admin/source-bindings/:id/retry-failed", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("bulk happy: enumerates + re-enqueues every failed job for the binding", async () => {
    const harness = makeFailedJobsHarness();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    // Seed three failed jobs: two for our binding, one for a sibling
    // binding to confirm the enumerator's filter is honoured.
    harness.pushFailed({
      id: "old-job-1",
      data: {
        bindingId,
        intakeId: "i-1",
        domainSlug: "wiki-retry-failed",
        sourceRef: "drive://1",
        contentBase64: "Zm9v",
        fetchedAt: "2026-05-12T12:00:00.000Z",
      },
      failedReason: "BindingConfigError: stub",
    });
    harness.pushFailed({
      id: "old-job-2",
      data: {
        bindingId,
        intakeId: "i-2",
        domainSlug: "wiki-retry-failed",
        sourceRef: "drive://2",
        contentBase64: "YmFy",
        fetchedAt: "2026-05-12T12:00:01.000Z",
      },
      failedReason: "BindingConfigError: stub",
    });
    harness.pushFailed({
      id: "old-job-other",
      data: {
        bindingId: "00000000-0000-0000-0000-000000000999",
        intakeId: "i-x",
        domainSlug: "wiki-other",
        sourceRef: "drive://x",
        contentBase64: "",
        fetchedAt: "2026-05-12T12:00:02.000Z",
      },
      failedReason: "BindingConfigError: stub",
    });

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { retriedCount: number };
    expect(body.retriedCount).toBe(2);

    // The re-enqueue must hand BullMQ the full original payload so
    // the compile-worker sees the same shape it did on first attempt.
    // We don't pin the job-name string here other than expecting a
    // value (the route's choice is internal); we DO pin the payload
    // shape round-trips intact.
    expect(harness.calls).toHaveLength(2);
    const intakeIds = harness.calls
      .map((c) => (c.data as { intakeId: string }).intakeId)
      .sort();
    expect(intakeIds).toEqual(["i-1", "i-2"]);
    // Sibling binding's job must NOT have been re-enqueued.
    expect(
      harness.calls.find(
        (c) =>
          (c.data as { bindingId: string }).bindingId ===
          "00000000-0000-0000-0000-000000000999",
      ),
    ).toBeUndefined();
  });

  it("single-job (?intakeId=...): re-enqueues exactly one matching job", async () => {
    const harness = makeFailedJobsHarness();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    harness.pushFailed({
      id: "old-job-1",
      data: { bindingId, intakeId: "i-1", domainSlug: "wiki-retry-failed", sourceRef: "drive://1", contentBase64: "Zm9v", fetchedAt: "2026-05-12T12:00:00.000Z" },
      failedReason: "x",
    });
    harness.pushFailed({
      id: "old-job-2",
      data: { bindingId, intakeId: "i-2", domainSlug: "wiki-retry-failed", sourceRef: "drive://2", contentBase64: "Zm9v", fetchedAt: "2026-05-12T12:00:00.000Z" },
      failedReason: "x",
    });

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed?intakeId=i-2`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { retriedCount: number };
    expect(body.retriedCount).toBe(1);
    expect(harness.calls).toHaveLength(1);
    expect((harness.calls[0]!.data as { intakeId: string }).intakeId).toBe("i-2");
  });

  it("returns {retriedCount: 0} idempotently when no failed jobs exist", async () => {
    const harness = makeFailedJobsHarness();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { retriedCount: number };
    expect(body.retriedCount).toBe(0);
    expect(harness.calls).toHaveLength(0);
  });

  it("404 when the binding doesn't exist", async () => {
    const harness = makeFailedJobsHarness();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000000/retry-failed",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("not_found");
    // Composition gate should not even reach the enumerator on 404.
    expect(harness.calls).toHaveLength(0);
  });

  it("400 on invalid uuid", async () => {
    const harness = makeFailedJobsHarness();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings/not-a-uuid/retry-failed",
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

  it("401 without auth header", async () => {
    const harness = makeFailedJobsHarness();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    const { bindingId } = await seedBinding(f.raw);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF token", async () => {
    const harness = makeFailedJobsHarness();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed`,
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("503 when the classify queue handle is not wired", async () => {
    // No enumerator / enqueuer injected → 503, same boot-tolerance
    // pattern as scan-now / forget / dispatch.
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("classify_queue_unavailable");

    // No audit row written when composition gate fires (the 503
    // means "engine misconfig", not "operator action attempted").
    const auditRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log
       WHERE action = 'source_binding.retry_failed'`,
    );
    expect(auditRows.rows.length).toBe(0);
  });

  it("audit row written BEFORE the re-enqueue (forensic trail invariant)", async () => {
    // The route's audit-before-side-effect invariant: even if the
    // enqueue call throws, the operator's action is recorded.
    const harness = makeFailedJobsHarness({
      enqueueThrows: new Error("simulated bullmq transport failure"),
    });
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    harness.pushFailed({
      id: "old-job-1",
      data: { bindingId, intakeId: "i-1", domainSlug: "wiki-retry-failed", sourceRef: "drive://1", contentBase64: "Zm9v", fetchedAt: "2026-05-12T12:00:00.000Z" },
      failedReason: "x",
    });

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    // Re-enqueue threw → 500. Audit row is in place.
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("retry_failed_enqueue_failed");

    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'source_binding.retry_failed'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0]!.metadata["binding_id"]).toBe(bindingId);
  });

  it("audit metadata captures binding_id + target_count + caller_username + intake_id (when single-job)", async () => {
    const harness = makeFailedJobsHarness();
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      failedClassifyJobsEnumerator: harness.enumerate,
      classifyJobEnqueuer: harness.enqueue,
    });
    cleanup = f.close;
    await setupAdmin(f, "alice");
    const { bindingId } = await seedBinding(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    harness.pushFailed({
      id: "old-job-1",
      data: { bindingId, intakeId: "i-1", domainSlug: "wiki-retry-failed", sourceRef: "drive://1", contentBase64: "Zm9v", fetchedAt: "2026-05-12T12:00:00.000Z" },
      failedReason: "x",
    });
    harness.pushFailed({
      id: "old-job-2",
      data: { bindingId, intakeId: "i-2", domainSlug: "wiki-retry-failed", sourceRef: "drive://2", contentBase64: "Zm9v", fetchedAt: "2026-05-12T12:00:00.000Z" },
      failedReason: "x",
    });

    // Bulk → no intake_id in metadata.
    const bulkRes = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(bulkRes.statusCode).toBe(200);

    // Then single-job → intake_id present.
    const singleRes = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/retry-failed?intakeId=i-1`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(singleRes.statusCode).toBe(200);

    const auditRows = await f.raw.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, metadata FROM admin_audit_log
       WHERE action = 'source_binding.retry_failed'
       ORDER BY created_at ASC`,
    );
    expect(auditRows.rows).toHaveLength(2);
    // Bulk: no intake_id, target_count = 2 (operator INTENT — the
    // enumerator returned 2 jobs to retry; the audit row records that
    // plan BEFORE the enqueue loop). The legacy field name
    // `retried_count` MUST NOT appear — Copilot review #131 flagged
    // it as misleading because a partial transport failure mid-loop
    // would leave the field's value larger than the actual retried
    // count surfaced in the HTTP response.
    const bulkMeta = auditRows.rows[0]!.metadata;
    expect(bulkMeta["binding_id"]).toBe(bindingId);
    expect(bulkMeta["target_count"]).toBe(2);
    expect(bulkMeta["retried_count"]).toBeUndefined();
    expect(bulkMeta["caller_username"]).toBe("alice");
    expect(bulkMeta["intake_id"]).toBeUndefined();
    // Single-job: intake_id present.
    const singleMeta = auditRows.rows[1]!.metadata;
    expect(singleMeta["binding_id"]).toBe(bindingId);
    expect(singleMeta["target_count"]).toBe(1);
    expect(singleMeta["retried_count"]).toBeUndefined();
    expect(singleMeta["caller_username"]).toBe("alice");
    expect(singleMeta["intake_id"]).toBe("i-1");
  });
});
