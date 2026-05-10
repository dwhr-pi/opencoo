/**
 * Auto-migrate helper (PR-X1, phase-a follow-up).
 *
 * Applies the committed Drizzle migrations in `migrationsFolder`
 * against `pool` while holding a process-wide `pg_advisory_xact_lock`,
 * so multiple engines starting in parallel cannot race the
 * migrator. Drizzle's migrator is itself idempotent (it tracks
 * applied migrations in `drizzle.__drizzle_migrations`), so a
 * second engine reaching the lock after the first has finished
 * sees zero pending work and exits fast.
 *
 * Why an advisory lock at all? The "two engines starting
 * concurrently must not race the migrator" invariant matters in
 * the v0.1 partner deployment shape (single docker-compose, one
 * Postgres) AND in the orchestrator's co-boot path
 * (`packages/cli/src/commands/serve.ts` boots
 * engine-self-operating + engine-ingestion sequentially in one
 * process — the orchestrator only races itself when the operator
 * runs the CLI verb at the same time as the engine). Postgres
 * advisory locks are the canonical guard against this race; we
 * use a TRANSACTION-scoped lock (`pg_advisory_xact_lock`) so
 * COMMIT / ROLLBACK auto-releases — there is no leaked-lock
 * failure mode if a connection dies mid-migrate.
 *
 * Lock key derivation: `hashtext('opencoo.auto_migrate')::bigint`,
 * computed inside the database. We pass the literal string and
 * ask Postgres for its `hashtext()` so every engine, every CLI
 * verb, every operator one-off picks the SAME bigint key without
 * having to ship a hand-picked magic number from TypeScript.
 * `hashtext` is documented to return `int4`; we cast to `bigint`
 * for the `pg_advisory_xact_lock(bigint)` arity. Different
 * subsystems wanting their own advisory lock pick a different
 * input string — the keyspace is the natural-language label.
 *
 * The helper is owned by `@opencoo/shared/db`. The CLI verb
 * (`packages/cli/src/commands/migrate.ts`) and the engine boot
 * path (`packages/engine-self-operating/src/start.ts`) BOTH
 * import this same function so the production CLI flow and the
 * engine auto-migrate path are identical down to the SQL the
 * client emits. This keeps the threat-model surface to one
 * function: any reviewer auditing the migration path reads ONE
 * file.
 *
 * THREAT-MODEL alignment: no admin-API surface change. The
 * helper accepts a pool and runs migrations; nothing in the
 * request path is altered. The advisory-lock key is a
 * deterministic deadlock-safe BIGINT — same scheme any Postgres
 * application would use for boot-time exclusivity.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Logger } from "../logger.js";
import { safeErrorMessage } from "../scrub/index.js";

/** The natural-language label the lock key derives from. Exposed
 *  for tests + reviewer auditing only — runtime callers pass the
 *  pool, not the key. */
export const AUTO_MIGRATE_LOCK_LABEL = "opencoo.auto_migrate";

/** SQL fragment that deterministically derives the bigint lock
 *  key in-database. Encoded here so the same expression is used
 *  by the helper and (in the future) by any Postgres-side
 *  diagnostics that want to inspect the exact key. */
export const AUTO_MIGRATE_LOCK_KEY_SQL = `hashtext('${AUTO_MIGRATE_LOCK_LABEL}')::bigint`;

export interface ApplyMigrationsWithLockArgs {
  /** Shared pg.Pool. The helper borrows ONE client via
   *  `pool.connect()` and releases it on completion. The pool
   *  itself is never closed — callers (CLI verb, engine boot)
   *  own its lifecycle. */
  readonly pool: pg.Pool;
  /** Absolute path to the Drizzle `migrationsFolder` (the
   *  directory containing `meta/_journal.json`). */
  readonly migrationsFolder: string;
  /** Structured logger. Emits one `migrate.applied` line on
   *  success and one `migrate.failed` line on failure (after
   *  which the underlying error is re-thrown). */
  readonly logger: Logger;
}

/** Resolve the shared `@opencoo/shared/drizzle` migrations
 *  directory. Both the CLI verb and the engine boot path call
 *  this so the same path resolution is used in dev (running
 *  TypeScript via tsx) and in production (CommonJS dist beside
 *  the workspace install).
 *
 *  The walk is `<this-file-dir> → ../../drizzle`:
 *    - dev:        `packages/shared/src/db/` → `packages/shared/drizzle/`
 *    - prod (dist): `packages/shared/dist/db/` → `packages/shared/drizzle/`
 *    - npm install: `<install>/dist/db/` → `<install>/drizzle/`
 *      (the `drizzle/**` glob is whitelisted in this package's
 *      `files` field, so the artifact ships with migrations.) */
export function resolveSharedMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "drizzle");
}

/** Internal seam — the actual drizzle-migrator invocation,
 *  factored out so tests can substitute a PGlite-flavoured
 *  migrator OR a deliberately-failing one without having to
 *  spin up a real Postgres. Production callers use
 *  `applyMigrationsWithLock` (no override). */
