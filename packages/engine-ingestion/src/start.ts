/**
 * Engine entrypoint — wires config → DB pool → Redis client →
 * probe map → Fastify server, and exposes hooks for concrete
 * pipelines to register at boot. Returns IMMEDIATELY (per Q12);
 * the reverse proxy gates traffic via /ready until probes pass,
 * so we do not block startup on probe-retry loops.
 *
 * v0.1 contract:
 *   - load config (throws on misconfig — fail-fast at boot)
 *   - construct pg.Pool, ioredis.Redis
 *   - build probe map { postgres, redis }
 *   - build Fastify app with /health + /ready
 *   - listen on the configured port
 *   - return { app, db, redis, registry, close }
 *
 * Concrete pipelines (PRs 14-17) call `registry.register(...)`
 * before invoking `start()`. Wiring of pipelines to BullMQ workers
 * happens inside start() but the worker class itself ships with
 * the concrete pipeline PRs.
 *
 * Test seam: dbFactory / redisFactory / serverFactory let unit
 * tests inject stubs without dialing real services. Production
 * defaults construct real pg.Pool / ioredis Redis / Fastify.
 *
 * Resource safety (copilot #15 Fix 4): if app.listen() throws
 * (EADDRINUSE, EACCES, etc.) AFTER db + redis are constructed,
 * both are torn down best-effort before the original error
 * rethrows. Cleanup errors don't mask the listen error.
 *
 * Idempotent close (copilot #15 Fix 7): close() memoises its
 * first invocation; concurrent or repeat calls share the same
 * Promise so cleanup runs exactly once.
 */
import pg from "pg";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";

import { loadEngineConfig, type EngineConfig } from "./config.js";
import { postgresProbe, type PostgresProbeTarget } from "./probes/postgres.js";
import { redisProbe, type RedisProbeTarget } from "./probes/redis.js";
import { PipelineRegistry } from "./registry.js";
import { buildServer, type ProbeMap } from "./server.js";

/**
 * Subset of `pg.Pool` start() actually consumes. Lets test stubs
 * satisfy the type without faking the full Pool surface.
 */
export interface StartDb extends PostgresProbeTarget {
  end(): Promise<void>;
}

/**
 * Subset of `ioredis.Redis` start() actually consumes.
 */
export interface StartRedis extends RedisProbeTarget {
  disconnect(): void;
}

/**
 * Subset of FastifyInstance start() consumes — listen + close.
 * Production defaults to a full Fastify instance from buildServer().
 */
export interface StartServer {
  listen(opts: { host: string; port: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface StartedEngine {
  readonly app: StartServer;
  readonly db: StartDb;
  readonly redis: StartRedis;
  readonly registry: PipelineRegistry;
  readonly config: EngineConfig;
  /** Tear down the engine: close the HTTP server, drain the pool,
   *  disconnect Redis. Idempotent — safe to call repeatedly or
   *  concurrently; the first invocation runs cleanup once and
   *  subsequent callers receive the same Promise. */
  close(): Promise<void>;
}

export interface StartOptions {
  /** Optional override of process.env — keeps `start()` testable
   *  by injecting a stub env without polluting the real one. */
  readonly env?: Record<string, string | undefined>;
  /** Optional pre-populated registry — concrete pipelines register
   *  before calling `start()`. */
  readonly registry?: PipelineRegistry;
  /** @internal Test seam — defaults to `new pg.Pool(...)`. */
  readonly dbFactory?: (config: EngineConfig) => StartDb;
  /** @internal Test seam — defaults to `new Redis(...)`. */
  readonly redisFactory?: (config: EngineConfig) => StartRedis;
  /** @internal Test seam — defaults to `buildServer({probes})`. */
  readonly serverFactory?: (probes: ProbeMap) => StartServer;
}

function defaultDbFactory(config: EngineConfig): StartDb {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

function defaultRedisFactory(config: EngineConfig): StartRedis {
  return new Redis(config.redisUrl, {
    // BullMQ requirement — when ioredis is used as the BullMQ
    // connection, maxRetriesPerRequest must be null and
    // enableReadyCheck must be false.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

function defaultServerFactory(probes: ProbeMap): StartServer {
  // FastifyInstance is structurally compatible with StartServer —
  // both expose listen + close with the same shape.
  return buildServer({ probes }) as unknown as FastifyInstance &
    StartServer;
}

/**
 * Best-effort cleanup. Each step swallows its own error so a buggy
 * pool.end doesn't prevent redis.disconnect from running. The
 * caller (start's catch block) is responsible for rethrowing the
 * ORIGINAL error that triggered teardown.
 */
async function teardown(
  app: StartServer | undefined,
  db: StartDb | undefined,
  redis: StartRedis | undefined,
): Promise<void> {
  if (app !== undefined) {
    try {
      await app.close();
    } catch {
      // best-effort
    }
  }
  if (db !== undefined) {
    try {
      await db.end();
    } catch {
      // best-effort
    }
  }
  if (redis !== undefined) {
    try {
      redis.disconnect();
    } catch {
      // best-effort
    }
  }
}

export async function start(options: StartOptions = {}): Promise<StartedEngine> {
  const config = loadEngineConfig(options.env ?? process.env);
  const registry = options.registry ?? new PipelineRegistry();

  const db = (options.dbFactory ?? defaultDbFactory)(config);
  const redis = (options.redisFactory ?? defaultRedisFactory)(config);

  const probes: ProbeMap = {
    postgres: () => postgresProbe(db),
    redis: () => redisProbe(redis),
  };

  const app = (options.serverFactory ?? defaultServerFactory)(probes);

  try {
    await app.listen({ host: "0.0.0.0", port: config.port });
  } catch (err) {
    // Resource-safety: db + redis were already constructed and may
    // hold sockets. Tear them down best-effort before rethrowing
    // the original listen error so callers see the cause, not a
    // cleanup-noise wrapper.
    await teardown(app, db, redis);
    throw err;
  }

  // Memoised close — first call runs the cleanup; concurrent and
  // subsequent calls return the same Promise.
  let closing: Promise<void> | undefined;

  return {
    app,
    db,
    redis,
    registry,
    config,
    close(): Promise<void> {
      if (closing === undefined) {
        closing = teardown(app, db, redis);
      }
      return closing;
    },
  };
}
