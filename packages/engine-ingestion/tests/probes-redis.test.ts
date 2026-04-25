/**
 * RedisProbe — runs `PING` against the injected ioredis client and
 * returns `{ ok: true }` on success, `{ ok: false, reason }` on
 * any error. Uses `ioredis-mock` for a hermetic test (BullMQ-
 * compatible, no external server required).
 */
import { describe, it, expect } from "vitest";
import IORedisMock from "ioredis-mock";

import { redisProbe } from "../src/probes/redis.js";

describe("redisProbe", () => {
  it("returns ok:true when PING succeeds", async () => {
    const redis = new IORedisMock();
    const r = await redisProbe(redis as unknown as Parameters<typeof redisProbe>[0]);
    expect(r.ok).toBe(true);
    redis.disconnect();
  });

  it("returns ok:false + reason when ping throws", async () => {
    // Synthesize a failing client. ioredis-mock doesn't easily
    // simulate connection failure; an injected stub does.
    const stub = {
      ping: async () => {
        throw new Error("Connection is closed.");
      },
    };
    const r = await redisProbe(stub as unknown as Parameters<typeof redisProbe>[0]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.toLowerCase()).toContain("closed");
    }
  });

  it("returns ok:false when PING resolves to a non-PONG string", async () => {
    // Defensive: a misconfigured proxy could swallow PING and
    // return something else. Probe must catch this.
    const stub = {
      ping: async () => "WAT",
    };
    const r = await redisProbe(stub as unknown as Parameters<typeof redisProbe>[0]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/unexpected.*response|wat|pong/i);
    }
  });

  it("never throws — fail-closed contract for the /ready endpoint", async () => {
    const stub = {
      ping: async () => {
        throw new Error("boom");
      },
    };
    await expect(redisProbe(stub as unknown as Parameters<typeof redisProbe>[0])).resolves.toBeDefined();
  });
});
