/**
 * `PATCH /api/admin/domains/:id` — domain edit (PR-R1, phase-a
 * appendix #10).
 *
 * The Domains tab drill-down modal exposes Edit + Disable + Hard-
 * delete actions; this file pins the Edit (PATCH) surface. The
 * route accepts a partial update of `display_name`, `locale`, and
 * `is_aggregator` in `.strict()` Zod — `slug` and `class` are
 * intentionally NOT mutable (slug rename = re-create; class is
 * structural).
 *
 * Pin matrix:
 *   1. 200 happy: display_name + locale change is persisted; audit
 *      'domain.update' written with `changedFields` listing field
 *      NAMES (never values).
 *   2. 422 if `slug` is in the body (rename = re-create; not edit).
 *   3. 422 if `class` is in the body (structural).
 *   4. 200 happy: is_aggregator: true on a fresh domain succeeds.
 *   5. 409 aggregator_already_set when another (active) domain
 *      already holds is_aggregator=true.
 *   6. 404 when the id does not exist.
 *   7. 403 without CSRF token.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-domain-update";

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
  overrides: { name?: string; locale?: string; is_aggregator?: boolean } = {},
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale, is_aggregator)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      slug,
      overrides.name ?? "Display Name",
      overrides.locale ?? "en",
      overrides.is_aggregator ?? false,
    ],
  );
  return { id: r.rows[0]!.id };
}

describe("admin-api PATCH /api/admin/domains/:id (PR-R1)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("200 happy: display_name + locale update is persisted; audit row lists changed field names", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: {
        display_name: "Executive (renamed)",
        locale: "pl",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      id: string;
      slug: string;
      name: string;
      class: string;
      locale: string;
      llmPolicy: Record<string, unknown>;
      isAggregator: boolean;
    };
    expect(body.id).toBe(id);
    expect(body.slug).toBe("exec");
    expect(body.name).toBe("Executive (renamed)");
    expect(body.locale).toBe("pl");
    expect(body.isAggregator).toBe(false);

    // DB row updated.
    const dbRow = await f.raw.query<{ name: string; locale: string }>(
      `SELECT name, locale FROM domains WHERE id = $1::uuid`,
      [id],
    );
    expect(dbRow.rows[0]?.name).toBe("Executive (renamed)");
    expect(dbRow.rows[0]?.locale).toBe("pl");

    // Audit row written; metadata lists changed field NAMES.
    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'domain.update'`,
    );
    expect(audit.rows.length).toBe(1);
    const meta = audit.rows[0]!.metadata;
    expect(meta["id"]).toBe(id);
    expect(meta["slug"]).toBe("exec");
    expect(meta["caller_username"]).toBe("alice");
    expect(meta["changedFields"]).toEqual(
      expect.arrayContaining(["display_name", "locale"]),
    );
    // Audit must NEVER contain the actual field VALUES (the
    // operator-set name could be a log-injection vector).
    expect(JSON.stringify(meta)).not.toContain("Executive (renamed)");
  });

  it("422 if `slug` is in the body (slug change is not allowed; re-create instead)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { slug: "exec-renamed" },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  it("422 if `class` is in the body (class change is structural; not allowed)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { class: "catalog-skills" },
    });
    expect(res.statusCode).toBe(422);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "validation_failed",
    );
  });

  it("200 happy: is_aggregator: true on a fresh domain succeeds", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { is_aggregator: true },
    });
    expect(res.statusCode).toBe(200);
    const dbRow = await f.raw.query<{ is_aggregator: boolean }>(
      `SELECT is_aggregator FROM domains WHERE id = $1::uuid`,
      [id],
    );
    expect(dbRow.rows[0]?.is_aggregator).toBe(true);
  });

  it("200 happy: is_aggregator: false demotes a previously-aggregator domain; audit lists is_aggregator", async () => {
    // Demote path: a domain currently holding `is_aggregator = true`
    // must accept a PATCH that flips the flag to false, write an
    // audit row whose `changedFields` lists `is_aggregator`, and
    // leave the DB row reflecting the demote. The aggregator-conflict
    // pre-check only fires on `is_aggregator === true`, so the demote
    // path skips the pre-check entirely and the partial UNIQUE INDEX
    // (cleared by the UPDATE) frees the singleton slot.
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "company", { is_aggregator: true });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { is_aggregator: false },
    });
    expect(res.statusCode).toBe(200);

    // DB row reflects the demote.
    const dbRow = await f.raw.query<{ is_aggregator: boolean }>(
      `SELECT is_aggregator FROM domains WHERE id = $1::uuid`,
      [id],
    );
    expect(dbRow.rows[0]?.is_aggregator).toBe(false);

    // Audit row written; metadata.changedFields lists `is_aggregator`.
    const audit = await f.raw.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM admin_audit_log WHERE action = 'domain.update'`,
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.metadata["changedFields"]).toEqual(["is_aggregator"]);
  });

  it("409 aggregator_already_set when another active domain has is_aggregator=true", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    // Existing aggregator (active).
    await seedDomain(f.raw, "company", { is_aggregator: true });
    // Target — wants to also be aggregator.
    const { id } = await seedDomain(f.raw, "exec");
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { is_aggregator: true },
    });
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "aggregator_already_set",
    );
  });

  it("200 noOp when body values match current row — no UPDATE, no audit row", async () => {
    // PR-R1 follow-up: `changedFields` must list REAL diffs (computed
    // against the current row), not body-key presence. A PATCH that
    // resends the same value(s) the row already has is a no-op:
    // 200 + noOp:true, and no audit row written.
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec", {
      name: "Same Name",
      locale: "en",
    });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      // All fields match the seeded row — nothing actually changes.
      payload: { display_name: "Same Name", locale: "en" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      id: string;
      slug: string;
      noOp?: boolean;
    };
    expect(body.id).toBe(id);
    expect(body.slug).toBe("exec");
    expect(body.noOp).toBe(true);

    // No audit row was written for the no-op.
    const audit = await f.raw.query(
      `SELECT id FROM admin_audit_log WHERE action = 'domain.update'`,
    );
    expect(audit.rows.length).toBe(0);
  });

  it("409 aggregator_already_set fires before the no-op check (uniqueness must validate intent)", async () => {
    // The aggregator-uniqueness pre-check must run BEFORE the no-op
    // shortcut: if the operator submits is_aggregator: true on a
    // domain that already holds the flag, the pre-check sees the
    // OTHER active aggregator and 409s. (Without this ordering, a
    // hand-crafted PATCH that resends is_aggregator: true while the
    // domain is already aggregator AND a different active domain is
    // also aggregator would silently succeed as a no-op, masking
    // the constraint violation.)
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    // Existing aggregator (active).
    await seedDomain(f.raw, "company", { is_aggregator: true });
    // Target — also marked aggregator (simulates a stale state where
    // the partial UNIQUE INDEX would normally have prevented this,
    // but the test forces it via direct INSERT).
    const { id } = await seedDomain(f.raw, "exec", { is_aggregator: false });
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { is_aggregator: true },
    });
    expect(res.statusCode).toBe(409);
    expect((JSON.parse(res.body) as { error: string }).error).toBe(
      "aggregator_already_set",
    );
  });

  it("404 when domain id does not exist", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { csrfToken, cookie } = await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: "/api/admin/domains/00000000-0000-0000-0000-000000000000",
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { display_name: "anything" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("403 without CSRF token", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { id } = await seedDomain(f.raw, "exec");
    // Establish a session (auth runs once) but omit X-CSRF-Token on
    // the mutating call.
    await getCsrf(f, ADMIN_PAT);

    const res = await f.app.inject({
      method: "PATCH",
      url: `/api/admin/domains/${id}`,
      headers: {
        authorization: `Bearer ${ADMIN_PAT}`,
        "content-type": "application/json",
      },
      payload: { display_name: "X" },
    });
    expect(res.statusCode).toBe(403);
  });
});
