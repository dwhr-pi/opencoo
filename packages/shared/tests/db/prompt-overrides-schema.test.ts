/**
 * prompt-overrides-schema.test.ts — PR-W1 (phase-a appendix #15).
 *
 * Schema-level tests for the new `prompt_overrides` table. The
 * table is operator-managed config: each row carries a per-
 * (domain, instance, prompt_name, locale) override body that
 * `loadPromptForScope()` reads in preference to the shipped
 * baseline.
 *
 * Invariants pinned here:
 *
 *   1. The migration applies cleanly against an empty Postgres
 *      via the journal-walk harness shared with PR-Q5's smoke
 *      test (`migrate-applies-clean.test.ts`).
 *   2. `UNIQUE (domain_id, instance_id, prompt_name, locale)` with
 *      Postgres-15+ `NULLS NOT DISTINCT` semantics: a domain-
 *      scoped row (instance_id = NULL) AND an instance-scoped
 *      row (instance_id = <uuid>) for the same `(domain, prompt,
 *      locale)` BOTH coexist; a second domain-scoped row for the
 *      same key is rejected.
 *   3. CHECK constraints reject:
 *        - `body` longer than 100 000 chars (~2x longest shipped
 *          prompt — keeps an operator from pasting a multi-MB
 *          blob into the LLM prompt path),
 *        - `locale` outside `('en','pl')` (no `auto` — auto is
 *          a request-time fallback, not a stored value),
 *        - `prompt_name` outside the shipped `PROMPT_NAMES`
 *          tuple — a typo would silently fail to apply at run
 *          time and the operator would see no behavioural
 *          change.
 *   4. `ON DELETE CASCADE` from both `domains` and
 *      `agent_instances` — overrides are config attached to the
 *      scope, not standalone audit history.
 *
 * The test reuses the `applyMigrations` journal-walk pattern
 * from `tests/migrations/migrate-applies-clean.test.ts` so a
 * migration-format drift between the two helpers fails ONE of
 * them, not both, and the failure surface points to the
 * specific concern.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { PROMPT_NAMES } from "../../src/prompts/loader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
  readonly breakpoints: boolean;
}
interface Journal {
  readonly entries: readonly JournalEntry[];
}

function readJournal(): Journal {
  const raw = readFileSync(
    path.join(migrationsFolder, "meta", "_journal.json"),
    "utf8",
  );
  return JSON.parse(raw) as Journal;
}

async function applyMigrations(pg: PGlite): Promise<void> {
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS "drizzle";`);
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);
  const journal = readJournal();
  for (const entry of journal.entries) {
    const file = path.join(migrationsFolder, `${entry.tag}.sql`);
    const body = readFileSync(file, "utf8");
    const hash = createHash("sha256").update(body).digest("hex");
    const chunks = body.split("--> statement-breakpoint");
    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (trimmed.length === 0) continue;
      await pg.exec(chunk);
    }
    await pg.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
      [hash, entry.when],
    );
  }
}

/** Insert one domain + one agent_instance and return their ids
 *  so each test starts from the same minimal fixture without
 *  reaching for a shared helper module. */
async function seedScopes(pg: PGlite): Promise<{
  readonly domainId: string;
  readonly otherDomainId: string;
  readonly instanceId: string;
  readonly otherInstanceId: string;
}> {
  const domainId = randomUUID();
  const otherDomainId = randomUUID();
  // Use random slugs so re-running against a non-empty DB is
  // unlikely to collide on the domains_slug_unique constraint.
  const slug = `t-${domainId.slice(0, 8)}`;
  const otherSlug = `t-${otherDomainId.slice(0, 8)}`;
  await pg.query(
    `INSERT INTO domains (id, slug, name) VALUES ($1, $2, $3), ($4, $5, $6)`,
    [domainId, slug, "Test domain", otherDomainId, otherSlug, "Other domain"],
  );

  const instanceId = randomUUID();
  const otherInstanceId = randomUUID();
  await pg.query(
    `INSERT INTO agent_instances
       (id, definition_slug, name, scope_domain_ids)
     VALUES
       ($1, $2, $3, ARRAY[$4]::uuid[]),
       ($5, $6, $7, ARRAY[$8]::uuid[])`,
    [
      instanceId,
      "heartbeat",
      `inst-${instanceId.slice(0, 8)}`,
      domainId,
      otherInstanceId,
      "heartbeat",
      `inst-${otherInstanceId.slice(0, 8)}`,
      domainId,
    ],
  );

  return { domainId, otherDomainId, instanceId, otherInstanceId };
}

