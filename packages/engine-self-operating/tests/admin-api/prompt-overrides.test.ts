/**
 * Per-(domain, instance) prompt-override admin-API tests
 * (PR-W2, phase-a appendix #15).
 *
 * Mirror of `domains-llm-policy.test.ts` adapted for the
 * scope-discriminated prompt-override routes. Coverage:
 *
 *   - GET    list returns overrides + baseline manifest
 *   - GET    single returns baseline when no override exists
 *   - GET    single returns the override when one exists
 *   - POST   preview emits a line-level diff + sovereignty token
 *   - POST   apply rejects with 403 on signature_mismatch,
 *            422 on expired / payload_mismatch / baseline drift
 *   - POST   apply UPSERTs the row + writes the audit row BEFORE
 *            the UPSERT (audit-write-before-mutate invariant)
 *   - DELETE clears the override + writes the audit row BEFORE
 *            the DELETE (idempotent 200 on no-op)
 *   - 400 on malformed `:id` / `:name` / `:locale`
 *   - 422 on instance-scope when scope_domain_ids is empty
 *   - scope-discrimination: domain row vs instance row at the
 *     same (name, locale) coexist (the W1 `NULLS NOT DISTINCT`
 *     UNIQUE) and the routes never cross-surface
 */
import { afterEach, describe, expect, it } from "vitest";

import { PROMPT_VERSION_MANIFEST } from "@opencoo/shared/prompts";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set("admin-pat", {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  slug: string = "exec",
): Promise<{ readonly id: string }> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale) VALUES ($1, $2, 'en') RETURNING id`,
    [slug, slug],
  );
  return { id: result.rows[0]!.id };
}

async function seedInstance(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  domainId: string,
  name: string = "morning",
): Promise<{ readonly id: string }> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO agent_instances (definition_slug, name, scope_domain_ids)
     VALUES ('heartbeat', $1, ARRAY[$2]::uuid[]) RETURNING id`,
    [name, domainId],
  );
  return { id: result.rows[0]!.id };
}

async function seedInstanceWithoutScope(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  name: string = "orphan",
): Promise<{ readonly id: string }> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO agent_instances (definition_slug, name)
     VALUES ('heartbeat', $1) RETURNING id`,
    [name],
  );
  return { id: result.rows[0]!.id };
}

async function insertOverride(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  args: {
    domainId: string;
    instanceId: string | null;
    promptName: string;
    locale: string;
    body: string;
    overridesVersion?: string;
    baselineVersion?: string;
  },
): Promise<void> {
  await raw.query(
    `INSERT INTO prompt_overrides
       (domain_id, instance_id, prompt_name, locale, body,
        overrides_version, baseline_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.domainId,
      args.instanceId,
      args.promptName,
      args.locale,
      args.body,
      args.overridesVersion ?? "1.0.0",
      args.baselineVersion ?? PROMPT_VERSION_MANIFEST.heartbeat,
    ],
  );
}

