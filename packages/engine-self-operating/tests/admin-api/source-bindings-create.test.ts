/**
 * `POST /api/admin/source-bindings` — binding create (phase-a
 * appendix #2).
 *
 * Closes the regression PR 29 introduced (architecture.md §13
 * promised "Sources — list + add", PR 29 shipped only `+ list`).
 *
 * Pin matrix (11 assertions):
 *   1. happy returns id + binding row
 *   2. polling adapter (drive) writes ONE credentialStore entry
 *   3. webhook adapter (asana) writes TWO credentialStore
 *      entries — auth + webhook_secret — and BOTH ids land on
 *      the binding row
 *   4. raw credentials NEVER returned in response body
 *   5. raw credentials NEVER recorded in audit metadata
 *   6. 422 on credential schema mismatch (missing required field)
 *   7. 422 on unknown adapter slug
 *   8. 422 on unknown target_domain_slug
 *   9. review_mode default applied per defaultReviewModeFor
 *      (knowledge×fireflies → 'approve')
 *  10. 401 without auth, 403 without CSRF (auth pin)
 *  11. audit-log row 'source_binding.create' written after
 *      success
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-binding-create";
const SECRET_TOKEN = "secret-drive-service-account-XYZ";
const SECRET_WEBHOOK = "secret-fireflies-webhook-zzz";
const SECRET_API_KEY = "secret-fireflies-api-key-aaa";

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
  slug: string,
  domainClass: string = "knowledge",
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale, class) VALUES ($1, 'Test', 'en', $2::domain_class) RETURNING id`,
    [slug, domainClass],
  );
  return { id: r.rows[0]!.id };
}

describe("admin-api POST /api/admin/source-bindings (phase-a appendix #2)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("201 happy: polling drive binding lands with credentials_id only", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
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
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: SECRET_TOKEN,
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    expect(body.id).toMatch(/[0-9a-f-]{36}/);

    // Binding row carries credentials_id; webhook_secret_credentials_id NULL.
    const row = await f.raw.query<{
      credentials_id: string | null;
      webhook_secret_credentials_id: string | null;
      adapter_slug: string;
    }>(
      `SELECT credentials_id::text AS credentials_id,
              webhook_secret_credentials_id::text AS webhook_secret_credentials_id,
              adapter_slug
       FROM sources_bindings WHERE id = $1::uuid`,
      [body.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.adapter_slug).toBe("drive");
    expect(row.rows[0]!.credentials_id).not.toBeNull();
    expect(row.rows[0]!.webhook_secret_credentials_id).toBeNull();
  });

  it("polling-mode credential bytes never appear in the response body", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
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
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: SECRET_TOKEN,
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
      },
    });
    expect(res.body).not.toContain(SECRET_TOKEN);
  });

  it("webhook adapter (fireflies) populates BOTH credentials_id and webhook_secret_credentials_id", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-meet");
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
        adapter_slug: "fireflies",
        target_domain_slug: "wiki-meet",
        credentials: {
          auth: { api_key: SECRET_API_KEY },
          webhook_secret: { signing_secret: SECRET_WEBHOOK },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    const row = await f.raw.query<{
      credentials_id: string | null;
      webhook_secret_credentials_id: string | null;
    }>(
      `SELECT credentials_id::text AS credentials_id,
              webhook_secret_credentials_id::text AS webhook_secret_credentials_id
       FROM sources_bindings WHERE id = $1::uuid`,
      [body.id],
    );
    expect(row.rows[0]!.credentials_id).not.toBeNull();
    expect(row.rows[0]!.webhook_secret_credentials_id).not.toBeNull();
    // The two ids are DISTINCT (different rows in credentials).
    expect(row.rows[0]!.credentials_id).not.toBe(
      row.rows[0]!.webhook_secret_credentials_id,
    );
  });

  it("webhook-mode credential bytes never appear in the response body or audit metadata", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-meet");
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
        adapter_slug: "fireflies",
        target_domain_slug: "wiki-meet",
        credentials: {
          auth: { api_key: SECRET_API_KEY },
          webhook_secret: { signing_secret: SECRET_WEBHOOK },
        },
      },
    });
    expect(res.body).not.toContain(SECRET_WEBHOOK);
    expect(res.body).not.toContain(SECRET_API_KEY);

    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'source_binding.create'`,
    );
    expect(audit.rows).toHaveLength(1);
    const metaJson = JSON.stringify(audit.rows[0]!.metadata);
    expect(metaJson).not.toContain(SECRET_WEBHOOK);
    expect(metaJson).not.toContain(SECRET_API_KEY);
  });

  it("422 on credential schema mismatch (missing required field)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
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
        target_domain_slug: "wiki-main",
        // missing root_folder_id
        credentials: { service_account_json: SECRET_TOKEN },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("422 on unknown adapter slug", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
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
        adapter_slug: "nonexistent",
        target_domain_slug: "wiki-main",
        credentials: {},
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/unknown_adapter|validation_failed/);
  });

  it("422 on unknown target_domain_slug", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
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
        target_domain_slug: "no-such-domain",
        credentials: {
          service_account_json: SECRET_TOKEN,
          root_folder_id: "1XYZ",
        },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toMatch(/unknown_domain|target_domain/);
  });

  it("review_mode default applied per defaultReviewModeFor (knowledge × fireflies → 'approve')", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-meet");
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
        // No review_mode in payload → server picks the default.
        adapter_slug: "fireflies",
        target_domain_slug: "wiki-meet",
        credentials: {
          auth: { api_key: SECRET_API_KEY },
          webhook_secret: { signing_secret: SECRET_WEBHOOK },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    const row = await f.raw.query<{ review_mode: string }>(
      `SELECT review_mode::text AS review_mode FROM sources_bindings WHERE id = $1::uuid`,
      [body.id],
    );
    expect(row.rows[0]!.review_mode).toBe("approve");
  });

  it("explicit review_mode override is honored over the default", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
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
        target_domain_slug: "wiki-main",
        review_mode: "approve",
        credentials: {
          service_account_json: SECRET_TOKEN,
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    const row = await f.raw.query<{ review_mode: string }>(
      `SELECT review_mode::text AS review_mode FROM sources_bindings WHERE id = $1::uuid`,
      [body.id],
    );
    expect(row.rows[0]!.review_mode).toBe("approve");
  });

  it("401 without auth", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: SECRET_TOKEN,
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 without CSRF", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
    const res = await f.app.inject({
      method: "POST",
      url: "/api/admin/source-bindings",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
      payload: {
        adapter_slug: "drive",
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: SECRET_TOKEN,
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── Phase-a appendix #9 PR-Q9: config jsonb wiring ──────────────────────

  it("PR-Q9: persists the submitted `config` into sources_bindings.config", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-meet");
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
        adapter_slug: "asana",
        target_domain_slug: "wiki-meet",
        credentials: {
          auth: {
            personal_access_token: "asana-pat-zzz",
            workspace_gid: "ws-12345",
          },
          webhook_secret: { x_hook_secret: "hook-secret-aaa" },
        },
        config: { projectGid: "12345678" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    const row = await f.raw.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM sources_bindings WHERE id = $1::uuid`,
      [body.id],
    );
    expect(row.rows[0]!.config).toMatchObject({ projectGid: "12345678" });
  });

  it("PR-Q9: 422 when the adapter's required config field is missing (asana → projectGid)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-meet");
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
        adapter_slug: "asana",
        target_domain_slug: "wiki-meet",
        credentials: {
          auth: {
            personal_access_token: "asana-pat-zzz",
            workspace_gid: "ws-12345",
          },
          webhook_secret: { x_hook_secret: "hook-secret-aaa" },
        },
        // missing projectGid
        config: {},
      },
    });
    expect(res.statusCode).toBe(422);
    const errBody = JSON.parse(res.body) as {
      error: string;
      missing?: string[];
    };
    expect(errBody.error).toMatch(/binding_config|config_schema/);
    expect(errBody.missing).toContain("projectGid");
    // The binding row was NOT inserted.
    const rows = await f.raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sources_bindings`,
    );
    expect(rows.rows[0]!.count).toBe("0");
  });

  it("PR-Q9: 422 when `config` is missing entirely for an adapter with required config", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-meet");
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
        adapter_slug: "asana",
        target_domain_slug: "wiki-meet",
        credentials: {
          auth: {
            personal_access_token: "asana-pat-zzz",
            workspace_gid: "ws-12345",
          },
          webhook_secret: { x_hook_secret: "hook-secret-aaa" },
        },
        // no config key at all
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("PR-Q9: omitting `config` is OK for an adapter without required config (fireflies)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-meet");
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
        adapter_slug: "fireflies",
        target_domain_slug: "wiki-meet",
        credentials: {
          auth: { api_key: SECRET_API_KEY },
          webhook_secret: { signing_secret: SECRET_WEBHOOK },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    const row = await f.raw.query<{ config: Record<string, unknown> }>(
      `SELECT config FROM sources_bindings WHERE id = $1::uuid`,
      [body.id],
    );
    // Default `{}` jsonb value preserved.
    expect(row.rows[0]!.config).toEqual({});
  });

  it("PR-Q9: rejects non-object `config` payloads with 422", async () => {
    // Three non-object shapes a buggy client could send: a bare
    // string, an array (Zod's `z.record` rejects), and `null`.
    // All three round-trip through one fixture — the validator
    // rejects before any credential/binding write so the DB
    // stays clean across iterations. Reviewer triage on PR-Q9
    // round-2 caught that the original test only exercised the
    // string case despite naming all three.
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly config: unknown;
    }> = [
      { label: "string", config: "not-an-object" },
      { label: "array", config: ["nope"] },
      { label: "null", config: null },
    ];
    for (const { label, config } of cases) {
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
          target_domain_slug: "wiki-main",
          credentials: {
            service_account_json: SECRET_TOKEN,
            root_folder_id: "1XYZ",
          },
          config,
        },
      });
      expect(
        res.statusCode,
        `case "${label}" should 422, got ${res.statusCode}`,
      ).toBe(422);
    }
  });

  it("audit-log 'source_binding.create' written with adapter+domain metadata", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await seedDomain(f.raw, "wiki-main");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);
    await f.app.inject({
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
        target_domain_slug: "wiki-main",
        credentials: {
          service_account_json: SECRET_TOKEN,
          root_folder_id: "1XYZ",
        },
        config: { folderId: "1XYZ" },
      },
    });
    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'source_binding.create'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      adapter_slug: "drive",
      target_domain_slug: "wiki-main",
      caller_username: "alice",
    });
  });
});