describe("prompt_overrides — schema migration applies cleanly", () => {
  let pg: PGlite;

  beforeEach(() => {
    pg = new PGlite();
  });

  afterEach(async () => {
    await pg.close();
  });

  it("creates the table with the expected columns", async () => {
    await applyMigrations(pg);
    const cols = await pg.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'prompt_overrides'
        ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    // Pin the column set so a future schema edit that drops or
    // renames one of these surfaces here.
    expect(names).toEqual([
      "id",
      "domain_id",
      "instance_id",
      "prompt_name",
      "locale",
      "body",
      "overrides_version",
      "baseline_version",
      "updated_by_user_id",
      "created_at",
      "updated_at",
    ]);
  });

  it("indexes the per-(domain, instance, prompt_name, locale) UNIQUE constraint", async () => {
    await applyMigrations(pg);
    const constraints = await pg.query<{ conname: string; contype: string }>(
      `SELECT conname, contype
         FROM pg_constraint
        WHERE conrelid = 'public.prompt_overrides'::regclass
          AND contype = 'u'`,
    );
    const names = constraints.rows.map((r) => r.conname);
    expect(names).toContain("prompt_overrides_scope_unique");
  });
});

describe("prompt_overrides — UNIQUE with NULLS NOT DISTINCT", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("allows a domain-scoped row (instance_id NULL) and an instance-scoped row to coexist for the same (domain, prompt, locale)", async () => {
    const { domainId, instanceId } = await seedScopes(pg);
    // Domain-scoped row first.
    await pg.query(
      `INSERT INTO prompt_overrides
         (domain_id, instance_id, prompt_name, locale,
          body, overrides_version, baseline_version)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
      [
        domainId,
        "heartbeat",
        "en",
        "domain body",
        "1.0.0",
        "v0.1.0",
      ],
    );
    // Instance-scoped row for the SAME (domain, prompt, locale).
    // Must succeed — the UNIQUE constraint treats NULL as a
    // value, so the two rows are distinguishable.
    await expect(
      pg.query(
        `INSERT INTO prompt_overrides
           (domain_id, instance_id, prompt_name, locale,
            body, overrides_version, baseline_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          domainId,
          instanceId,
          "heartbeat",
          "en",
          "instance body",
          "1.0.0",
          "v0.1.0",
        ],
      ),
    ).resolves.toBeDefined();

    const count = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prompt_overrides
        WHERE domain_id = $1
          AND prompt_name = 'heartbeat'
          AND locale = 'en'`,
      [domainId],
    );
    expect(Number(count.rows[0]!.n)).toBe(2);
  });

  it("rejects a SECOND domain-scoped row for the same (domain, prompt, locale) — NULLs treated as equal", async () => {
    const { domainId } = await seedScopes(pg);
    await pg.query(
      `INSERT INTO prompt_overrides
         (domain_id, instance_id, prompt_name, locale,
          body, overrides_version, baseline_version)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
      [domainId, "heartbeat", "en", "first", "1.0.0", "v0.1.0"],
    );
    await expect(
      pg.query(
        `INSERT INTO prompt_overrides
           (domain_id, instance_id, prompt_name, locale,
            body, overrides_version, baseline_version)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [domainId, "heartbeat", "en", "second", "1.0.0", "v0.1.0"],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("rejects two instance-scoped rows for the same (domain, instance, prompt, locale)", async () => {
    const { domainId, instanceId } = await seedScopes(pg);
    await pg.query(
      `INSERT INTO prompt_overrides
         (domain_id, instance_id, prompt_name, locale,
          body, overrides_version, baseline_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [domainId, instanceId, "heartbeat", "en", "first", "1.0.0", "v0.1.0"],
    );
    await expect(
      pg.query(
        `INSERT INTO prompt_overrides
           (domain_id, instance_id, prompt_name, locale,
            body, overrides_version, baseline_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          domainId,
          instanceId,
          "heartbeat",
          "en",
          "second",
          "1.0.0",
          "v0.1.0",
        ],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("allows the same (instance, prompt, locale) under two different instances scoped to the same domain", async () => {
    const { domainId, instanceId, otherInstanceId } = await seedScopes(pg);
    await pg.query(
      `INSERT INTO prompt_overrides
         (domain_id, instance_id, prompt_name, locale,
          body, overrides_version, baseline_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7), ($1, $8, $3, $4, $5, $6, $7)`,
      [
        domainId,
        instanceId,
        "heartbeat",
        "en",
        "body",
        "1.0.0",
        "v0.1.0",
        otherInstanceId,
      ],
    );
    const count = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prompt_overrides
        WHERE domain_id = $1`,
      [domainId],
    );
    expect(Number(count.rows[0]!.n)).toBe(2);
  });
});

