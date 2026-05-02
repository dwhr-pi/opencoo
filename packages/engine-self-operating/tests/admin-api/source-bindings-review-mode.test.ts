/**
 * `POST /api/admin/source-bindings/:id/review-mode`
 *
 * Pin matrix:
 *   1. 200 happy path — approve (review → auto), audit row written.
 *   2. 200 happy path — reject (auto → review), audit row written.
 *   3. 404 when binding id does not exist.
 *   4. 409 when binding is already in the target mode.
 *   5. 401 without auth header, 403 without CSRF token.
 *   6. 409 concurrent-update race — rowCount=0 from UPDATE returns 409+current_mode.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-review-mode";

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
  reviewMode: string = "review",
): Promise<{ readonly bindingId: string }> {
  await raw.exec(`
    INSERT INTO domains (slug, name)
    VALUES ('test-domain-rm', 'Test')
    ON CONFLICT (slug) DO NOTHING;
  `);
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode)
     VALUES (
       (SELECT id FROM domains WHERE slug = 'test-domain-rm' LIMIT 1),
       'drive',
       $1::review_mode
     )
     RETURNING id`,
    [reviewMode],
  );
  return { bindingId: r.rows[0]!.id };
}

describe("admin-api POST /api/admin/source-bindings/:id/review-mode", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 approve — flips review → auto, writes audit row", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, "review");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/review-mode`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { reviewMode: "auto" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { reviewMode: string };
    expect(body.reviewMode).toBe("auto");

    // Verify the DB row was updated.
    const dbRow = await f.raw.query<{ review_mode: string }>(
      `SELECT review_mode::text FROM sources_bindings WHERE id = $1::uuid`,
      [bindingId],
    );
    expect(dbRow.rows[0]?.review_mode).toBe("auto");

    // Verify the audit log row was written.
    const auditRows = await f.raw.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'source_binding.review.approve'`,
    );
    expect(auditRows.rows.length).toBe(1);
    const meta = auditRows.rows[0]!.metadata as Record<string, unknown>;
    expect(meta["binding_id"]).toBe(bindingId);
    expect(meta["prev_mode"]).toBe("review");
    expect(meta["new_mode"]).toBe("auto");
  });

  it("200 reject — flips auto → review, writes audit row", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, "auto");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/review-mode`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { reviewMode: "review" },
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { reviewMode: string }).reviewMode).toBe("review");

    const auditRows = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'source_binding.review.reject'`,
    );
    expect(auditRows.rows.length).toBe(1);
  });

  it("404 when binding id does not exist", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000000/review-mode",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { reviewMode: "auto" },
    });
    expect(res.statusCode).toBe(404);
    expect((JSON.parse(res.body) as { error: string }).error).toBe("not_found");
  });

  it("409 when binding is already in the target mode", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, "auto");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/review-mode`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { reviewMode: "auto" },
    });
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { error: string }).error).toBe("already_in_target_mode");
  });

  it("401 without auth header", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings/00000000-0000-0000-0000-000000000001/review-mode",
      headers: { "content-type": "application/json" },
      payload: { reviewMode: "auto" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { bindingId } = await seedBinding(f.raw, "review");
    // Issue a session (so auth passes) but send no CSRF header.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/review-mode`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
        // No x-csrf-token, no opencoo_csrf cookie.
      },
      payload: { reviewMode: "auto" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("409 concurrent-update — returns current_mode when UPDATE rowCount=0", async () => {
    // Simulate the race where another operator beats us to the UPDATE:
    //   SELECT sees review_mode = 'review'
    //   Concurrent actor flips it to 'auto'
    //   Our UPDATE WHERE review_mode = 'review' matches 0 rows → rowCount = 0
    //
    // Strategy: build a proxy db that intercepts the UPDATE call and
    // returns {rowCount: 0} while letting all other queries (SELECT,
    // audit INSERT) pass through to the real PGlite. Wire it into a
    // minimal Fastify app with fake CSRF + injected adminContext so we
    // can reach the DB-layer race-guard code path without running the
    // full verifyAdmin chain (auth correctness is covered by pins 1–5).
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    const { bindingId } = await seedBinding(f.raw, "review");

    // Build a proxy db: intercept only the first UPDATE sources_bindings call.
    let updateIntercepted = false;
    const realExecute = (
      f.db as unknown as { execute: (...args: unknown[]) => Promise<unknown> }
    ).execute.bind(f.db);

    // Extract the flat SQL text from a Drizzle sql`` template object.
    // Drizzle stores the SQL as queryChunks: [{value: string[]}, param, ...].
    // There is no top-level `.sql` property; we join the static string parts.
    function getDrizzleSqlText(obj: unknown): string {
      const chunks = (obj as { queryChunks?: unknown[] } | null)?.queryChunks;
      if (!Array.isArray(chunks)) return "";
      return chunks
        .filter((c): c is { value: unknown[] } => Array.isArray((c as { value?: unknown }).value))
        .flatMap((c) => c.value)
        .filter((v): v is string => typeof v === "string")
        .join("");
    }

    const proxyDb = new Proxy(f.db, {
      get(target, prop) {
        if (prop !== "execute") {
          const val = (target as Record<string | symbol, unknown>)[prop as string | symbol];
          return typeof val === "function"
            ? (val as (...a: unknown[]) => unknown).bind(target)
            : val;
        }
        return async (...args: unknown[]) => {
          const sqlText = getDrizzleSqlText(args[0]);
          if (!updateIntercepted && /UPDATE\s+sources_bindings/i.test(sqlText)) {
            updateIntercepted = true;
            // Simulate 0 rows affected — concurrent write won the race.
            return { rows: [], rowCount: 0 };
          }
          return realExecute(...args);
        };
      },
    }) as typeof f.db;

    // Register a minimal Fastify app with the proxy db.
    // - Skip full verifyAdmin: inject adminContext via a preHandler hook.
    // - CSRF: supply matching header+cookie so requireCsrf passes.
    const { registerSourceBindingsRoutes } = await import(
      "../../src/admin-api/routes/source-bindings.js"
    );
    const raceApp = Fastify({ logger: false });

    // Inject adminContext before route preHandlers run.
    raceApp.addHook("preHandler", async (req) => {
      (req as unknown as Record<string, unknown>)["adminContext"] = {
        userId: "00000000-0000-0000-0000-000000000099",
        username: "race-test-user",
        role: "admin",
      };
    });

    registerSourceBindingsRoutes({
      app: raceApp,
      db: proxyDb as unknown as Parameters<typeof registerSourceBindingsRoutes>[0]["db"],
    });
    await raceApp.ready();
    cleanup = async () => { await raceApp.close(); await f.close(); };

    // Supply matching CSRF header + cookie (requireCsrf does a constant-time
    // equality check — any matching pair satisfies it).
    const fakeCsrf = "race-test-csrf-token";

    const res = await raceApp.inject({
      method: "POST",
      url: `/api/admin/source-bindings/${bindingId}/review-mode`,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": fakeCsrf,
        cookie: `opencoo_csrf=${fakeCsrf}`,
      },
      payload: { reviewMode: "auto" },
    });

    // Race guard fires: 409 with error=concurrent_update + current_mode.
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: string; current_mode: string };
    expect(body.error).toBe("concurrent_update");
    // current_mode is re-SELECTed from the live row — still 'review'
    // because the proxy intercepted the UPDATE before it ran.
    expect(body.current_mode).toBe("review");
  });
});
