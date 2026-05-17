/**
 * load-prompt-for-scope.test.ts — PR-W1 (phase-a appendix #15).
 *
 * Runtime resolver invariants for `loadPromptForScope`. The
 * resolver is the engine-side reader for `prompt_overrides`:
 * given `{name, locale, domainId, instanceId?, db}` it returns
 * the effective prompt body — the instance-scoped override if
 * one exists, otherwise the domain-scoped override, otherwise
 * the shipped baseline — and reports the source via a structured
 * `override` field so the page-citations writer and admin UI can
 * mark non-baseline runs.
 *
 * Six pinned cases per the appendix scoping doc (#15 PR-W1):
 *
 *   (a) baseline when no override row exists,
 *   (b) domain override when only a domain row exists,
 *   (c) instance override when BOTH a domain and instance row
 *       exist (precedence test — instance wins),
 *   (d) `isStale: true` when `baseline_version` < current
 *       shipped version,
 *   (e) `isStale: false` when equal,
 *   (f) synchronous `loadPrompt({name, locale})` returns baseline
 *       regardless of DB state — the injection-corpus runner
 *       depends on this and the runner test (`_runner.ts`) is
 *       version-pinned to shipped baselines.
 *
 * Plus locale fallback (`auto → en`) preserved on the scoped path.
 *
 * The tests stand up a PGlite-backed Drizzle handle so the
 * resolver's SELECT runs against a real-Postgres-like surface
 * (matches the schema test's harness). The shared journal-walk
 * helper from `tests/migrations/migrate-applies-clean.test.ts`
 * applies every committed migration so the resolver's SELECT
 * sees the live constraints (CHECK on locale, length, etc.).
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import {
  loadPrompt,
  loadPromptForScope,
  type LoadedPromptWithOverride,
  type PromptName,
} from "../../src/prompts/loader.js";
import { PROMPT_VERSION_MANIFEST } from "../../src/prompts/version-manifest.js";

type Db = ReturnType<typeof drizzle>;

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

interface SeededIds {
  readonly domainId: string;
  readonly instanceId: string;
}

async function seedScopes(pg: PGlite): Promise<SeededIds> {
  const domainId = randomUUID();
  await pg.query(`INSERT INTO domains (id, slug, name) VALUES ($1, $2, $3)`, [
    domainId,
    `t-${domainId.slice(0, 8)}`,
    "Test domain",
  ]);
  const instanceId = randomUUID();
  await pg.query(
    `INSERT INTO agent_instances
       (id, definition_slug, name, scope_domain_ids)
     VALUES ($1, $2, $3, ARRAY[$4]::uuid[])`,
    [instanceId, "heartbeat", `inst-${instanceId.slice(0, 8)}`, domainId],
  );
  return { domainId, instanceId };
}

async function insertOverride(args: {
  readonly pg: PGlite;
  readonly domainId: string;
  readonly instanceId: string | null;
  readonly promptName: PromptName;
  readonly locale: "en" | "pl";
  readonly body: string;
  readonly overridesVersion: string;
  readonly baselineVersion: string;
}): Promise<void> {
  await args.pg.query(
    `INSERT INTO prompt_overrides
       (domain_id, instance_id, prompt_name, locale,
        body, overrides_version, baseline_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.domainId,
      args.instanceId,
      args.promptName,
      args.locale,
      args.body,
      args.overridesVersion,
      args.baselineVersion,
    ],
  );
}

describe("loadPromptForScope — six pinned cases (PR-W1)", () => {
  let pg: PGlite;
  let db: Db;
  let scopes: SeededIds;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
    db = drizzle(pg);
    scopes = await seedScopes(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  // (a) baseline when no override row exists
  it("returns baseline when no override row exists", async () => {
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      db,
    });
    const baseline = loadPrompt({ name: "heartbeat", locale: "en" });
    expect(result.body).toBe(baseline.body);
    expect(result.version).toBe(baseline.version);
    expect(result.override).toBeNull();
  });

  // (b) domain override when only domain row exists
  it("returns domain override when only a domain row exists", async () => {
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "DOMAIN OVERRIDE BODY",
      overridesVersion: "1.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      db,
    });
    expect(result.body).toBe("DOMAIN OVERRIDE BODY");
    expect(result.override).not.toBeNull();
    expect(result.override?.scope).toBe("domain");
    expect(result.override?.overridesVersion).toBe("1.0.0");
    expect(result.override?.baselineVersion).toBe(
      PROMPT_VERSION_MANIFEST.heartbeat,
    );
    expect(result.override?.isStale).toBe(false);
  });

  // (c) instance precedence — instance wins when both domain and
  // instance rows exist
  it("returns instance override when BOTH domain and instance rows exist (precedence)", async () => {
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "DOMAIN OVERRIDE BODY",
      overridesVersion: "1.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: scopes.instanceId,
      promptName: "heartbeat",
      locale: "en",
      body: "INSTANCE OVERRIDE BODY",
      overridesVersion: "2.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      instanceId: scopes.instanceId,
      db,
    });
    expect(result.body).toBe("INSTANCE OVERRIDE BODY");
    expect(result.override?.scope).toBe("instance");
    expect(result.override?.overridesVersion).toBe("2.0.0");
  });

  // Sanity follow-up: WITHOUT an instanceId arg the resolver
  // falls back to the domain row even if an instance row exists
  // for the same domain. (Scheduled callers that omit
  // instanceId — e.g. one-off scripts, future v2+ background
  // jobs — get the domain shape; callers with an instance MUST
  // pass it in.)
  it("falls back to the domain override when called WITHOUT instanceId, even if an instance row exists", async () => {
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "DOMAIN OVERRIDE BODY",
      overridesVersion: "1.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: scopes.instanceId,
      promptName: "heartbeat",
      locale: "en",
      body: "INSTANCE OVERRIDE BODY",
      overridesVersion: "2.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      db,
    });
    expect(result.body).toBe("DOMAIN OVERRIDE BODY");
    expect(result.override?.scope).toBe("domain");
  });

  // Sanity follow-up #2 (Copilot triage): instance-only row, no
  // domain row, caller passes the matching instanceId — the
  // instance row wins. Covers the gap the prior cases left: (c)
  // exercised BOTH-rows-exist precedence; this case proves the
  // resolver still surfaces an instance row when the domain row
  // doesn't exist at all.
  it("returns the instance override when ONLY an instance row exists (no domain row) and instanceId matches", async () => {
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: scopes.instanceId,
      promptName: "heartbeat",
      locale: "en",
      body: "INSTANCE-ONLY OVERRIDE BODY",
      overridesVersion: "3.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      instanceId: scopes.instanceId,
      db,
    });
    expect(result.body).toBe("INSTANCE-ONLY OVERRIDE BODY");
    expect(result.override?.scope).toBe("instance");
    expect(result.override?.overridesVersion).toBe("3.0.0");
  });

  // (d) isStale: true when baseline_version drifts
  it("returns isStale: true when baseline_version < current shipped version", async () => {
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "STALE OVERRIDE BODY",
      overridesVersion: "1.0.0",
      // Synthetic earlier version — guaranteed to differ from
      // whatever the loader currently reports because semver
      // never reaches "0.0.0" as a real shipped value.
      baselineVersion: "0.0.0",
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      db,
    });
    expect(result.override?.baselineVersion).toBe("0.0.0");
    expect(result.override?.isStale).toBe(true);
  });

  // (e) isStale: false when equal
  it("returns isStale: false when baseline_version equals current shipped", async () => {
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "CURRENT OVERRIDE BODY",
      overridesVersion: "1.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      db,
    });
    expect(result.override?.isStale).toBe(false);
  });

  // (f) the synchronous loadPrompt invariant — corpus runner
  // depends on this and must never see an override.
  it("synchronous loadPrompt({name, locale}) returns baseline regardless of DB state (corpus invariant)", async () => {
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "DOMAIN OVERRIDE BODY",
      overridesVersion: "1.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    // Same call shape the injection corpus runner uses
    // (`_runner.ts` line 81): synchronous, no scope arg, no
    // `await`. Must surface the SHIPPED baseline, NOT the DB
    // row — the corpus is version-pinned to baselines and any
    // override leak would silently fail the version-drift
    // guard in `runUniversalInvariants`.
    const result = loadPrompt({ name: "heartbeat", locale: "en" });
    expect(result.version).toBe(PROMPT_VERSION_MANIFEST.heartbeat);
    // Defensive: the type system prevents an `override` field
    // on this return path, but pin the runtime shape too so a
    // future "convenience" addition trips review.
    expect("override" in result).toBe(false);
  });
});

describe("loadPromptForScope — locale fallback (auto → en)", () => {
  let pg: PGlite;
  let db: Db;
  let scopes: SeededIds;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
    db = drizzle(pg);
    scopes = await seedScopes(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("resolves to the en override when locale='auto' AND an en override exists", async () => {
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "EN OVERRIDE BODY",
      overridesVersion: "1.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "auto",
      domainId: scopes.domainId,
      db,
    });
    // Effective locale resolved to 'en'.
    expect(result.locale).toBe("en");
    expect(result.fallbackApplied).toBe(true);
    expect(result.body).toBe("EN OVERRIDE BODY");
    expect(result.override?.scope).toBe("domain");
  });

  it("returns en baseline when locale='auto' and no override exists for en", async () => {
    // Only a pl override exists — auto → en must not pick it.
    await insertOverride({
      pg,
      domainId: scopes.domainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "pl",
      body: "PL OVERRIDE BODY",
      overridesVersion: "1.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "auto",
      domainId: scopes.domainId,
      db,
    });
    const baseline = loadPrompt({ name: "heartbeat", locale: "en" });
    expect(result.locale).toBe("en");
    expect(result.fallbackApplied).toBe(true);
    expect(result.body).toBe(baseline.body);
    expect(result.override).toBeNull();
  });
});

describe("loadPromptForScope — narrow shape contract", () => {
  let pg: PGlite;
  let db: Db;
  let scopes: SeededIds;

  beforeEach(async () => {
    pg = new PGlite();
    await applyMigrations(pg);
    db = drizzle(pg);
    scopes = await seedScopes(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("never picks an override row from a different domain", async () => {
    // Seed a SECOND domain with its own override row, then ask
    // for the original domain. The resolver must not surface
    // the foreign row.
    const otherDomainId = randomUUID();
    await pg.query(
      `INSERT INTO domains (id, slug, name) VALUES ($1, $2, $3)`,
      [otherDomainId, `t-${otherDomainId.slice(0, 8)}`, "Other domain"],
    );
    await insertOverride({
      pg,
      domainId: otherDomainId,
      instanceId: null,
      promptName: "heartbeat",
      locale: "en",
      body: "FOREIGN DOMAIN OVERRIDE",
      overridesVersion: "1.0.0",
      baselineVersion: PROMPT_VERSION_MANIFEST.heartbeat,
    });
    const result = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      db,
    });
    expect(result.override).toBeNull();
    const baseline = loadPrompt({ name: "heartbeat", locale: "en" });
    expect(result.body).toBe(baseline.body);
  });

  it("returns the result type shape that downstream callers depend on (LoadedPromptWithOverride)", async () => {
    const result: LoadedPromptWithOverride = await loadPromptForScope({
      name: "heartbeat",
      locale: "en",
      domainId: scopes.domainId,
      db,
    });
    // Compile-time check via the type annotation above + a
    // runtime sanity check that the new fields are present.
    expect(typeof result.body).toBe("string");
    expect(typeof result.version).toBe("string");
    expect(result.locale).toBe("en");
    expect(result.name).toBe("heartbeat");
    expect(result.override === null || typeof result.override === "object").toBe(
      true,
    );
  });
});