describe("prompt_overrides — CHECK constraints", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("rejects body longer than 100_000 chars", async () => {
    const { domainId } = await seedScopes(pg);
    const tooLong = "x".repeat(100_001);
    await expect(
      pg.query(
        `INSERT INTO prompt_overrides
           (domain_id, instance_id, prompt_name, locale,
            body, overrides_version, baseline_version)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [domainId, "heartbeat", "en", tooLong, "1.0.0", "v0.1.0"],
      ),
    ).rejects.toThrow(/check|constraint|body/i);
  });

  it("accepts body exactly 100_000 chars (boundary)", async () => {
    const { domainId } = await seedScopes(pg);
    const exactly = "y".repeat(100_000);
    await expect(
      pg.query(
        `INSERT INTO prompt_overrides
           (domain_id, instance_id, prompt_name, locale,
            body, overrides_version, baseline_version)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [domainId, "heartbeat", "en", exactly, "1.0.0", "v0.1.0"],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects locale outside ('en','pl')", async () => {
    const { domainId } = await seedScopes(pg);
    await expect(
      pg.query(
        `INSERT INTO prompt_overrides
           (domain_id, instance_id, prompt_name, locale,
            body, overrides_version, baseline_version)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [domainId, "heartbeat", "auto", "body", "1.0.0", "v0.1.0"],
      ),
    ).rejects.toThrow(/check|constraint|locale/i);
  });

  it("rejects prompt_name outside the shipped PROMPT_NAMES tuple", async () => {
    const { domainId } = await seedScopes(pg);
    await expect(
      pg.query(
        `INSERT INTO prompt_overrides
           (domain_id, instance_id, prompt_name, locale,
            body, overrides_version, baseline_version)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [domainId, "bogus_prompt_name", "en", "body", "1.0.0", "v0.1.0"],
      ),
    ).rejects.toThrow(/check|constraint|prompt_name/i);
  });

  it("accepts EVERY name in PROMPT_NAMES — the CHECK enumerates the same set", async () => {
    const { domainId } = await seedScopes(pg);
    // One row per shipped prompt name; if the CHECK list drifts
    // from PROMPT_NAMES one of these inserts will fail and the
    // test will name the offending prompt.
    for (const name of PROMPT_NAMES) {
      await expect(
        pg.query(
          `INSERT INTO prompt_overrides
             (domain_id, instance_id, prompt_name, locale,
              body, overrides_version, baseline_version)
           VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
          [domainId, name, "en", `body for ${name}`, "1.0.0", "v0.1.0"],
        ),
        `expected CHECK to accept prompt_name='${name}'`,
      ).resolves.toBeDefined();
    }
  });
});

describe("prompt_overrides — ON DELETE CASCADE", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("deletes override rows when the parent domain is deleted", async () => {
    const { domainId } = await seedScopes(pg);
    await pg.query(
      `INSERT INTO prompt_overrides
         (domain_id, instance_id, prompt_name, locale,
          body, overrides_version, baseline_version)
       VALUES ($1, NULL, 'heartbeat', 'en', 'body', '1.0.0', 'v0.1.0')`,
      [domainId],
    );
    await pg.query(`DELETE FROM agent_instances WHERE id IS NOT NULL`);
    await pg.query(`DELETE FROM domains WHERE id = $1`, [domainId]);
    const count = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prompt_overrides
        WHERE domain_id = $1`,
      [domainId],
    );
    expect(Number(count.rows[0]!.n)).toBe(0);
  });

  it("deletes instance-scoped override rows when the parent agent_instance is deleted", async () => {
    const { domainId, instanceId } = await seedScopes(pg);
    await pg.query(
      `INSERT INTO prompt_overrides
         (domain_id, instance_id, prompt_name, locale,
          body, overrides_version, baseline_version)
       VALUES ($1, $2, 'heartbeat', 'en', 'body', '1.0.0', 'v0.1.0')`,
      [domainId, instanceId],
    );
    await pg.query(`DELETE FROM agent_instances WHERE id = $1`, [instanceId]);
    const count = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prompt_overrides
        WHERE instance_id = $1`,
      [instanceId],
    );
    expect(Number(count.rows[0]!.n)).toBe(0);
  });
});
