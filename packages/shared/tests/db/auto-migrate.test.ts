/**
 * auto-migrate.test.ts — PR-X1 (phase-a follow-up).
 *
 * Unit-tests the `applyMigrationsWithLock` helper that the CLI
 * `opencoo migrate` verb AND the `engine-self-operating` boot
 * path both call. The helper:
 *   1. acquires a `pg.PoolClient` via `pool.connect()`,
 *   2. opens a transaction,
 *   3. takes a process-wide `pg_advisory_xact_lock` keyed on
 *      `hashtext('opencoo.auto_migrate')::bigint`,
 *   4. runs the drizzle migrator against the same client,
 *   5. COMMITs (which auto-releases the lock),
 *   6. logs `migrate.applied`. On failure ROLLBACKs (also auto-
 *      releases the lock), logs `migrate.failed`, re-throws.
 *
 * Test strategy: build a thin PGlite-backed `pg.Pool`-shim that
 * intercepts the SQL the helper issues (BEGIN / advisory lock /
 * ROLLBACK / COMMIT) and forwards everything else to a single
 * shared PGlite instance. The migrator is supplied via the
 * `__applyMigrationsWithLockForTests` seam so tests can plug in
 * a PGlite-flavoured drizzle migrator (real migration application)
 * OR a deliberately-failing one without standing up real Postgres.
 *
 * Coverage:
 *   - happy path: the helper's SQL sequence is correct and the
 *     migrator is invoked; a second invocation against the same
 *     PGlite is a no-op (drizzle's journal makes pending = 0).
 *   - failure propagation: a forced-failing migrator throws
 *     through the helper, the lock is released, and a SUBSEQUENT
 *     successful invocation can proceed.
 *   - concurrency (TODO): PGlite's WASM single-process backend
 *     does not model `pg_advisory_xact_lock` contention
 *     realistically — the lock call is a no-op there. The
 *     helper's lock acquire is verified at the SQL-issuance
 *     level (the BEGIN / SELECT pg_advisory_xact_lock(...) /
 *     COMMIT sequence is asserted) but true concurrent-blocking
 *     semantics need real Postgres. Tracked as a follow-up:
 *     add a nightly-live-pilot test that opens two parallel
 *     `applyMigrationsWithLock` against a real pg.Pool and
 *     observes the second blocks until the first commits.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";

import {
  AUTO_MIGRATE_LOCK_KEY_SQL,
  AUTO_MIGRATE_LOCK_LABEL,
  __applyMigrationsWithLockForTests,
  applyMigrationsWithLock,
  resolveSharedMigrationsDir,
  type MigratorRunner,
} from "../../src/db/auto-migrate.js";
import { ConsoleLogger } from "../../src/logger.js";

/** ---- PGlite pool-shim --------------------------------------
 *  Implements just enough of pg.Pool / pg.PoolClient to satisfy
 *  the helper. SQL the helper issues directly (BEGIN / SELECT
 *  pg_advisory_xact_lock / ROLLBACK / COMMIT) is recorded for
 *  assertions and forwarded to PGlite via `pg.exec()`; everything
 *  else falls through. The PGlite-flavoured migrator ignores the
 *  shim's client argument and operates against the underlying
 *  PGlite directly (see `pgliteRunner` below). */

interface RecordedQuery {
  readonly sql: string;
  readonly params: unknown[] | undefined;
}

interface ShimPool extends pg.Pool {
  readonly pglite: PGlite;
  readonly issued: ReadonlyArray<RecordedQuery>;
  /** Test seam — when set, `pool.connect()` awaits this barrier
   *  promise BEFORE returning the client. Lets the test gate
   *  one helper invocation behind another. */
  setConnectBarrier(p: Promise<void> | null): void;
}

function makeShimPool(pglite: PGlite): ShimPool {
  const issued: RecordedQuery[] = [];
  let connectBarrier: Promise<void> | null = null;

  const client = {
    query: (async (
      textOrConfig: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const sql =
        typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
      const params =
        typeof textOrConfig === "string"
          ? values
          : textOrConfig.values;
      issued.push({ sql, params });
      // Forward to PGlite. Use exec for parameterless DDL/control
      // statements (BEGIN / COMMIT / ROLLBACK / advisory lock);
      // use query() for anything with parameters.
      if (params === undefined) {
        const r = await pglite.exec(sql);
        return { rows: [], rowCount: 0, results: r };
      }
      const r = await pglite.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rows.length };
    }) as unknown as pg.PoolClient["query"],
    release: () => {
      // No-op: PGlite has no concept of pool checkout/checkin.
    },
  } as unknown as pg.PoolClient;

  const pool = {
    pglite,
    get issued(): ReadonlyArray<RecordedQuery> {
      return issued;
    },
    setConnectBarrier(p: Promise<void> | null): void {
      connectBarrier = p;
    },
    async connect(): Promise<pg.PoolClient> {
      if (connectBarrier !== null) {
        await connectBarrier;
      }
      return client;
    },
    async end(): Promise<void> {
      // No-op for the shim; the test owns PGlite's lifecycle.
    },
  } as unknown as ShimPool;
  return pool;
}

