/**
 * `opencoo doctor` — webhook intake surface enumeration (PR-L).
 *
 * Closes THREAT-MODEL §7 "Generic webhook intake paths not enumerated
 * in `opencoo doctor`". After this fix, `doctor` queries
 * `sources_bindings` for webhook-mode adapter rows and enumerates every
 * active intake path so operators can gate them via a reverse proxy.
 *
 * Pin matrix:
 *   1. An `asana` binding produces `/webhooks/asana` in the output.
 *   2. A generic `webhook` binding produces `/webhooks/<binding_id>` with
 *      the pathSegment label in the output.
 *   3. Both binding IDs appear in the output so they can be matched
 *      against the operator's reverse-proxy config.
 *   4. The domain slug appears alongside each path.
 *   5. When no webhook bindings exist, the section notes that and
 *      does not crash.
 *   6. --json mode includes a `webhookSurfaces` array with the same info.
 *   7. When the DB is unreachable, the webhook check downgrades to a warn
 *      (already-failing DB check covers the error; no double-report).
 */
import { describe, expect, it, afterEach } from "vitest";

import {
  ExitSentinel,
  __resetProcessExit,
  __setProcessExit,
} from "../src/lib/exit.js";
import { runDoctor } from "../src/commands/doctor.js";

class CapturingStream {
  buffer = "";
  write = (s: string): boolean => {
    this.buffer += s;
    return true;
  };
}

interface ExitCapture {
  code: number | null;
}

function captureExit(): ExitCapture {
  const cap: ExitCapture = { code: null };
  __setProcessExit(((code: number) => {
    cap.code = code;
    throw new ExitSentinel(code);
  }) as never);
  return cap;
}

afterEach(() => {
  __resetProcessExit();
});

const BASE_ENV = {
  DATABASE_URL: "postgres://localhost",
  ENCRYPTION_KEY: "x",
  REDIS_URL: "redis://localhost",
  GITEA_URL: "https://gitea.test",
  ADMIN_TEAM_SLUG: "admins",
  SESSION_HMAC_KEY: "hmac",
  GITEA_BASE_URL: "https://gitea.test",
};

/** A pool factory stub that returns different results depending on
 *  the SQL query text:
 *    - `SELECT 1`               → ok (database check)
 *    - `drizzle_migrations`     → count rows (migration check)
 *    - `sources_bindings`       → the webhook bindings rows (new)
 *
 *  This mirrors the multi-query pattern in cli.test.ts. */
function makePoolFactory(opts: {
  webhookBindings: Array<{
    id: string;
    adapter_slug: string;
    domain_slug: string;
    config: Record<string, unknown>;
    enabled: boolean;
  }>;
}) {
  return () =>
    ({
      query: async (sql: string) => {
        if (sql.includes("drizzle.__drizzle_migrations")) {
          return { rows: [{ count: "6" }] };
        }
        if (sql.includes("sources_bindings")) {
          return { rows: opts.webhookBindings };
        }
        // SELECT 1 AS ok
        return { rows: [{ ok: 1 }] };
      },
      end: async (): Promise<void> => undefined,
    }) as unknown as Parameters<typeof runDoctor>[0] extends infer P
      ? P extends { poolFactory?: infer F }
        ? F extends (...a: unknown[]) => infer R
          ? R
          : never
        : never
      : never;
}

