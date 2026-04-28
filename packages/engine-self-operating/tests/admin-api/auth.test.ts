/**
 * Admin-API auth tests (PR 28 / plan #128, THREAT-MODEL §3.13).
 *
 * Layered assertions:
 *   - Missing/malformed Authorization → 401.
 *   - Bearer + valid Gitea PAT but team mismatch → 403.
 *   - Bearer + valid Gitea PAT + admin team → 200 + session
 *     cookie + user upserted into `users` with gitea_teams
 *     populated.
 *   - In-mem cache: a second request with the SAME PAT does
 *     NOT call whoami again within the 60s TTL.
 *   - Whoami throws → 401 (don't leak provider error).
 *   - The session cookie has SameSite=Strict + HttpOnly +
 *     Secure attributes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

describe("admin-api auth — verifyAdmin preHandler", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("rejects missing Authorization header with 401", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.error).toBe("unauthorized");
    expect(body.reason).toBe("missing_authorization_header");
  });

  it("rejects malformed Authorization (not Bearer) with 401 and the malformed reason", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Basic abcdef" },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.error).toBe("unauthorized");
    expect(body.reason).toBe("malformed_authorization_header");
  });

  it("rejects when the user is not in ADMIN_TEAM_SLUG (403)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("operator-pat", {
      username: "alice",
      teams: ["random-team"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer operator-pat" },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.error).toBe("forbidden");
    expect(body.reason).toBe("missing_admin_team_membership");
  });

  it("accepts admin PAT with 200 + sets session cookie + upserts user with gitea_teams", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("admin-pat", {
      username: "alice",
      teams: ["opencoo-admins", "engineers"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { csrfToken: string; username: string };
    expect(body.username).toBe("alice");
    expect(body.csrfToken.length).toBeGreaterThan(40);

    // Session cookie set. SameSite=Strict + HttpOnly are
    // unconditional; Secure is gated on NODE_ENV=production
    // (asserted in its own describe block below) so that
    // http://localhost dev doesn't get its cookies rejected.
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie)
      ? setCookie.join(", ")
      : setCookie ?? "";
    expect(cookieStr).toMatch(/opencoo_session=/);
    expect(cookieStr).toContain("SameSite=Strict");
    expect(cookieStr).toContain("HttpOnly");

    // User row upserted with gitea_teams.
    const usersResult = await f.raw.query<{
      gitea_username: string;
      gitea_teams: string[];
      gitea_teams_refreshed_at: Date | string | null;
    }>(
      `SELECT gitea_username, gitea_teams, gitea_teams_refreshed_at FROM users WHERE gitea_username = 'alice'`,
    );
    expect(usersResult.rows[0]?.gitea_username).toBe("alice");
    expect(usersResult.rows[0]?.gitea_teams).toEqual([
      "opencoo-admins",
      "engineers",
    ]);
    expect(usersResult.rows[0]?.gitea_teams_refreshed_at).not.toBeNull();
  });

  it("uses the in-mem cache: a 2nd request with the same PAT does NOT call whoami again (within 60s TTL)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("admin-pat", {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(f.gitea.calls).toHaveLength(1);
    await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer admin-pat" },
    });
    // Cache hit — no extra Gitea round-trip.
    expect(f.gitea.calls).toHaveLength(1);
  });

  it("returns 401 when whoami throws (provider error not leaked)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set("garbage-pat", new Error("Gitea down"));
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer garbage-pat" },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    expect(body.error).toBe("unauthorized");
    expect(body.reason).toBe("whoami_failed");
    // Provider error message must NOT appear in the response.
    expect(res.body).not.toContain("Gitea down");
  });

  it("does not auth-gate /health or /ready (those routes don't exist on the admin-api scope)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    // The fixture's app does NOT register /health — we just
    // assert no auth applies to non-/api/admin paths if we
    // tried. The static-ui fall-through is not present in the
    // test harness, so the assertion focuses on the admin
    // scope only — every admin route requires auth.
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/source-bindings",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("admin-api auth — opencoo_session cookie attributes (Path + conditional Secure)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
    vi.unstubAllEnvs();
  });

  async function fetchSessionCookieLine(): Promise<string> {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("admin-pat", {
      username: "alice",
      teams: ["opencoo-admins"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/_csrf",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    const sessionLine = lines.find((l) => l.includes("opencoo_session="));
    expect(sessionLine).toBeDefined();
    return sessionLine!;
  }

  it("opencoo_session cookie is Path=/ (not Path=/api/admin) — matches CSRF cookie scope", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const sessionLine = await fetchSessionCookieLine();
    expect(sessionLine).toContain("Path=/");
    expect(sessionLine).not.toContain("Path=/api/admin");
  });

  it("opencoo_session cookie omits Secure ONLY when NODE_ENV === 'development' (http://localhost dev)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const sessionLine = await fetchSessionCookieLine();
    expect(sessionLine).not.toMatch(/(?:^|;\s)Secure(?:;|$)/);
  });

  it("opencoo_session cookie sets Secure when NODE_ENV === 'production'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const sessionLine = await fetchSessionCookieLine();
    expect(sessionLine).toMatch(/(?:^|;\s)Secure(?:;|$)/);
  });

  it("opencoo_session cookie sets Secure when NODE_ENV is 'staging' (secure-by-default for non-dev deploys)", async () => {
    vi.stubEnv("NODE_ENV", "staging");
    const sessionLine = await fetchSessionCookieLine();
    expect(sessionLine).toMatch(/(?:^|;\s)Secure(?:;|$)/);
  });
});
