/**
 * `opencoo migrate` (PR 30 / plan #135; PR-X1 phase-a follow-up).
 *
 * Runs the Drizzle migrations from `packages/shared/drizzle/`
 * against the database at `DATABASE_URL`. Idempotent — Drizzle
 * tracks applied migrations in `drizzle.__drizzle_migrations`.
 *
 * Since PR-X1 (phase-a follow-up) the engine ALSO auto-migrates
 * at boot (default-on; opt-out via `OPENCOO_AUTO_MIGRATE=0`), so
 * running this verb is now optional in the default flow. Both
 * paths route through the SAME helper
 * (`applyMigrationsWithLock`), which acquires a process-wide
 * `pg_advisory_xact_lock` before invoking drizzle's migrator —
 * that means an operator running `opencoo migrate` AT THE SAME
 * TIME as an engine boot still serialises safely (one waits at
 * the lock; the other becomes a no-op once the journal is up to
 * date).
 *
 * The `--skip-migrate` flag's semantics are about the engine
 * boot flag (`StartOptions.skipMigrate`), not the CLI verb;
 * passing it to `opencoo migrate` keeps its pre-PR-X1 no-op-then-
 * exit-ok behavior so existing scripts that pipe through the
 * flag don't break.
 */
import pc from "picocolors";

import {
  applyMigrationsWithLock,
  resolveSharedMigrationsDir,
} from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { exitOk, exitRuntimeError, isExitSentinel } from "../lib/exit.js";
import { openPool } from "../lib/db.js";

export interface MigrateArgs {
  readonly env: Record<string, string | undefined>;
  readonly skipMigrate: boolean;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
}

export async function runMigrate(args: MigrateArgs): Promise<void> {
  if (args.skipMigrate) {
    args.stdout.write(
      pc.dim("migrate: --skip-migrate set; skipping (no-op)\n"),
    );
    return exitOk();
  }
  const pool = openPool({ env: args.env });
  try {
    const migrationsFolder = resolveSharedMigrationsDir();
    args.stdout.write(`migrate: applying from ${migrationsFolder}\n`);
    // ConsoleLogger writes JSON-per-line to stdout by default;
    // re-route to the CLI's stderr so it doesn't intermix with
    // the "migrate: ok" success line on stdout.
    const logger = new ConsoleLogger({
      stream: { write: (s: string): boolean => args.stderr.write(s) },
    });
    await applyMigrationsWithLock({ pool, migrationsFolder, logger });
    args.stdout.write(pc.green("migrate: ok\n"));
    return exitOk();
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(`migrate: failed (${err instanceof Error ? err.message : String(err)})\n`),
    );
    return exitRuntimeError();
  } finally {
    await pool.end().catch(() => undefined);
  }
}