describe("runDoctor — webhook intake surface enumeration", () => {
  it("enumerates /webhooks/asana for an asana binding", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    const ASANA_BINDING_ID = "aaaaaaaa-0001-0001-0001-000000000001";
    try {
      await runDoctor({
        env: BASE_ENV,
        json: false,
        stdout,
        stderr,
        poolFactory: makePoolFactory({
          webhookBindings: [
            {
              id: ASANA_BINDING_ID,
              adapter_slug: "asana",
              domain_slug: "exec",
              config: {},
              enabled: true,
            },
          ],
        }),
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    // exit 0 (warn-only — no PAT; DB is ok)
    expect(exit.code).toBe(0);
    const out = stdout.buffer + stderr.buffer;
    expect(out).toContain("/webhooks/asana");
    expect(out).toContain(ASANA_BINDING_ID);
    expect(out).toContain("exec");
  });

  it("enumerates /webhooks/<binding_id> for a generic webhook binding", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    const WEBHOOK_BINDING_ID = "bbbbbbbb-0002-0002-0002-000000000002";
    try {
      await runDoctor({
        env: BASE_ENV,
        json: false,
        stdout,
        stderr,
        poolFactory: makePoolFactory({
          webhookBindings: [
            {
              id: WEBHOOK_BINDING_ID,
              adapter_slug: "webhook",
              domain_slug: "ops",
              config: { pathSegment: "custom-flow" },
              enabled: true,
            },
          ],
        }),
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(0);
    const out = stdout.buffer + stderr.buffer;
    // For generic webhook: path includes binding_id
    expect(out).toContain(`/webhooks/${WEBHOOK_BINDING_ID}`);
    expect(out).toContain(WEBHOOK_BINDING_ID);
    expect(out).toContain("ops");
    // pathSegment label also appears
    expect(out).toContain("custom-flow");
  });

  it("shows both asana and generic webhook bindings when both exist", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    const ASANA_ID = "cccccccc-0001-0001-0001-000000000001";
    const WEBHOOK_ID = "dddddddd-0002-0002-0002-000000000002";
    try {
      await runDoctor({
        env: BASE_ENV,
        json: false,
        stdout,
        stderr,
        poolFactory: makePoolFactory({
          webhookBindings: [
            {
              id: ASANA_ID,
              adapter_slug: "asana",
              domain_slug: "exec",
              config: {},
              enabled: true,
            },
            {
              id: WEBHOOK_ID,
              adapter_slug: "webhook",
              domain_slug: "ops",
              config: { pathSegment: "custom-flow" },
              enabled: true,
            },
          ],
        }),
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(0);
    const out = stdout.buffer + stderr.buffer;
    expect(out).toContain("/webhooks/asana");
    expect(out).toContain(ASANA_ID);
    expect(out).toContain(`/webhooks/${WEBHOOK_ID}`);
    expect(out).toContain("custom-flow");
  });

  it("notes 'no webhook bindings' when the table returns zero rows", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runDoctor({
        env: BASE_ENV,
        json: false,
        stdout,
        stderr,
        poolFactory: makePoolFactory({ webhookBindings: [] }),
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(0);
    const out = stdout.buffer + stderr.buffer;
    // Must not crash; some "no bindings" indication in output
    expect(out).toMatch(/no webhook binding|no bindings/i);
  });

  it("--json mode includes webhookSurfaces array", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    const ASANA_ID = "eeeeeeee-0001-0001-0001-000000000001";
    try {
      await runDoctor({
        env: BASE_ENV,
        json: true,
        stdout,
        stderr,
        poolFactory: makePoolFactory({
          webhookBindings: [
            {
              id: ASANA_ID,
              adapter_slug: "asana",
              domain_slug: "exec",
              config: {},
              enabled: true,
            },
          ],
        }),
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(0);
    const parsed = JSON.parse(stdout.buffer) as { webhookSurfaces?: unknown[] };
    expect(Array.isArray(parsed.webhookSurfaces)).toBe(true);
    expect(parsed.webhookSurfaces!.length).toBe(1);
    const surface = parsed.webhookSurfaces![0] as {
      path: string;
      bindingId: string;
      domainSlug: string;
      adapterSlug: string;
      enabled: boolean;
    };
    expect(surface.path).toBe("/webhooks/asana");
    expect(surface.bindingId).toBe(ASANA_ID);
    expect(surface.domainSlug).toBe("exec");
    expect(surface.adapterSlug).toBe("asana");
    expect(surface.enabled).toBe(true);
  });

  it("does not crash when the webhook query fails (DB down case)", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runDoctor({
        env: BASE_ENV,
        json: false,
        stdout,
        stderr,
        // Pool that fails on the sources_bindings query
        poolFactory: () =>
          ({
            query: async (sql: string) => {
              if (sql.includes("drizzle.__drizzle_migrations")) {
                return { rows: [{ count: "3" }] };
              }
              if (sql.includes("sources_bindings")) {
                throw new Error("relation sources_bindings does not exist");
              }
              return { rows: [{ ok: 1 }] };
            },
            end: async (): Promise<void> => undefined,
          }) as unknown as Parameters<typeof runDoctor>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    // Should NOT crash — exit 0 (only a warn for the webhook-query error
    // + the gitea_team skip warn; no hard errors if DB is reachable).
    // The webhook query error surfaces as a warn-level check, not error.
    expect(exit.code).toBe(0);
    const out = stdout.buffer + stderr.buffer;
    // The warning about the webhook-check failure should appear
    expect(out).toMatch(/webhook.*warn|warn.*webhook|sources_bindings/i);
  });
});