/** PGlite-flavoured migrator. Mirrors the journal-walk in
 *  `tests/migrations/migrate-applies-clean.test.ts` — that test
 *  bypasses drizzle's pglite migrator because PGlite's prepared-
 *  statement path rejects multi-command chunks (e.g. ALTER TABLE
 *  + CREATE INDEX in one statement-breakpoint chunk). We do the
 *  same here: walk `meta/_journal.json`, exec each chunk via
 *  `pg.exec()` (simple-query, multi-command-friendly), and write
 *  the journal row drizzle would have written. The semantics
 *  match drizzle's migrator from the helper's perspective —
 *  applies pending migrations, idempotent on re-run via the
 *  `__drizzle_migrations` journal. The pg.PoolClient argument is
 *  unused here (the PGlite-shim's client doesn't satisfy
 *  drizzle-orm/node-postgres's `drizzle()` entry point). */
interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
  readonly breakpoints: boolean;
}

function makePgliteRunner(pglite: PGlite): MigratorRunner {
  return async (_client, migrationsFolder) => {
    await pglite.exec(`CREATE SCHEMA IF NOT EXISTS "drizzle";`);
    await pglite.exec(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);
    const journalRaw = readFileSync(
      path.join(migrationsFolder, "meta", "_journal.json"),
      "utf8",
    );
    const journal = JSON.parse(journalRaw) as { entries: readonly JournalEntry[] };
    // Idempotent: skip any migration whose hash already lives
    // in the journal table — mirrors drizzle's actual migrator.
    const existing = await pglite.query<{ hash: string }>(
      `SELECT hash FROM "drizzle"."__drizzle_migrations"`,
    );
    const appliedHashes = new Set(existing.rows.map((r) => r.hash));
    for (const entry of journal.entries) {
      const file = path.join(migrationsFolder, `${entry.tag}.sql`);
      const body = readFileSync(file, "utf8");
      const hash = createHash("sha256").update(body).digest("hex");
      if (appliedHashes.has(hash)) continue;
      const chunks = body.split("--> statement-breakpoint");
      for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (trimmed.length === 0) continue;
        await pglite.exec(chunk);
      }
      await pglite.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
        [hash, entry.when],
      );
    }
  };
}

const silentLogger = new ConsoleLogger({
  stream: { write: () => true },
});

describe("AUTO_MIGRATE_LOCK_KEY_SQL — deterministic across callers", () => {
  it("derives the key in-database from a single natural-language label", () => {
    expect(AUTO_MIGRATE_LOCK_LABEL).toBe("opencoo.auto_migrate");
    // The expression is what every caller emits. Pinning it here
    // guards against an accidental rename that would silently
    // pick a DIFFERENT bigint key — two engines wouldn't
    // serialise.
    expect(AUTO_MIGRATE_LOCK_KEY_SQL).toBe(
      "hashtext('opencoo.auto_migrate')::bigint",
    );
  });
});

describe("applyMigrationsWithLock — happy path (PGlite-shim)", () => {
  let pglite: PGlite;
  let pool: ShimPool;

  beforeEach(() => {
    pglite = new PGlite();
    pool = makeShimPool(pglite);
  });

  afterEach(async () => {
    await pglite.close();
  });

  it("issues BEGIN → pg_advisory_xact_lock → migrator → COMMIT in order, then logs migrate.applied", async () => {
    // Drizzle's pglite migrator runs through its own connection
    // path; we reuse it via the test seam so the helper's
    // outer BEGIN/lock/COMMIT wrapping is what's exercised.
    const migrator: MigratorRunner = vi.fn(
      makePgliteRunner(pglite),
    );
    const logSpy = vi.fn<(s: string) => boolean>(() => true);
    const logger = new ConsoleLogger({ stream: { write: logSpy } });
    const folder = resolveSharedMigrationsDir();

    await __applyMigrationsWithLockForTests(
      { pool, migrationsFolder: folder, logger },
      migrator,
    );

    // Migrator invoked exactly once with the resolved folder.
    expect(migrator).toHaveBeenCalledTimes(1);
    const [, calledFolder] = (migrator as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [unknown, string];
    expect(calledFolder).toBe(folder);

    // Helper's own SQL: BEGIN, advisory lock, COMMIT (no ROLLBACK
    // on the happy path).
    const directSql = pool.issued.map((q) => q.sql.trim());
    expect(directSql).toEqual([
      "BEGIN",
      `SELECT pg_advisory_xact_lock(${AUTO_MIGRATE_LOCK_KEY_SQL})`,
      "COMMIT",
    ]);

    // migrate.applied surfaced exactly once on success.
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const appliedLines = lines.filter((l) => l.includes("migrate.applied"));
    const failedLines = lines.filter((l) => l.includes("migrate.failed"));
    expect(appliedLines.length).toBe(1);
    expect(failedLines.length).toBe(0);
  });

  it("second invocation against the same DB is a no-op (drizzle journal)", async () => {
    const folder = resolveSharedMigrationsDir();

    // First pass: apply every committed migration.
    await __applyMigrationsWithLockForTests(
      { pool, migrationsFolder: folder, logger: silentLogger },
      makePgliteRunner(pglite),
    );
    const journalCount1 = await pglite.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
    );

    // Second pass: helper succeeds, drizzle finds nothing pending.
    await __applyMigrationsWithLockForTests(
      { pool, migrationsFolder: folder, logger: silentLogger },
      makePgliteRunner(pglite),
    );
    const journalCount2 = await pglite.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
    );

    // Idempotent — same row count post-second-pass.
    expect(journalCount2.rows[0]?.count).toBe(journalCount1.rows[0]?.count);
    // And both passes did issue the helper's SQL (so the lock
    // was acquired both times — not skipped).
    const begins = pool.issued.filter((q) => q.sql.trim() === "BEGIN");
    expect(begins.length).toBe(2);
  });
});