export type MigratorRunner = (
  client: pg.PoolClient,
  migrationsFolder: string,
) => Promise<void>;

/** Default migrator: wraps the borrowed client with drizzle's
 *  node-postgres adapter and invokes the standard migrator.
 *  drizzle-orm/node-postgres accepts both Pool and PoolClient
 *  at the `drizzle()` entry point. */
const defaultMigratorRunner: MigratorRunner = async (
  client,
  migrationsFolder,
) => {
  const db = drizzle(client);
  await drizzleMigrate(db, { migrationsFolder });
};

/** Apply pending migrations from `migrationsFolder` against
 *  `pool` under `pg_advisory_xact_lock(hashtext(...))`. Resolves
 *  on success; rejects (after logging `migrate.failed`) on any
 *  underlying failure — the lock is auto-released by ROLLBACK.
 *
 *  Concurrency invariant: a second invocation against the same
 *  Pool / DATABASE_URL waits at the advisory-lock acquire until
 *  the first invocation's transaction commits or rolls back.
 *  Drizzle's journal then makes the second invocation a no-op
 *  (zero pending migrations).
 *
 *  Failure invariant: any throw inside the transaction (lock
 *  acquire, migrator run, COMMIT) triggers ROLLBACK, releases
 *  the lock, releases the client back to the pool, and re-throws
 *  the original error. Subsequent invocations against the same
 *  pool can proceed normally — there is no sticky lock or
 *  half-applied state beyond what Drizzle's `__drizzle_migrations`
 *  already tracks.
 */
export async function applyMigrationsWithLock(
  args: ApplyMigrationsWithLockArgs,
): Promise<void> {
  return _applyMigrationsWithLockUsing(args, defaultMigratorRunner);
}

/** @internal Test seam — same as `applyMigrationsWithLock` but
 *  with the migrator runner injectable. Production code paths
 *  use `applyMigrationsWithLock` (which always passes the real
 *  drizzle-orm/node-postgres migrator); tests use this variant
 *  to swap in a PGlite-flavoured runner OR a deliberately-failing
 *  one. Exported under the conventional `__` prefix so it is
 *  visible to tests but obviously not part of the production API.
 */
export async function __applyMigrationsWithLockForTests(
  args: ApplyMigrationsWithLockArgs,
  runMigrator: MigratorRunner,
): Promise<void> {
  return _applyMigrationsWithLockUsing(args, runMigrator);
}

async function _applyMigrationsWithLockUsing(
  args: ApplyMigrationsWithLockArgs,
  runMigrator: MigratorRunner,
): Promise<void> {
  const { pool, migrationsFolder, logger } = args;
  const startedAt = Date.now();
  const client = await pool.connect();
  try {
    // Transaction wrap: COMMIT releases the advisory lock; on
    // any error inside the try, the catch issues ROLLBACK which
    // also releases the lock.
    await client.query("BEGIN");
    try {
      // Acquire the transaction-scoped advisory lock. Blocks
      // until the lock is held — concurrent callers serialise
      // here, not at the migrator step.
      await client.query(
        `SELECT pg_advisory_xact_lock(${AUTO_MIGRATE_LOCK_KEY_SQL})`,
      );
      // Run the migrator against the SAME borrowed client so
      // any DDL it issues sits inside our advisory-lock window.
      // Drizzle's migrator does its own internal SAVEPOINTs
      // per-migration which nest under our outer BEGIN cleanly.
      await runMigrator(client, migrationsFolder);
      await client.query("COMMIT");
    } catch (innerErr) {
      // ROLLBACK releases the advisory lock and surfaces the
      // migrator's failure to the caller. Drizzle's PG migrator
      // commits each migration in its own inner transaction
      // (BEGIN/COMMIT, not SAVEPOINT), so the
      // `__drizzle_migrations` journal is the source of truth
      // for which migrations actually stuck — anything in
      // flight inside the still-open outer tx when the throw
      // happened is undone with this ROLLBACK.
      await client.query("ROLLBACK").catch(() => undefined);
      throw innerErr;
    }
    logger.info("migrate.applied", {
      folder: migrationsFolder,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error("migrate.failed", {
      folder: migrationsFolder,
      // pg / SASL errors can carry connection-string fragments,
      // auth tokens, or SCRAM message material in their `.message`.
      // Route through `safeErrorMessage` (scrub-then-cap, capped at
      // 200 chars) per THREAT-MODEL §3.6 invariant 11 — same scrub
      // gate the engine-scaffold + start.ts use for their own
      // teardown / dispatcher logs (start.ts round-3 fix #4). The
      // throw below preserves the original `err` for upstream
      // handlers; only the log payload is scrubbed.
      error: safeErrorMessage(err),
    });
    throw err;
  } finally {
    // Always release the borrowed client. The pool stays open;
    // the caller's lifecycle owns it.
    client.release();
  }
}
