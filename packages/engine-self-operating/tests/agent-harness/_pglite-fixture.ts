/**
 * pglite test fixture for agent-harness tests. Uses the same
 * shared-schema-driven pattern as the engine-ingestion pipeline
 * fixture (PR 17 copilot followup): walk every PgEnum exported
 * from `@opencoo/shared/db/schema` and emit
 * `CREATE TYPE … AS ENUM(...)` so the fixture stays in lockstep
 * with the source-of-truth schema, plus the table DDL for
 * domains, agent_definitions, agent_instances, agent_runs,
 * llm_usage(+_debug) — the four tables the harness reads/writes.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";

import * as schema from "@opencoo/shared/db/schema";

export type AgentTestDb = PgliteDatabase<typeof schema>;

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
  -- domains (FK target via agent_runs, llm_usage)
  CREATE TABLE domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    class domain_class DEFAULT 'knowledge' NOT NULL,
    locale text DEFAULT 'en' NOT NULL,
    governance_cadence governance_cadence DEFAULT 'continuous' NOT NULL,
    review_role text,
    llm_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    llm_budget_monthly_cap_usd numeric(10, 2),
    retention_days integer,
    worldview_enabled boolean DEFAULT true NOT NULL,
    is_aggregator boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- agent_definitions (metadata mirror — harness UPSERTs at boot)
  CREATE TABLE agent_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL UNIQUE,
    version text NOT NULL,
    description text NOT NULL,
    output_schema_name text NOT NULL,
    default_memory jsonb DEFAULT '{}'::jsonb NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- agent_instances
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

  -- agent_runs (the carve-out target — single guarded UPDATE)
  CREATE TABLE agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    definition_slug text NOT NULL,
    instance_id uuid NOT NULL REFERENCES agent_instances(id) ON DELETE RESTRICT,
    trigger agent_trigger NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    output jsonb,
    skills_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    tokens_in integer DEFAULT 0 NOT NULL,
    tokens_out integer DEFAULT 0 NOT NULL,
    cost_usd numeric(10, 6) DEFAULT '0' NOT NULL,
    latency_ms integer DEFAULT 0 NOT NULL,
    status agent_run_status NOT NULL,
    error_class error_class,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- llm_usage (LlmRouter writes here when the harness invokes it)
  CREATE TABLE llm_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    timestamp timestamp with time zone DEFAULT now() NOT NULL,
    engine llm_engine NOT NULL,
    tier llm_tier NOT NULL,
    model text NOT NULL,
    pipeline_or_agent text NOT NULL,
    document_id text,
    run_id uuid,
    domain_id uuid REFERENCES domains(id) ON DELETE SET NULL,
    tokens_in integer NOT NULL,
    tokens_out integer NOT NULL,
    cost_usd numeric(10, 6) NOT NULL,
    latency_ms integer NOT NULL,
    prompt_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE llm_usage_debug (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    usage_id uuid NOT NULL REFERENCES llm_usage(id) ON DELETE CASCADE,
    prompt_text text NOT NULL,
    response_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- credentials (FK target for sources_bindings; minimal shape
  -- — real schema has more columns, the lint orchestrator
  -- doesn't read them).
  CREATE TABLE credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- sources_bindings (Lint wildcard-bindings detector reads this).
  CREATE TABLE sources_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    adapter_slug text NOT NULL,
    source_id text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    allowed_paths text[] DEFAULT '{}'::text[] NOT NULL,
    review_mode review_mode DEFAULT 'auto' NOT NULL,
    schedule_cron text,
    credentials_id uuid REFERENCES credentials(id) ON DELETE RESTRICT,
    retention_days_override integer,
    enabled boolean DEFAULT true NOT NULL,
    last_scanned_at timestamp with time zone,
    last_scan_cursor text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- ingestion_intake (Heartbeat system-health gatherer reads
  -- per-status counts + per-binding failed-row diagnostics
  -- against this. PR-W6 phase-a appendix #14. The status
  -- column is stored as TEXT in the fixture (rather than the
  -- intake_status enum) so the test stays enum-tolerant
  -- across W3 which adds the failed value to the enum. The
  -- gatherer's status text-cast comparison works regardless
  -- of whether the enum has the value yet, but the fixture
  -- itself could not pre-populate rows with status=failed via
  -- the enum cast unless failed is in the enum. Storing as
  -- TEXT lets the fixture seed any status the test needs
  -- without depending on W3 having merged.
  CREATE TABLE ingestion_intake (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    source_doc_id text NOT NULL,
    source_revision text NOT NULL,
    content_hash text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    last_classifier_run_id text,
    error_class error_class,
    error_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- page_citations (Lint stale-pages / orphans / prompt-drift
  -- detectors aggregate over this).
  CREATE TABLE page_citations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_slug text NOT NULL,
    page_path text NOT NULL,
    source_binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    source_ref text NOT NULL,
    compiled_by_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
    prompt_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- users (FK target for automation_candidates.reviewed_by;
  -- minimal shape — real schema has more columns).
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- automation_candidates (PR 21 / plan #102 — Surfacer + Builder).
  CREATE TABLE automation_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    surfacer_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
    source_page_refs jsonb NOT NULL,
    proposal jsonb NOT NULL,
    status automation_candidate_status NOT NULL DEFAULT 'proposed',
    rationale text,
    reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- automation_deployments (Builder writes here at deploy time).
  CREATE TABLE automation_deployments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    candidate_id uuid NOT NULL REFERENCES automation_candidates(id) ON DELETE RESTRICT,
    builder_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
    n8n_workflow_id text NOT NULL UNIQUE,
    skills_used_snapshot jsonb NOT NULL,
    status automation_deployment_status NOT NULL DEFAULT 'deployed',
    deployed_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    last_observed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
`;

export interface AgentFixture {
  readonly db: AgentTestDb;
  readonly raw: PGlite;
  readonly domainId: string;
}

export interface FreshOptions {
  readonly definitionSlug?: string;
  readonly instanceName?: string;
  readonly memory?: Record<string, unknown>;
  /** Scheduler tests use this; defaults to NULL (no schedule). */
  readonly scheduleCron?: string | null;
  /** Defaults to true. Tests that exercise the scheduler's
   *  enabled-row filter pass `false` here. */
  readonly enabled?: boolean;
}

