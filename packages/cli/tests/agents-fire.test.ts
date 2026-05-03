/**
 * `opencoo agents fire <slug>` tests (PR-O2, phase-a appendix #7).
 *
 * Pins:
 *   - Slug → instance resolution (single hit / 0 hits / 2 hits /
 *     `--instance-id` override / `--instance-id` slug mismatch /
 *     disabled rows are not picked).
 *   - Dry-run prints the row + runner-presence; does NOT invoke
 *     the harness; exits 0.
 *   - Fire path invokes the harness with `trigger='http'` +
 *     `inputs.firedBy='cli'`; exits 0. The `agent_trigger`
 *     Postgres enum is `('scheduled', 'http', 'mcp')` in v0.1
 *     — no `'manual'` value, and PR-O2 explicitly avoids a
 *     schema migration. `firedBy='cli'` is the precise audit
 *     discriminator vs admin-API HTTP runs.
 *   - `bundle.close()` runs in finally on every code path
 *     (boot-tolerance, slug-resolution failure, runner missing,
 *     happy path).
 *   - Bundle null (composeBundle returns null) → stderr message +
 *     exit 2; no DB query attempted.
 *   - Runner missing for resolved slug → exit 1 with the
 *     Surfacer-omitted hint pointing at runbook §8.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as schema from "@opencoo/shared/db/schema";

import {
  ExitSentinel,
  __resetProcessExit,
  __setProcessExit,
} from "../src/lib/exit.js";
import {
  runAgentsFire,
  type AgentsFireArgs,
} from "../src/commands/agents-fire.js";

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

interface SeedRow {
  readonly definitionSlug: string;
  readonly name: string;
  readonly scheduleCron?: string | null;
  readonly enabled?: boolean;
}

interface FixtureBuilder {
  readonly db: ReturnType<typeof drizzle>;
  readonly pg: PGlite;
  readonly seed: (rows: ReadonlyArray<SeedRow>) => Promise<readonly string[]>;
  readonly close: () => Promise<void>;
}

async function makeDbFixture(): Promise<FixtureBuilder> {
  const pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(TABLES_DDL);
  const db = drizzle(pg);
  return {
    db,
    pg,
    seed: async (rows): Promise<readonly string[]> => {
      const ids: string[] = [];
      for (const r of rows) {
        const result = (await db.execute(sql`
          INSERT INTO agent_instances
            (definition_slug, name, schedule_cron, enabled)
          VALUES (
            ${r.definitionSlug},
            ${r.name},
            ${r.scheduleCron ?? "0 8 * * 1-5"},
            ${r.enabled ?? true}
          )
          RETURNING id::text AS id
        `)) as unknown as { rows: Array<{ id: string }> };
        const id = result.rows[0]?.id;
        if (id === undefined) throw new Error("seed insert returned no id");
        ids.push(id);
      }
      return ids;
    },
    close: async (): Promise<void> => {
      await pg.close();
    },
  };
}

interface BundleStub {
  readonly bundle: {
    readonly pgPool: unknown;
    readonly router: unknown;
    readonly definitions: unknown;
    readonly mcp: unknown;
    readonly runners: { get(slug: string): unknown };
    close: () => Promise<void>;
  };
  readonly closeSpy: ReturnType<typeof vi.fn>;
}

function makeBundleStub(args: {
  readonly db: unknown;
  readonly registeredRunners?: ReadonlyArray<string>;
}): BundleStub {
  const closeSpy = vi.fn(async () => undefined);
  const registered = new Set(args.registeredRunners ?? ["heartbeat", "lint"]);
  const bundle = {
    pgPool: args.db,
    router: { __id: "router-stub" },
    definitions: { __id: "defs-stub" },
    mcp: { __id: "mcp-stub" },
    runners: {
      get(slug: string): unknown {
        return registered.has(slug)
          ? async (): Promise<unknown> => ({ ok: true })
          : undefined;
      },
    },
    close: closeSpy,
  };
  return { bundle, closeSpy };
}

function buildArgs(
  overrides: Partial<AgentsFireArgs>,
  ctx?: { readonly fx?: FixtureBuilder },
): {
  readonly args: AgentsFireArgs;
  readonly stdout: CapturingStream;
  readonly stderr: CapturingStream;
} {
  const stdout = new CapturingStream();
  const stderr = new CapturingStream();
  const base = {
    env: {} as Record<string, string | undefined>,
    stdout,
    stderr,
    slug: "heartbeat",
    // Default seam: route Pool→Db through the test fixture's
    // pglite-backed drizzle handle. Tests that pass a null bundle
    // (boot-tolerance) skip this seam since the impl never reaches
    // the wrap.
    ...(ctx?.fx !== undefined
      ? { dbFromPool: ((): unknown => ctx.fx!.db) as AgentsFireArgs["dbFromPool"] }
      : {}),
  };
  return {
    args: { ...base, ...overrides } as AgentsFireArgs,
    stdout,
    stderr,
  };
}

describe("opencoo agents fire — slug resolution", () => {
  it("dry-run reports the resolved instance + runner-registered, no invokeAgent call, exit 0", async () => {
    const fx = await makeDbFixture();
    try {
      const [instanceId] = await fx.seed([
        { definitionSlug: "heartbeat", name: "heartbeat-default" },
      ]);
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat", "lint"],
      });
      const invokeAgentFn = vi.fn(async () => ({
        runId: "ignored",
        status: "success" as const,
        output: {},
      }));
      const cap = captureExit();
      const { args, stdout } = buildArgs(
        {
          slug: "heartbeat",
          dryRun: true,
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(0);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(stdout.buffer).toContain("heartbeat");
      expect(stdout.buffer).toContain(instanceId ?? "");
      // The dry-run printer right-pads the label column for
      // alignment; assert the value substring rather than the
      // exact spacing so cosmetic tweaks don't break the test.
      expect(stdout.buffer).toMatch(/runner:\s+registered/);
    } finally {
      await fx.close();
    }
  });

  it("fire path invokes invokeAgent with trigger=http + firedBy=cli + the resolved instance id, exit 0", async () => {
    const fx = await makeDbFixture();
    try {
      const [instanceId] = await fx.seed([
        { definitionSlug: "heartbeat", name: "heartbeat-default" },
      ]);
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat", "lint"],
      });
      const invokeAgentFn = vi.fn(async () => ({
        runId: "00000000-0000-0000-0000-0000000000aa",
        status: "success" as const,
        output: {},
      }));
      const cap = captureExit();
      const { args, stdout } = buildArgs(
        {
          slug: "heartbeat",
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(0);
      expect(invokeAgentFn).toHaveBeenCalledTimes(1);
      const callArg = invokeAgentFn.mock.calls[0]?.[0] as
        | { trigger: string; inputs: Record<string, unknown>; instanceId: string }
        | undefined;
      // The agent_trigger Postgres enum is ('scheduled', 'http',
      // 'mcp') in v0.1 — no schema migration in this PR. CLI runs
      // use 'http' as the closest fit (operator-driven, not cron).
      // `inputs.firedBy === 'cli'` is the precise audit
      // discriminator vs admin-API-triggered HTTP runs.
      expect(callArg?.trigger).toBe("http");
      expect(callArg?.inputs).toEqual({ firedBy: "cli", slug: "heartbeat" });
      expect(callArg?.instanceId).toBe(instanceId);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(stdout.buffer).toContain("heartbeat");
      expect(stdout.buffer).toContain("dispatched");
      expect(stdout.buffer).toContain("00000000-0000-0000-0000-0000000000aa");
      expect(stdout.buffer).toContain("success");
    } finally {
      await fx.close();
    }
  });

  it("no enabled instance found → exit 1 with `agents seed` hint, no invokeAgent call", async () => {
    const fx = await makeDbFixture();
    try {
      const { bundle, closeSpy } = makeBundleStub({ db: fx.db });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbeat",
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(stderr.buffer).toMatch(/no enabled instance found/);
      expect(stderr.buffer).toContain("agents seed");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fx.close();
    }
  });

  it("multiple enabled instances → exit 1 + suggests --instance-id, no invokeAgent call", async () => {
    const fx = await makeDbFixture();
    try {
      const ids = await fx.seed([
        { definitionSlug: "heartbeat", name: "heartbeat-default" },
        { definitionSlug: "heartbeat", name: "heartbeat-extra" },
      ]);
      const { bundle, closeSpy } = makeBundleStub({ db: fx.db });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbeat",
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(stderr.buffer).toMatch(/multiple enabled instances/);
      expect(stderr.buffer).toContain("--instance-id");
      // Both ids must appear so the operator can pick.
      expect(stderr.buffer).toContain(ids[0] ?? "");
      expect(stderr.buffer).toContain(ids[1] ?? "");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fx.close();
    }
  });

  it("--instance-id resolves correctly when multiple instances exist for the slug", async () => {
    const fx = await makeDbFixture();
    try {
      const ids = await fx.seed([
        { definitionSlug: "heartbeat", name: "heartbeat-default" },
        { definitionSlug: "heartbeat", name: "heartbeat-extra" },
      ]);
      const second = ids[1];
      if (second === undefined) throw new Error("seed missing second id");
      const { bundle } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat"],
      });
      const invokeAgentFn = vi.fn(async () => ({
        runId: "00000000-0000-0000-0000-0000000000bb",
        status: "success" as const,
        output: {},
      }));
      const cap = captureExit();
      const { args } = buildArgs(
        {
          slug: "heartbeat",
          instanceId: second,
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(0);
      expect(invokeAgentFn).toHaveBeenCalledTimes(1);
      const callArg = invokeAgentFn.mock.calls[0]?.[0] as
        | { instanceId: string }
        | undefined;
      expect(callArg?.instanceId).toBe(second);
    } finally {
      await fx.close();
    }
  });

  it("--instance-id with mismatched slug → exit 1 with mismatch message, no invokeAgent call", async () => {
    const fx = await makeDbFixture();
    try {
      const [hbId] = await fx.seed([
        { definitionSlug: "heartbeat", name: "heartbeat-default" },
      ]);
      const id = hbId;
      if (id === undefined) throw new Error("seed missing id");
      const { bundle } = makeBundleStub({ db: fx.db });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "lint",
          instanceId: id,
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(stderr.buffer).toContain("definition_slug=heartbeat");
      expect(stderr.buffer).toContain("requested fire on lint");
    } finally {
      await fx.close();
    }
  });

  it("disabled instance is NOT picked (the WHERE enabled=true filter)", async () => {
    const fx = await makeDbFixture();
    try {
      await fx.seed([
        {
          definitionSlug: "heartbeat",
          name: "heartbeat-default",
          enabled: false,
        },
      ]);
      const { bundle } = makeBundleStub({ db: fx.db });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbeat",
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(stderr.buffer).toMatch(/no enabled instance found/);
    } finally {
      await fx.close();
    }
  });

  it("--instance-id pointing at a DISABLED row → exit 1 with not-found message, no invokeAgent call", async () => {
    // Mirrors the slug-only "disabled instance is NOT picked" pin
    // for the explicit `--instance-id <uuid>` path. `loadInstanceById`
    // carries `WHERE enabled = true` (instances.ts:86) so a disabled
    // row throws AgentInstanceNotFoundError; the CLI translates that
    // into the "not found (or disabled)" stderr message. Without
    // this test the disabled-via-id branch was uncovered (the slug
    // path tests the SELECT filter; this tests the loadInstanceById
    // filter).
    const fx = await makeDbFixture();
    try {
      const [disabledId] = await fx.seed([
        {
          definitionSlug: "heartbeat",
          name: "heartbeat-default",
          enabled: false,
        },
      ]);
      const id = disabledId;
      if (id === undefined) throw new Error("seed missing id");
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat"],
      });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbeat",
          instanceId: id,
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(stderr.buffer).toMatch(/not found \(or disabled\)/);
      expect(stderr.buffer).toContain(id);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fx.close();
    }
  });

  it("--instance-id pointing at a NONEXISTENT uuid → exit 1 with not-found message, no invokeAgent call", async () => {
    const fx = await makeDbFixture();
    try {
      // Seed nothing — the table is empty so any uuid is missing.
      const missingId = "00000000-0000-0000-0000-0000000ffffe";
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat"],
      });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbeat",
          instanceId: missingId,
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(stderr.buffer).toMatch(/not found/);
      expect(stderr.buffer).toContain(missingId);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fx.close();
    }
  });

  it("--instance-id with a malformed (non-uuid) value → exit 1 with `invalid uuid` message", async () => {
    // Round-3 fix #1 (UUID upfront-validation): a typo like
    // `--instance-id heartbeat-default` (operator confusing
    // `name` for `id`) used to bubble a Postgres-side `invalid
    // input syntax for type uuid` through the runtime-error
    // catch as exit 2. The upfront UUID check translates it into
    // a clear exit-1 user error before any DB round-trip.
    const fx = await makeDbFixture();
    try {
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat"],
      });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbeat",
          instanceId: "heartbeat-default", // not a uuid
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(stderr.buffer).toMatch(/invalid uuid/);
      expect(stderr.buffer).toContain("heartbeat-default");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fx.close();
    }
  });

  it("--instance-id resolution that throws a generic Error → outer runtime-error catch fires (exit 2)", async () => {
    // Round-3 fix #1: only AgentInstanceNotFoundError maps to
    // exit 1; every other error from loadInstanceById (DB
    // connection drop, transient pg error, etc.) re-throws so
    // the outer catch surfaces it as exit 2. Without this
    // distinction, a momentary Postgres outage looked like a
    // missing instance row and operators would chase the wrong
    // failure.
    const fx = await makeDbFixture();
    try {
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat"],
      });
      // Stub dbFromPool with a fake Db whose `execute` always
      // throws — simulates a connection-terminated-unexpectedly
      // mid-query failure.
      const fakeDb = {
        execute: async (): Promise<never> => {
          throw new Error("connection terminated unexpectedly");
        },
      };
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbeat",
          instanceId: "00000000-0000-0000-0000-0000000abcde",
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
          dbFromPool: () => fakeDb as never,
        },
        // Note: NOT passing `{ fx }` here so the dbFromPool
        // override above sticks; the buildArgs default fixture
        // override would clobber it otherwise.
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(2);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      // The outer runtime-error formatter prefixes with
      // `agents fire:` and renders the scrubbed underlying
      // message — assert both pieces.
      expect(stderr.buffer).toMatch(/agents fire:/);
      expect(stderr.buffer).toContain("connection terminated");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fx.close();
    }
  });
});

describe("opencoo agents fire — boot-tolerance + close discipline", () => {
  it("composeBundle returns null → stderr message + exit 2, no DB query", async () => {
    const invokeAgentFn = vi.fn();
    const cap = captureExit();
    const { args, stderr } = buildArgs({
      slug: "heartbeat",
      composeBundle: () => null,
      invokeAgentFn: invokeAgentFn as never,
    });
    await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
    expect(cap.code).toBe(2);
    expect(invokeAgentFn).not.toHaveBeenCalled();
    // Round-3 fix #2: the boot-tolerance message names ALL three
    // checks (DATABASE_URL + MCP_BEARER_TOKEN + compose-time logs)
    // because tryComposeAgentRunnersBundleFromEnv returns null for
    // any of them. Narrowing to MCP_BEARER_TOKEN alone misdirected
    // operators with DB-side issues.
    expect(stderr.buffer).toMatch(/agent runners unavailable/);
    expect(stderr.buffer).toContain("DATABASE_URL");
    expect(stderr.buffer).toContain("MCP_BEARER_TOKEN");
    expect(stderr.buffer).toContain("compose-time logs");
    expect(stderr.buffer).toContain("runbook §1");
  });

  it("bundle.close() runs even when the runner throws (finally discipline)", async () => {
    const fx = await makeDbFixture();
    try {
      await fx.seed([
        { definitionSlug: "heartbeat", name: "heartbeat-default" },
      ]);
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat"],
      });
      const invokeAgentFn = vi.fn(async () => {
        throw new Error("boom");
      });
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbeat",
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(2);
      expect(invokeAgentFn).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(stderr.buffer).toMatch(/runner threw/);
    } finally {
      await fx.close();
    }
  });

  it("no runner registered for the resolved slug → exit 1 with Surfacer-omitted hint", async () => {
    const fx = await makeDbFixture();
    try {
      await fx.seed([
        { definitionSlug: "surfacer", name: "surfacer-default" },
      ]);
      // Surfacer is intentionally omitted from the runner registry
      // when the template catalog is empty (appendix #6 design).
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat", "lint"],
      });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "surfacer",
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      // Round-3 fix #5: the surfacer-specific hint references
      // appendix #6 + N8N_MCP env vars + runbook §8 so the
      // operator knows the omit is by-design and how to enable it.
      expect(stderr.buffer).toMatch(/no runner registered for slug=surfacer/);
      expect(stderr.buffer).toContain("Surfacer is omitted by default");
      expect(stderr.buffer).toContain("appendix #6");
      expect(stderr.buffer).toContain("N8N_MCP");
      expect(stderr.buffer).toContain("runbook §8");
      // The generic "valid scheduled slugs" hint must NOT appear
      // when the requested slug IS surfacer.
      expect(stderr.buffer).not.toMatch(/valid scheduled slugs/);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fx.close();
    }
  });

  it("no runner registered for an unknown slug (typo) → exit 1 with generic hint, no Surfacer mention", async () => {
    // Round-3 fix #5: a typo like `agents fire heartbear` would
    // previously surface the Surfacer-specific hint, which is
    // misdirecting (the operator's slug isn't surfacer; the
    // omit reason has nothing to do with their problem). The
    // tailored generic hint lists the v0.1 valid scheduled slugs
    // so the operator can self-correct.
    const fx = await makeDbFixture();
    try {
      // Seed an agent_instances row whose definition_slug is the
      // typo — the slug-resolution path needs an instance row to
      // hit the runner-missing branch (otherwise it short-
      // circuits earlier with "no enabled instance found").
      await fx.seed([
        { definitionSlug: "heartbear", name: "heartbear-default" },
      ]);
      const { bundle, closeSpy } = makeBundleStub({
        db: fx.db,
        registeredRunners: ["heartbeat", "lint"],
      });
      const invokeAgentFn = vi.fn();
      const cap = captureExit();
      const { args, stderr } = buildArgs(
        {
          slug: "heartbear",
          composeBundle: () => bundle as never,
          invokeAgentFn: invokeAgentFn as never,
        },
        { fx },
      );
      await expect(runAgentsFire(args)).rejects.toThrow(ExitSentinel);
      expect(cap.code).toBe(1);
      expect(invokeAgentFn).not.toHaveBeenCalled();
      expect(stderr.buffer).toMatch(/no runner registered for slug=heartbear/);
      expect(stderr.buffer).toMatch(/valid scheduled slugs/);
      expect(stderr.buffer).toContain("heartbeat");
      expect(stderr.buffer).toContain("lint");
      // The Surfacer-specific hint and its appendix-#6 cross-ref
      // must NOT appear on the typo path — that's the misdirection
      // this fix removed.
      expect(stderr.buffer).not.toContain("Surfacer is omitted by default");
      expect(stderr.buffer).not.toContain("appendix #6");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await fx.close();
    }
  });
});