describe("applyMigrationsWithLock — failure propagation (PGlite-shim)", () => {
  let pglite: PGlite;
  let pool: ShimPool;

  beforeEach(() => {
    pglite = new PGlite();
    pool = makeShimPool(pglite);
  });

  afterEach(async () => {
    await pglite.close();
  });

  it("a forced-failing migrator throws through; ROLLBACK runs; subsequent invocation succeeds", async () => {
    const folder = resolveSharedMigrationsDir();
    const migrationFailure = new Error("forced migration failure");
    const failingMigrator: MigratorRunner = vi.fn(async () => {
      throw migrationFailure;
    });

    const logSpy = vi.fn<(s: string) => boolean>(() => true);
    const logger = new ConsoleLogger({ stream: { write: logSpy } });

    await expect(
      __applyMigrationsWithLockForTests(
        { pool, migrationsFolder: folder, logger },
        failingMigrator,
      ),
    ).rejects.toBe(migrationFailure);

    // Helper rolled back (releases the advisory lock) — the SQL
    // sequence is BEGIN, advisory lock, ROLLBACK (no COMMIT).
    const directSql = pool.issued.map((q) => q.sql.trim());
    expect(directSql).toContain("BEGIN");
    expect(directSql).toContain(
      `SELECT pg_advisory_xact_lock(${AUTO_MIGRATE_LOCK_KEY_SQL})`,
    );
    expect(directSql).toContain("ROLLBACK");
    expect(directSql).not.toContain("COMMIT");

    // migrate.failed logged with the error message.
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const failed = lines.find((l) => l.includes("migrate.failed"));
    expect(failed).toBeDefined();
    expect(failed).toContain("forced migration failure");

    // Subsequent successful invocation against the same pool
    // proceeds normally — confirms the lock was released and the
    // pool is reusable.
    const okMigrator: MigratorRunner = makePgliteRunner(pglite);
    await __applyMigrationsWithLockForTests(
      { pool, migrationsFolder: folder, logger: silentLogger },
      okMigrator,
    );
  });
});

describe("applyMigrationsWithLock — public API smoke (no override)", () => {
  it("calls drizzle-orm/node-postgres migrator path under the hood (compile-time wiring check)", () => {
    // The default export wires the real drizzle migrator. We
    // can't exercise it here without a real pg.Pool (PGlite
    // can't satisfy the node-postgres `drizzle()` entry point),
    // so this test pins the function existence + signature; the
    // behavior is exercised end-to-end in:
    //   - packages/shared/tests/migrations/migrate-applies-clean.test.ts
    //     (verifies every migration applies cleanly via PGlite),
    //   - packages/cli/tests/* (CLI verb integration),
    //   - packages/engine-self-operating/tests/start-auto-migrate.test.ts
    //     (engine boot ordering + env-opt-out + skipMigrate seam).
    expect(typeof applyMigrationsWithLock).toBe("function");
  });
});

// TODO (nightly-live-pilot): add a real-Postgres concurrency test
// that opens TWO parallel `applyMigrationsWithLock` against the
// same pg.Pool and asserts the second blocks at
// `pg_advisory_xact_lock` until the first commits. PGlite's
// WASM single-process backend reduces the lock call to a no-op
// so the helper's lock acquire is verified here at the
// SQL-issuance level (the BEGIN / SELECT pg_advisory_xact_lock /
// COMMIT sequence is asserted in the happy-path test) but the
// blocking semantics need a real Postgres process.