export interface SeededInstance {
  readonly instanceId: string;
  readonly definitionSlug: string;
}

export async function freshAgentDb(): Promise<AgentFixture> {
  const pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(TABLES_DDL);
  const db: AgentTestDb = drizzle(pg, { schema });

  const domainResult = await pg.query<{ id: string }>(
    `INSERT INTO domains (slug, name) VALUES ('test-domain', 'Test Domain') RETURNING id`,
  );
  const domainId = domainResult.rows[0]!.id;

  return { db, raw: pg, domainId };
}

export async function seedAgentInstance(
  fixture: AgentFixture,
  opts: FreshOptions = {},
): Promise<SeededInstance> {
  const definitionSlug = opts.definitionSlug ?? "heartbeat";
  const instanceName = opts.instanceName ?? "default";
  const memory = JSON.stringify(opts.memory ?? { type: "none" });
  const enabled = opts.enabled ?? true;
  const scheduleCron = opts.scheduleCron ?? null;
  const result = await fixture.raw.query<{ id: string }>(
    `INSERT INTO agent_instances
       (definition_slug, name, scope_domain_ids, memory, locale, enabled, schedule_cron)
     VALUES ($1, $2, $3::uuid[], $4::jsonb, 'en', $5, $6)
     RETURNING id`,
    [
      definitionSlug,
      instanceName,
      [fixture.domainId],
      memory,
      enabled,
      scheduleCron,
    ],
  );
  return { instanceId: result.rows[0]!.id, definitionSlug };
}

export interface SeedBindingArgs {
  readonly adapterSlug?: string;
  readonly allowedPaths: readonly string[];
  readonly enabled?: boolean;
}

/** Seed one source binding for the fixture's default domain. Used by
 *  the Lint orchestrator integration test. */
export async function seedBinding(
  fixture: AgentFixture,
  args: SeedBindingArgs,
): Promise<{ readonly bindingId: string }> {
  const result = await fixture.raw.query<{ id: string }>(
    `INSERT INTO sources_bindings
       (domain_id, adapter_slug, allowed_paths, enabled)
     VALUES ($1::uuid, $2, $3::text[], $4)
     RETURNING id`,
    [
      fixture.domainId,
      args.adapterSlug ?? "drive",
      args.allowedPaths,
      args.enabled ?? true,
    ],
  );
  return { bindingId: result.rows[0]!.id };
}

export interface SeedCitationArgs {
  readonly domainSlug?: string;
  readonly pagePath: string;
  readonly bindingId: string;
  readonly promptVersion?: string;
  /** Seconds-ago for the row's created_at — supports stale-page tests. */
  readonly createdSecondsAgo?: number;
}

/** Seed one page_citations row for the fixture's default domain. */
export async function seedPageCitation(
  fixture: AgentFixture,
  args: SeedCitationArgs,
): Promise<void> {
  const createdAt = args.createdSecondsAgo
    ? `NOW() - INTERVAL '${args.createdSecondsAgo} seconds'`
    : "NOW()";
  await fixture.raw.query(
    `INSERT INTO page_citations
       (domain_slug, page_path, source_binding_id, source_ref, prompt_version, created_at)
     VALUES ($1, $2, $3::uuid, $4, $5, ${createdAt})`,
    [
      args.domainSlug ?? "test-domain",
      args.pagePath,
      args.bindingId,
      `gdrive://test-${args.pagePath}`,
      args.promptVersion ?? null,
    ],
  );
}
