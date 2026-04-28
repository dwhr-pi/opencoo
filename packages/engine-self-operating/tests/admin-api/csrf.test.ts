/**
 * CSRF double-submit cookie tests (PR 28 / plan #128).
 *
 * The state-changing routes register `requireCsrf` as a
 * preHandler. We assert:
 *   - missing X-CSRF-Token header → 403 csrf_invalid
 *   - missing cookie → 403 csrf_invalid
 *   - header present but cookie missing → 403
 *   - mismatched header/cookie → 403 csrf_mismatch
 *   - matching header + cookie → request reaches the handler
 *
 * The state-changing route under test is the
 * `automation-candidates/:id/decision` POST so we assert the
 * end-to-end path (auth → CSRF → handler).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { extractCsrfCookie } from "../../src/admin-api/csrf.js";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

async function seedCandidate(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
): Promise<{ readonly candidateId: string }> {
  await raw.exec(`
    INSERT INTO domains (slug, name) VALUES ('test-domain', 'Test');
  `);
  const runResult = await raw.query<{ id: string }>(
    `INSERT INTO agent_runs (definition_slug, trigger, status) VALUES ('surfacer', 'scheduled', 'success') RETURNING id`,
  );
  const runId = runResult.rows[0]!.id;
  const candidateResult = await raw.query<{ id: string }>(
    `INSERT INTO automation_candidates (surfacer_run_id, source_page_refs, proposal) VALUES ($1::uuid, '[]'::jsonb, '{}'::jsonb) RETURNING id`,
    [runId],
  );
  return { candidateId: candidateResult.rows[0]!.id };
}

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set("admin-pat", {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

describe("admin-api csrf — extractCsrfCookie helper", () => {
  it("extracts opencoo_csrf cookie value", () => {
    expect(extractCsrfCookie("opencoo_csrf=abc")).toBe("abc");
    expect(extractCsrfCookie("foo=bar; opencoo_csrf=xyz; baz=qux")).toBe("xyz");
    expect(extractCsrfCookie('opencoo_csrf="quoted"')).toBe("quoted");
  });

  it("returns undefined when cookie absent", () => {
    expect(extractCsrfCookie(undefined)).toBeUndefined();
    expect(extractCsrfCookie("foo=bar")).toBeUndefined();
  });
});

describe("admin-api csrf — state-changing route gate", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("rejects POST without X-CSRF-Token header (403)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw);
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: { authorization: "Bearer admin-pat" },
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.error).toBe("csrf_invalid");
    expect(body.reason).toBe("missing_csrf_token");
  });

  it("rejects POST with header but no cookie (403)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw);
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": "fabricated-token",
      },
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects POST with mismatched header vs cookie (csrf_mismatch)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw);
    const { cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": "fabricated-different",
        cookie: `opencoo_csrf=${cookie}`,
      },
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.reason).toBe("csrf_mismatch");
  });

  it("accepts POST when X-CSRF-Token equals the opencoo_csrf cookie (state change goes through)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const { candidateId } = await seedCandidate(f.raw);
    const { csrfToken, cookie } = await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "POST",
      url: `/api/admin/automation-candidates/${candidateId}/decision`,
      headers: {
        authorization: "Bearer admin-pat",
        "x-csrf-token": csrfToken,
        cookie: `opencoo_csrf=${cookie}`,
        "content-type": "application/json",
      },
      payload: { decision: "approve" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("approved");
  });

  it("CSRF cookie carries SameSite=Strict and is NOT HttpOnly (SPA must read it)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie)
      ? setCookie.join(", ")
      : setCookie ?? "";
    expect(cookieStr).toMatch(/opencoo_csrf=/);
    expect(cookieStr).toContain("SameSite=Strict");
    // Per-cookie assertion: the CSRF cookie line MUST NOT include
    // HttpOnly (the SPA needs to read it client-side to mirror as
    // header); the session cookie line MUST include HttpOnly.
    // Asserting on the joined `cookieStr` is ambiguous because
    // both cookies are sent on this response — distinguish them.
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    const csrfLine = lines.find((l) => l.includes("opencoo_csrf="));
    expect(csrfLine).toBeDefined();
    expect(csrfLine?.includes("HttpOnly")).toBe(false);
    const sessionLine = lines.find((l) => l.includes("opencoo_session="));
    if (sessionLine !== undefined) {
      // Session cookie may not be set on _csrf endpoint depending
      // on first-call semantics; only assert when present.
      expect(sessionLine.includes("HttpOnly")).toBe(true);
    }
  });
});

describe("admin-api csrf — opencoo_csrf cookie attributes (Path + conditional Secure)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
    vi.unstubAllEnvs();
  });

  async function fetchCsrfCookieLine(): Promise<string> {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    const csrfLine = lines.find((l) => l.includes("opencoo_csrf="));
    expect(csrfLine).toBeDefined();
    return csrfLine!;
  }

  it("opencoo_csrf cookie is Path=/ (not Path=/api/admin) so the SPA at / can read it", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const csrfLine = await fetchCsrfCookieLine();
    expect(csrfLine).toContain("Path=/");
    expect(csrfLine).not.toContain("Path=/api/admin");
  });

  it("opencoo_csrf cookie omits Secure ONLY when NODE_ENV === 'development' (http://localhost dev)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const csrfLine = await fetchCsrfCookieLine();
    expect(csrfLine).not.toMatch(/(?:^|;\s)Secure(?:;|$)/);
  });

  it("opencoo_csrf cookie sets Secure when NODE_ENV === 'production'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const csrfLine = await fetchCsrfCookieLine();
    expect(csrfLine).toMatch(/(?:^|;\s)Secure(?:;|$)/);
  });

  it("opencoo_csrf cookie sets Secure when NODE_ENV is 'staging' (secure-by-default for non-dev deploys)", async () => {
    // Anything that isn't an explicit `development` opts INTO Secure
    // so a forgotten/typo'd NODE_ENV on a non-prod-but-internet-facing
    // deploy doesn't silently lose the flag (Copilot triage on PR #39).
    vi.stubEnv("NODE_ENV", "staging");
    const csrfLine = await fetchCsrfCookieLine();
    expect(csrfLine).toMatch(/(?:^|;\s)Secure(?:;|$)/);
  });
});
