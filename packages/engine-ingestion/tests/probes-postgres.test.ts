/**
 * PostgresProbe — runs `SELECT 1` against the injected pool and
 * returns `{ ok: true }` on success, `{ ok: false, reason }` on
 * any error. The probe is invoked from `/ready` per request (no
 * caching in v0.1 — reverse proxy gates traffic via the response).
 *
 * Per Correction A from team-lead, the test mocks the pool seam
 * with `vi.fn()` instead of pulling in pglite. The probe only does
 * `SELECT 1`; mocking is the lighter and more honest fixture.
 */
import { describe, it, expect, vi } from "vitest";

import { postgresProbe } from "../src/probes/postgres.js";

interface MinimalQuery {
  query: ReturnType<typeof vi.fn>;
}

function mockOkPool(): MinimalQuery {
  return {
    query: vi.fn(async () => ({ rows: [{ "?column?": 1 }], rowCount: 1 })),
  };
}

function mockFailPool(reason: string): MinimalQuery {
  return {
    query: vi.fn(async () => {
      throw new Error(reason);
    }),
  };
}

describe("postgresProbe", () => {
  it("returns ok:true when SELECT 1 succeeds", async () => {
    const pool = mockOkPool();
    const r = await postgresProbe(pool as unknown as Parameters<typeof postgresProbe>[0]);
    expect(r.ok).toBe(true);
  });

  it("calls pool.query with 'SELECT 1' (or equivalent)", async () => {
    const pool = mockOkPool();
    await postgresProbe(pool as unknown as Parameters<typeof postgresProbe>[0]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const arg = pool.query.mock.calls[0]?.[0];
    expect(typeof arg).toBe("string");
    expect((arg as string).toLowerCase()).toContain("select 1");
  });

  it("returns ok:false + reason on connection error", async () => {
    const pool = mockFailPool("ECONNREFUSED 127.0.0.1:5432");
    const r = await postgresProbe(pool as unknown as Parameters<typeof postgresProbe>[0]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("ECONNREFUSED");
    }
  });

  it("returns ok:false + reason on auth error", async () => {
    const pool = mockFailPool("password authentication failed");
    const r = await postgresProbe(pool as unknown as Parameters<typeof postgresProbe>[0]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.toLowerCase()).toContain("password");
    }
  });

  it("never throws — fail-closed contract for the /ready endpoint", async () => {
    const pool = mockFailPool("any random error");
    // The probe MUST resolve to a structured result rather than
    // bubble exceptions; the /ready handler relies on this to
    // build its JSON response without try/catch around every
    // probe call.
    await expect(postgresProbe(pool as unknown as Parameters<typeof postgresProbe>[0])).resolves.toBeDefined();
  });
});