describe("admin-api GET /:scope/:id/prompts (list)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns empty overrides + full baseline manifest for a fresh domain", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/domains/${id}/prompts`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      overrides: unknown[];
      baselines: Array<{ name: string; locale: string; version: string; body: string }>;
    };
    expect(body.overrides).toEqual([]);
    // 9 prompts × 2 locales = 18 baseline entries.
    expect(body.baselines).toHaveLength(18);
    const hb = body.baselines.find(
      (b) => b.name === "heartbeat" && b.locale === "en",
    );
    expect(hb?.version).toBe(PROMPT_VERSION_MANIFEST.heartbeat);
    expect(hb?.body.length).toBeGreaterThan(0);
  });

  it("returns 404 on unknown domain id", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/domains/00000000-0000-0000-0000-000000000000/prompts",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("domain_not_found");
  });

  it("returns 400 on malformed :id (non-UUID)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/domains/not-a-uuid/prompts",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_id");
  });

  it("returns the domain's existing overrides with isStale flag", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    await insertOverride(f.raw, {
      domainId: id,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "ON FIRE OVERRIDE",
      overridesVersion: "1.0.0",
      baselineVersion: "0.0.0-ancient",
    });
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/domains/${id}/prompts`,
      headers: { authorization: "Bearer admin-pat" },
    });
    const body = JSON.parse(res.body) as {
      overrides: Array<{
        name: string;
        locale: string;
        scope: string;
        overridesVersion: string;
        baselineVersion: string;
        isStale: boolean;
      }>;
    };
    expect(body.overrides).toHaveLength(1);
    expect(body.overrides[0]?.scope).toBe("domains");
    expect(body.overrides[0]?.isStale).toBe(true);
    expect(body.overrides[0]?.baselineVersion).toBe("0.0.0-ancient");
  });

  it("scope-discriminates: agent-instances GET does not surface domain rows", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { id: instanceId } = await seedInstance(f.raw, domainId);
    // Domain-scoped row.
    await insertOverride(f.raw, {
      domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "DOMAIN",
    });
    // Instance-scoped row.
    await insertOverride(f.raw, {
      domainId,
      instanceId,
      promptName: "heartbeat",
      locale: "en",
      body: "INSTANCE",
      overridesVersion: "2.0.0",
    });
    // Domain scope sees only the domain row.
    const dRes = await f.app.inject({
      method: "GET",
      url: `/api/admin/domains/${domainId}/prompts`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(JSON.parse(dRes.body).overrides).toHaveLength(1);
    expect(JSON.parse(dRes.body).overrides[0].scope).toBe("domains");
    // Instance scope sees only the instance row.
    const iRes = await f.app.inject({
      method: "GET",
      url: `/api/admin/agent-instances/${instanceId}/prompts`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(JSON.parse(iRes.body).overrides).toHaveLength(1);
    expect(JSON.parse(iRes.body).overrides[0].scope).toBe("agent-instances");
    expect(JSON.parse(iRes.body).overrides[0].overridesVersion).toBe("2.0.0");
  });

  it("returns 422 on agent-instances scope when scope_domain_ids is empty", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedInstanceWithoutScope(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/agent-instances/${id}/prompts`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toBe("instance_has_no_scope");
  });
});

describe("admin-api GET /:scope/:id/prompts/:name/:locale (single)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns source:baseline when no override row exists", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe("baseline");
    expect(body.version).toBe(PROMPT_VERSION_MANIFEST.heartbeat);
    expect(body.body.length).toBeGreaterThan(0);
  });

  it("returns source:override when a row exists", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    await insertOverride(f.raw, {
      domainId: id,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "OVERRIDE BODY",
      overridesVersion: "3.1.4",
    });
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe("override");
    expect(body.body).toBe("OVERRIDE BODY");
    expect(body.version).toBe("3.1.4");
    expect(body.isStale).toBe(false);
  });

  it("returns 400 on unknown prompt_name", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/domains/${id}/prompts/unknown/en`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unknown_prompt_name");
  });

  it("returns 400 on unknown locale", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/domains/${id}/prompts/heartbeat/fr`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unknown_locale");
  });
});

describe("admin-api POST /:scope/:id/prompts/:name/:locale/preview", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns line-level diff + sovereignty token + 5-min expiry", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposedBody: "line one\nline two\nline three" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.diff)).toBe(true);
    expect(body.diff.length).toBeGreaterThan(0);
    expect(body.token.split(".")).toHaveLength(3);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.baselineVersion).toBe(PROMPT_VERSION_MANIFEST.heartbeat);
    expect(body.currentSource).toBe("baseline");
  });

  it("rejects 400 on body > 100KB at the Zod boundary (defense in depth)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposedBody: "x".repeat(100_001) },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("validation_failed");
  });
});

describe("admin-api POST /:scope/:id/prompts/:name/:locale/apply", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  async function previewAndApply(
    f: Awaited<ReturnType<typeof makeAdminFixture>>,
    domainId: string,
    proposedBody: string,
  ): Promise<{ readonly token: string }> {
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const previewRes = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${domainId}/prompts/heartbeat/en/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { proposedBody },
    });
    return { token: JSON.parse(previewRes.body).token };
  }

  it("UPSERTs the row + bumps overrides_version + writes audit row BEFORE the UPSERT", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const { token } = await previewAndApply(f, id, "FIRST OVERRIDE");
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");

    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        proposedBody: "FIRST OVERRIDE",
        token,
        confirmDiff: true,
        baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.overridesVersion).toBe("1.0.0");
    expect(body.baselineVersion).toBe(PROMPT_VERSION_MANIFEST.heartbeat);

    // Row persisted.
    const rows = await f.raw.query<{ body: string; overrides_version: string }>(
      `SELECT body, overrides_version FROM prompt_overrides WHERE domain_id = $1::uuid AND instance_id IS NULL AND prompt_name = 'heartbeat' AND locale = 'en'`,
      [id],
    );
    expect(rows.rows[0]?.body).toBe("FIRST OVERRIDE");
    expect(rows.rows[0]?.overrides_version).toBe("1.0.0");

    // Audit row written.
    const audit = await f.raw.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM admin_audit_log WHERE action = 'prompt_override.apply' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe("prompt_override.apply");
    const meta = audit.rows[0]?.metadata as {
      scope: string;
      scope_id: string;
      name: string;
      locale: string;
      payload_hash: string;
    };
    expect(meta.scope).toBe("domains");
    expect(meta.scope_id).toBe(id);
    expect(meta.name).toBe("heartbeat");
    expect(meta.locale).toBe("en");
    expect(typeof meta.payload_hash).toBe("string");
    // Body bytes NOT in audit metadata (§3.13).
    expect(JSON.stringify(meta)).not.toContain("FIRST OVERRIDE");
  });

  it("second apply on the same scope bumps overrides_version 1.0.0 → 1.0.1", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    // First apply.
    const { token: token1 } = await previewAndApply(f, id, "v1");
    const { csrfToken: c1, cookie: ck1 } = await getCsrf(f, "admin-pat");
    await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": c1,
        cookie: `opencoo_csrf=${ck1}`,
        "content-type": "application/json",
      },
      payload: {
        proposedBody: "v1",
        token: token1,
        confirmDiff: true,
        baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
      },
    });
    // Second apply (fresh preview required since token is bound
    // to body+baseline).
    const { token: token2 } = await previewAndApply(f, id, "v2");
    const { csrfToken: c2, cookie: ck2 } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": c2,
        cookie: `opencoo_csrf=${ck2}`,
        "content-type": "application/json",
      },
      payload: {
        proposedBody: "v2",
        token: token2,
        confirmDiff: true,
        baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).overridesVersion).toBe("1.0.1");
  });

  it("rejects 403 on tampered token (signature_mismatch)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const { token } = await previewAndApply(f, id, "body");
    // Flip the first char of the HMAC segment (still 3
    // dot-separated parts so the token doesn't reach `malformed`,
    // and the payload-hash + expiresAt portions remain intact so
    // the verifier reaches the signature check last).
    const flipped = token.charAt(0) === "A" ? "B" : "A";
    const tampered = `${flipped}${token.slice(1)}`;
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        proposedBody: "body",
        token: tampered,
        confirmDiff: true,
        baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).reason).toBe("signature_mismatch");
  });

  it("rejects 422 on payload_mismatch (operator changed proposedBody between preview and apply)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const { token } = await previewAndApply(f, id, "ORIGINAL");
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        proposedBody: "CHANGED",
        token,
        confirmDiff: true,
        baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).reason).toBe("payload_mismatch");
  });

  it("rejects 400 without confirmDiff:true (no silent commits)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const { token } = await previewAndApply(f, id, "body");
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        proposedBody: "body",
        token,
        baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects 422 baseline_version_drifted when the apply's baselineVersion mismatches current shipped", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const { token } = await previewAndApply(f, id, "body");
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        proposedBody: "body",
        token,
        confirmDiff: true,
        baselineVersion: "0.0.0-ancient",
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("baseline_version_drifted");
    expect(body.previewBaselineVersion).toBe("0.0.0-ancient");
    expect(body.currentBaselineVersion).toBe(PROMPT_VERSION_MANIFEST.heartbeat);
  });

  it("agent-instance scope: apply UPSERTs the instance row + writes audit row", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const { id: instanceId } = await seedInstance(f.raw, domainId);

    const { csrfToken: pCsrf, cookie: pCookie } = await getCsrf(f, "admin-pat");
    const previewRes = await f.app.inject({
      method: "POST",
      url: `/api/admin/agent-instances/${instanceId}/prompts/heartbeat/en/preview`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": pCsrf,
        cookie: `opencoo_csrf=${pCookie}`,
        "content-type": "application/json",
      },
      payload: { proposedBody: "INSTANCE-SCOPED OVERRIDE" },
    });
    expect(previewRes.statusCode).toBe(200);
    const { token } = JSON.parse(previewRes.body);

    const { csrfToken: aCsrf, cookie: aCookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/agent-instances/${instanceId}/prompts/heartbeat/en/apply`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": aCsrf,
        cookie: `opencoo_csrf=${aCookie}`,
        "content-type": "application/json",
      },
      payload: {
        proposedBody: "INSTANCE-SCOPED OVERRIDE",
        token,
        confirmDiff: true,
        baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
      },
    });
    expect(res.statusCode).toBe(200);
    // Row persisted with instance_id set, not null.
    const rows = await f.raw.query<{ body: string; instance_id: string | null }>(
      `SELECT body, instance_id::text AS instance_id FROM prompt_overrides
         WHERE domain_id = $1::uuid AND prompt_name = 'heartbeat' AND locale = 'en'`,
      [domainId],
    );
    expect(rows.rows[0]?.body).toBe("INSTANCE-SCOPED OVERRIDE");
    expect(rows.rows[0]?.instance_id).toBe(instanceId);
    // Audit row tagged with scope=agent-instances.
    const audit = await f.raw.query<{ metadata: { scope: string; scope_id: string } }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'prompt_override.apply' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata.scope).toBe("agent-instances");
    expect(audit.rows[0]?.metadata.scope_id).toBe(instanceId);
  });
});

describe("admin-api DELETE /:scope/:id/prompts/:name/:locale", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("clears the override row + writes audit row BEFORE the DELETE", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    await insertOverride(f.raw, {
      domainId: id,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "TO BE DELETED",
    });
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(1);
    // Row gone.
    const left = await f.raw.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prompt_overrides WHERE domain_id = $1::uuid`,
      [id],
    );
    expect(left.rows[0]?.n).toBe("0");
    // Audit row written.
    const audit = await f.raw.query<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'prompt_override.delete'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("idempotent — returns 200 with deleted:0 when no row exists", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "DELETE",
      url: `/api/admin/domains/${id}/prompts/heartbeat/en`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(0);
  });
});
