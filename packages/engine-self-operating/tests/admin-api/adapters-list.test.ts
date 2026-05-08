/**
 * `GET /api/admin/adapters` — adapter descriptor list (phase-a
 * appendix #2).
 *
 * The Management UI's "+ New binding" modal calls this to
 * populate the adapter picker. Returning the same descriptors
 * the route validator uses keeps server + UI in lockstep —
 * adding a new adapter is a single registry edit, no UI patch.
 *
 * Response shape:
 *   { adapters: [
 *       { slug, mode: 'polling'|'webhook', credentialSchema },
 *       ...
 *     ] }
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set("admin-pat", {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

describe("admin-api adapters route (phase-a appendix #2)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns the five wired SourceAdapter descriptors", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      adapters: Array<{
        slug: string;
        mode: "polling" | "webhook";
        credentialSchema: { type: string; properties: Record<string, unknown> };
      }>;
    };
    const slugs = body.adapters.map((a) => a.slug).sort();
    expect(slugs).toEqual(["asana", "drive", "fireflies", "n8n", "webhook"]);
  });

  it("descriptors carry the `mode` discriminator + JSON-Schema credential shape", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      adapters: Array<{
        slug: string;
        mode: "polling" | "webhook";
        credentialSchema: { type: string };
      }>;
    };
    for (const a of body.adapters) {
      expect(["polling", "webhook"]).toContain(a.mode);
      expect(a.credentialSchema.type).toBe("object");
    }
  });

  it("descriptors carry a `bindingConfigSchema` JSON-Schema for operator config (PR-Q9)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      adapters: Array<{
        slug: string;
        bindingConfigSchema: {
          type: string;
          properties: Record<string, { type?: string; secret?: boolean }>;
          required: readonly string[];
        };
      }>;
    };
    for (const a of body.adapters) {
      expect(a.bindingConfigSchema).toBeDefined();
      expect(a.bindingConfigSchema.type).toBe("object");
      expect(a.bindingConfigSchema.properties).toBeDefined();
      expect(Array.isArray(a.bindingConfigSchema.required)).toBe(true);
      // None of the binding-config fields are credentials —
      // `secret: true` is an encrypted-credential marker that
      // belongs only on the `credentialSchema` shape.
      for (const [, prop] of Object.entries(a.bindingConfigSchema.properties)) {
        expect(prop.secret).not.toBe(true);
      }
    }
  });

  it("asana bindingConfigSchema requires projectGid (PR-Q9 — closes the empty-config-jsonb regression)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      adapters: Array<{
        slug: string;
        bindingConfigSchema: {
          properties: Record<
            string,
            { type?: string; default?: unknown; description?: string }
          >;
          required: readonly string[];
        };
      }>;
    };
    const asana = body.adapters.find((a) => a.slug === "asana");
    expect(asana).toBeDefined();
    expect(asana!.bindingConfigSchema.required).toContain("projectGid");
    expect(asana!.bindingConfigSchema.properties["projectGid"]).toBeDefined();
    // `reviewMode` carries a `default` so the UI can prefill it.
    expect(asana!.bindingConfigSchema.properties["reviewMode"]).toBeDefined();
    expect(asana!.bindingConfigSchema.properties["reviewMode"]?.default).toBe(
      "auto",
    );
  });

  it("preserves the secret-marker for masked fields (asana auth.personal_access_token)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      adapters: Array<{
        slug: string;
        mode: "polling" | "webhook";
        credentialSchema: {
          properties: Record<
            string,
            {
              properties?: Record<string, { secret?: boolean }>;
              secret?: boolean;
            }
          >;
        };
      }>;
    };
    const asana = body.adapters.find((a) => a.slug === "asana");
    expect(asana).toBeDefined();
    const auth = asana!.credentialSchema.properties.auth;
    expect(auth?.properties?.["personal_access_token"]?.secret).toBe(true);
  });

  it("requires verifyAdmin (401 without Authorization header)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires admin team membership (403 for outsider)", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    f.gitea.responses.set("outsider-pat", {
      username: "eve",
      teams: ["other-team"],
    });
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
      headers: { authorization: "Bearer outsider-pat" },
    });
    expect(res.statusCode).toBe(403);
  });

  // CSRF doesn't apply (GET); pin via getCsrf round-trip just to
  // confirm the endpoint is registered alongside the other admin
  // routes in the guarded plugin.
  it("works after the CSRF round-trip the SPA performs at boot", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    await getCsrf(f, "admin-pat");
    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/adapters",
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
  });
});
