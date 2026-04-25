/**
 * Fastify HTTP surface — `/health` (no probes, always 200) and
 * `/ready` (runs every probe per request; 200 only when all
 * pass, 503 otherwise).
 *
 * v0.1 cold-starts probes per request — no caching. Reverse proxy
 * gates traffic via the response. Cache the result in v0.2 if
 * /ready latency becomes a problem under load.
 *
 * Probes are passed in via `ProbeMap`; each entry is a
 * `() => Promise<ProbeResult>`. The handler runs them concurrently
 * (latency bounded by the SLOWEST probe, not their sum) and
 * defensively wraps each call in try/catch — a buggy probe that
 * throws is surfaced as a failed check (`{ok: false, reason}`)
 * rather than crashing the route into a 500. Fail-closed at the
 * HTTP boundary (copilot #15 Fix 5).
 */
import Fastify, { type FastifyInstance } from "fastify";

import type { ProbeResult } from "./probes/types.js";

export type ProbeFn = () => Promise<ProbeResult>;
export type ProbeMap = Readonly<Record<string, ProbeFn>>;

export interface BuildServerOptions {
  readonly probes: ProbeMap;
  readonly logger?: boolean;
}

interface ReadyResponse {
  readonly status: "ready" | "not_ready";
  readonly probes: Record<string, ProbeResult>;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  // Disable Fastify's pino-style logger by default — the engine
  // harness has its own @opencoo/shared logger and double-logging
  // is noise. Tests can opt in via `logger: true`.
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/ready", async (_req, reply) => {
    const results = await Promise.all(
      Object.entries(options.probes).map(async ([name, fn]) => {
        try {
          return [name, await fn()] as const;
        } catch (err) {
          // Probes are CONTRACTUALLY supposed to always resolve;
          // catching the rejection here is belt-and-suspenders so
          // a buggy probe surfaces as a failed check rather than
          // a 500. The reason string preserves the original
          // error's message for operator triage.
          const reason = err instanceof Error ? err.message : String(err);
          return [name, { ok: false, reason }] as const;
        }
      }),
    );
    const allOk = results.every(([, r]) => r.ok);
    const body: ReadyResponse = {
      status: allOk ? "ready" : "not_ready",
      probes: Object.fromEntries(results),
    };
    if (!allOk) {
      reply.code(503);
    }
    return body;
  });

  return app;
}
