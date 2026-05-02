/**
 * `GET /api/admin/source-bindings` — `pending_events_count` field
 * (phase-a appendix #4 PR-C).
 *
 * The Review Dashboard source-binding sub-view needs to know how many
 * webhook_events rows are waiting with `status='pending'` for each
 * binding so the operator can see what needs attention.
 *
 * Invariants under test:
 *   - A binding with no webhook_events returns `pendingEventsCount: 0`.
 *   - A binding with pending events returns the correct count.
 *   - Only `status='pending'` rows count; 'processed' rows are excluded.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCsrf, makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "admin-pat-pending-count";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set(ADMIN_PAT, {
    username: "carol",
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  slug: string,
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale, class) VALUES ($1, 'Test', 'en', 'knowledge') RETURNING id`,
    [slug],
  );
  return { id: r.rows[0]!.id };
}

async function seedBinding(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  domainId: string,
  adapterSlug: string,
): Promise<{ readonly id: string }> {
  const r = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, review_mode, enabled)
     VALUES ($1::uuid, $2, 'auto'::review_mode, true) RETURNING id::text AS id`,
    [domainId, adapterSlug],
  );
  return { id: r.rows[0]!.id };
}

async function seedWebhookEvent(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  bindingId: string,
  status: string,
): Promise<void> {
  await raw.query(
    `INSERT INTO webhook_events (provider, payload_hash, signature_ok, binding_id, status)
     VALUES ('test', 'hash', true, $1::uuid, $2)`,
    [bindingId, status],
  );
}

async function getBindings(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
  pat: string,
): Promise<{
  rows: Array<{
    id: string;
    pendingEventsCount: number;
  }>;
}> {
  const { csrfToken, cookie } = await getCsrf(fixture, pat);
  const res = await fixture.app.inject({
    method: "GET",
    url: "/api/admin/source-bindings",
    headers: {
      authorization: `Bearer ${pat}`,
      "x-csrf-token": csrfToken,
      cookie: `opencoo_csrf=${cookie}`,
    },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as {
    rows: Array<{ id: string; pendingEventsCount: number }>;
  };
}

describe("source-bindings GET — pendingEventsCount field (PR-C)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns pendingEventsCount: 0 for a binding with no webhook_events", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-pending-none");
    const bnd = await seedBinding(f.raw, dom.id, "drive");

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found).toBeDefined();
    expect(found?.pendingEventsCount).toBe(0);
  });

  it("returns the correct count of pending webhook_events", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-pending-some");
    const bnd = await seedBinding(f.raw, dom.id, "drive");

    await seedWebhookEvent(f.raw, bnd.id, "pending");
    await seedWebhookEvent(f.raw, bnd.id, "pending");
    await seedWebhookEvent(f.raw, bnd.id, "pending");

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found).toBeDefined();
    expect(found?.pendingEventsCount).toBe(3);
  });

  it("excludes processed events from pendingEventsCount", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-pending-mixed");
    const bnd = await seedBinding(f.raw, dom.id, "drive");

    await seedWebhookEvent(f.raw, bnd.id, "pending");
    await seedWebhookEvent(f.raw, bnd.id, "processed");
    await seedWebhookEvent(f.raw, bnd.id, "processed");

    const body = await getBindings(f, ADMIN_PAT);
    const found = body.rows.find((b) => b.id === bnd.id);
    expect(found).toBeDefined();
    // Only the 1 pending row counts.
    expect(found?.pendingEventsCount).toBe(1);
  });

  it("does not count pending events from OTHER bindings", async () => {
    const f = await makeAdminFixture({ adminTeamSlug: "opencoo-admins" });
    cleanup = f.close;
    await setupAdmin(f);
    const dom = await seedDomain(f.raw, "wiki-pending-isolation");
    const bnd1 = await seedBinding(f.raw, dom.id, "drive");
    const bnd2 = await seedBinding(f.raw, dom.id, "fireflies");

    // bnd2 has 5 pending events — must not bleed into bnd1's count.
    await seedWebhookEvent(f.raw, bnd2.id, "pending");
    await seedWebhookEvent(f.raw, bnd2.id, "pending");
    await seedWebhookEvent(f.raw, bnd2.id, "pending");
    await seedWebhookEvent(f.raw, bnd2.id, "pending");
    await seedWebhookEvent(f.raw, bnd2.id, "pending");

    const body = await getBindings(f, ADMIN_PAT);
    const found1 = body.rows.find((b) => b.id === bnd1.id);
    expect(found1?.pendingEventsCount).toBe(0);

    const found2 = body.rows.find((b) => b.id === bnd2.id);
    expect(found2?.pendingEventsCount).toBe(5);
  });
});
