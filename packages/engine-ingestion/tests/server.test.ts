/**
 * Fastify HTTP surface — two endpoints:
 *
 *   GET /health  — process-level liveness, no probes. Always 200.
 *   GET /ready   — readiness; runs Postgres + Redis probes per
 *                   request and returns a structured JSON map of
 *                   probe results. 200 only when every probe is ok;
 *                   503 otherwise. Reverse proxy gates traffic.
 *
 * v0.1 cold-starts probes per request — no caching. The /ready
 * latency is bounded by the probe timeouts, not the request rate.
 */
import { describe, it, expect } from "vitest";

import { buildServer, type ProbeMap } from "../src/server.js";

const okProbes: ProbeMap = {
  postgres: async () => ({ ok: true }),
  redis: async () => ({ ok: true }),
};

const failingPg: ProbeMap = {
  postgres: async () => ({ ok: false, reason: "ECONNREFUSED" }),
  redis: async () => ({ ok: true }),
};

const failingRedis: ProbeMap = {
  postgres: async () => ({ ok: true }),
  redis: async () => ({ ok: false, reason: "auth failed" }),
};

describe("buildServer — /health", () => {
  it("returns 200 + { status: 'ok' } regardless of probes", async () => {
    const app = buildServer({ probes: failingPg });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("buildServer — /ready", () => {
  it("returns 200 + status:'ready' + per-probe ok:true when every probe passes", async () => {
    const app = buildServer({ probes: okProbes });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      probes: Record<string, { ok: boolean }>;
    };
    expect(body.status).toBe("ready");
    expect(body.probes.postgres?.ok).toBe(true);
    expect(body.probes.redis?.ok).toBe(true);
    await app.close();
  });

  it("returns 503 + status:'not_ready' when postgres probe fails", async () => {
    const app = buildServer({ probes: failingPg });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      status: string;
      probes: Record<string, { ok: boolean; reason?: string }>;
    };
    expect(body.status).toBe("not_ready");
    expect(body.probes.postgres?.ok).toBe(false);
    expect(body.probes.postgres?.reason).toBe("ECONNREFUSED");
    expect(body.probes.redis?.ok).toBe(true);
    await app.close();
  });

  it("returns 503 when redis probe fails", async () => {
    const app = buildServer({ probes: failingRedis });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      status: string;
      probes: Record<string, { ok: boolean; reason?: string }>;
    };
    expect(body.status).toBe("not_ready");
    expect(body.probes.redis?.ok).toBe(false);
    await app.close();
  });

  it("runs probes per request — no caching across calls", async () => {
    let counter = 0;
    const app = buildServer({
      probes: {
        postgres: async () => {
          counter++;
          return { ok: true };
        },
        redis: async () => ({ ok: true }),
      },
    });
    await app.inject({ method: "GET", url: "/ready" });
    await app.inject({ method: "GET", url: "/ready" });
    expect(counter).toBe(2);
    await app.close();
  });
});

describe("buildServer — unknown routes", () => {
  it("404s on unknown paths (default Fastify behaviour)", async () => {
    const app = buildServer({ probes: okProbes });
    const res = await app.inject({ method: "GET", url: "/unknown" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// (copilot #15 Fix 5) — probe functions are SUPPOSED to always
// resolve to {ok, reason?}, but a buggy probe that throws should
// not crash the /ready route into a 500. The contract is "503 +
// structured body" at the HTTP boundary; the rejection is
// surfaced as a failed probe with the error message as `reason`.
describe("buildServer — /ready handles probe rejection defensively", () => {
  it("returns 503 with structured body when a probe rejects unexpectedly", async () => {
    const app = buildServer({
      probes: {
        postgres: async () => ({ ok: true }),
        redis: async () => {
          throw new Error("ioredis client died unexpectedly");
        },
      },
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      status: string;
      probes: Record<string, { ok: boolean; reason?: string }>;
    };
    expect(body.status).toBe("not_ready");
    expect(body.probes.postgres?.ok).toBe(true);
    expect(body.probes.redis?.ok).toBe(false);
    expect(body.probes.redis?.reason).toContain("ioredis client died");
    await app.close();
  });

  it("returns 503 even when EVERY probe rejects", async () => {
    const app = buildServer({
      probes: {
        postgres: async () => {
          throw new Error("pg pool failed");
        },
        redis: async () => {
          throw new Error("redis dead");
        },
      },
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      status: string;
      probes: Record<string, { ok: boolean; reason?: string }>;
    };
    expect(body.status).toBe("not_ready");
    expect(body.probes.postgres?.ok).toBe(false);
    expect(body.probes.redis?.ok).toBe(false);
    await app.close();
  });
});
