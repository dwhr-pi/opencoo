/**
 * `opencoo agents seed` tests (PR-M2, phase-a appendix #5).
 *
 * Pins:
 *   - Idempotent: running twice inserts default rows on the first
 *     run + reports zero new rows on the second.
 *   - Only seeds definitions that carry `defaultScheduleCron`. The
 *     scheduled-class set in v0.1 is Heartbeat / Lint / Surfacer.
 *   - Each row gets `enabled = true`, empty scope, no output
 *     channels, locale `en`, and the `defaultScheduleCron` value.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@opencoo/shared/db/schema";

import {
  ExitSentinel,
  __resetProcessExit,
  __setProcessExit,
} from "../src/lib/exit.js";
import {
  runAgentsSeed,
  type AgentsSeedArgs,
} from "../src/commands/agents-seed.js";

class CapturingStream {
  buffer = "";
  write = (s: string): boolean => {
    this.buffer += s;
    return true;
  };
}

afterEach(() => {
  __resetProcessExit();
});

function captureExit(): { code: number | null } {
  const cap: { code: number | null } = { code: null };
  __setProcessExit(((code: number) => {
    cap.code = code;
    throw new ExitSentinel(code);
  }) as never);
  return cap;
}

function buildEnumsDdl(): string {
  const lines: string[] = [];
  for (const value of Object.values(schema)) {
    if (isPgEnum(value)) {
      const e = value as PgEnum<[string, ...string[]]>;
      const literals = e.enumValues
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ");
      lines.push(`CREATE TYPE "${e.enumName}" AS ENUM (${literals});`);
    }
  }
  return lines.join("\n");
}

const TABLES_DDL = `
  CREATE TABLE agent_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    definition_slug text NOT NULL,
    name text NOT NULL,
    scope_domain_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    output_channel_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    schedule_cron text,
    memory jsonb DEFAULT '{}'::jsonb NOT NULL,
    locale text DEFAULT 'en' NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_instances_definition_slug_name_unique UNIQUE (definition_slug, name)
  );
`;

interface SeedArgsBuilder {
  readonly args: AgentsSeedArgs;
  readonly stdout: CapturingStream;
  readonly stderr: CapturingStream;
  readonly db: ReturnType<typeof drizzle>;
}

async function buildSeedArgs(): Promise<SeedArgsBuilder> {
  const pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(TABLES_DDL);
  const db = drizzle(pg);
  const stdout = new CapturingStream();
  const stderr = new CapturingStream();
  const args: AgentsSeedArgs = {
    env: { DATABASE_URL: "postgres://stub/0" },
    stdout,
    stderr,
    dbFactory: () => db as unknown as ReturnType<AgentsSeedArgs["dbFactory"] & object>,
    closePool: async () => undefined,
  };
  return { args, stdout, stderr, db };
}

describe("opencoo agents seed", () => {
  it("inserts one row per scheduled-class definition on first run", async () => {
    const { args, stdout, db } = await buildSeedArgs();
    captureExit();
    await expect(runAgentsSeed(args)).rejects.toThrow(ExitSentinel);

    const result = (await db.execute(sql`
      SELECT definition_slug, name, schedule_cron, enabled
      FROM agent_instances
      ORDER BY definition_slug
    `)) as unknown as {
      rows: Array<{
        definition_slug: string;
        name: string;
        schedule_cron: string | null;
        enabled: boolean;
      }>;
    };
    // Heartbeat / Lint / Surfacer.
    expect(result.rows).toHaveLength(3);
    const bySlug = new Map(result.rows.map((r) => [r.definition_slug, r]));
    expect(bySlug.get("heartbeat")?.schedule_cron).toBe("0 8 * * 1-5");
    expect(bySlug.get("lint")?.schedule_cron).toBe("0 9 * * 1");
    expect(bySlug.get("surfacer")?.schedule_cron).toBe("0 7 * * *");
    for (const row of result.rows) {
      expect(row.enabled).toBe(true);
      expect(row.name).toContain("default");
    }
    expect(stdout.buffer).toContain("3");
  });

  it("is idempotent: a second run inserts 0 new rows", async () => {
    const { args, db, stdout } = await buildSeedArgs();
    captureExit();
    await expect(runAgentsSeed(args)).rejects.toThrow(ExitSentinel);
    // Reset stdout for the second run's output assertion.
    (stdout as { buffer: string }).buffer = "";
    __resetProcessExit();
    captureExit();
    await expect(runAgentsSeed(args)).rejects.toThrow(ExitSentinel);

    const result = (await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM agent_instances
    `)) as unknown as { rows: Array<{ total: number }> };
    // Still 3 — no duplicates created.
    expect(result.rows[0]?.total).toBe(3);
    // The second-run stdout includes a "0 created" report.
    expect(stdout.buffer).toMatch(/0 created|already seeded|0 new/i);
  });

  it("does NOT seed agents without a defaultScheduleCron (chat/builder)", async () => {
    const { args, db } = await buildSeedArgs();
    captureExit();
    await expect(runAgentsSeed(args)).rejects.toThrow(ExitSentinel);
    const result = (await db.execute(sql`
      SELECT definition_slug FROM agent_instances
    `)) as unknown as { rows: Array<{ definition_slug: string }> };
    const slugs = result.rows.map((r) => r.definition_slug);
    expect(slugs).not.toContain("chat");
    expect(slugs).not.toContain("builder");
  });
});
