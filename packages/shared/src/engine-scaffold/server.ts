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
 * HTTP boundary.
 */
import Fastify, { type FastifyInstance } from "fastify";

import type { ProbeResult } from "./probes/types.js";

export type ProbeFn = () => Promise<ProbeResult>;
export type ProbeMap = Readonly<Record<string, ProbeFn>>;

export interface BuildServerOptions {
  readonly probes: ProbeMap;
  readonly logger?: boolean;
  /** Override Fastify's default 1MB body limit. Round-2 fix
   *  (Copilot #56): when engine-ingestion mounts the webhook
   *  receiver onto its primary Fastify app, the body limit must
   *  be raised to `WEBHOOK_BODY_LIMIT_BYTES` (5MB) so the
   *  receiver's own 5MB cap is the binding constraint, not
   *  Fastify's default. */
  readonly bodyLimit?: number;
}

interface ReadyResponse {
  readonly status: "ready" | "not_ready";
  readonly probes: Record<string, ProbeResult>;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  // Disable Fastify's pino-style logger by default — engine
  // harnesses have their own @opencoo/shared logger and
  // double-logging is noise. Tests can opt in via `logger: true`.
  const app = Fastify({
    logger: options.logger ?? false,
    ...(options.bodyLimit !== undefined ? { bodyLimit: options.bodyLimit } : {}),
  });

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
