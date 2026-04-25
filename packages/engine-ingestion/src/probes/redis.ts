/**
 * RedisProbe — PING against the injected ioredis client. Catches
 * connection / auth / proxy errors and returns a structured result.
 */
import type { ProbeResult } from "./types.js";

/**
 * Structural subset of `ioredis.Redis` we use. A real `ioredis.Redis`
 * already satisfies this shape via TypeScript's structural typing,
 * so the parameter site doesn't need a `RedisProbeTarget | Redis`
 * union — the minimum surface accepts both.
 */
export interface RedisProbeTarget {
  ping(): Promise<string>;
}

export async function redisProbe(
  redis: RedisProbeTarget,
): Promise<ProbeResult> {
  try {
    const reply = await redis.ping();
    if (reply !== "PONG") {
      return {
        ok: false,
        reason: `unexpected response from PING (expected 'PONG', got ${JSON.stringify(reply)})`,
      };
    }
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
