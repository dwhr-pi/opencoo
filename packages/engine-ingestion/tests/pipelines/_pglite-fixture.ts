/**
 * pglite test fixture for pipelines tests. Extends the compiler
 * fixture with the additional rows the scanner / cleanup /
 * compilation-worker pipelines exercise.
 *
 * Enum DDL is generated dynamically from `@opencoo/shared/db/schema`
 * (copilot #19): walk every export, keep the ones drizzle's
 * `isPgEnum` recognises, and CREATE TYPE … AS ENUM(...) from
 * each one's `enumName` + `enumValues`. This eliminates the
 * "fixture diverges from schema" drift class — every enum we
 * own (and every value within it) flows from the source-of-truth
 * file, no hand-typed copies in this test file to chase when
 * schema changes.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";

import * as schema from "@opencoo/shared/db/schema";

export type PipelineTestDb = PgliteDatabase<typeof schema>;

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
  -- domains
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- users (mirrors @opencoo/shared/db/schema/users.ts: gitea_username + role
  -- per copilot #19; the previous email/name DDL was wrong).
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    gitea_username text NOT NULL UNIQUE,
    role user_role DEFAULT 'operator' NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- sources_bindings — includes the new last_scan_cursor column
  CREATE TABLE sources_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    adapter_slug text NOT NULL,
    source_id text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    allowed_paths text[] DEFAULT '{}'::text[] NOT NULL,
    review_mode review_mode DEFAULT 'auto' NOT NULL,
    schedule_cron text,
    credentials_id uuid,
    retention_days_override integer,
    enabled boolean DEFAULT true NOT NULL,
    last_scanned_at timestamp with time zone,
    last_scan_cursor text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- ingestion_intake (scanner appends here)
  CREATE TABLE ingestion_intake (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    source_doc_id text NOT NULL,
    source_revision text NOT NULL,
    content_hash text NOT NULL,
    status intake_status DEFAULT 'pending' NOT NULL,
    last_classifier_run_id text,
    error_class error_class,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ingestion_intake_binding_doc_revision_unique UNIQUE (binding_id, source_doc_id, source_revision)
  );

  -- agent_runs (FK target only)
  CREATE TABLE agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    definition_slug text NOT NULL,
    instance_id uuid,
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

  -- page_citations (cleanup invariant table — must NOT be touched by Cleanup)
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

  -- redaction_events (cleanup invariant table)
  CREATE TABLE redaction_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    pipeline text NOT NULL,
    domain_id uuid REFERENCES domains(id) ON DELETE RESTRICT,
    binding_id uuid REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    guard_slug text NOT NULL,
    category text NOT NULL,
    pattern_version text NOT NULL,
    matched_byte_ranges jsonb NOT NULL,
    fail_mode guard_fail_mode NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- erasure_log (cleanup invariant table)
  CREATE TABLE erasure_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    action erasure_action NOT NULL,
    target_ref text NOT NULL,
    executed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- miner_suppressions (cleanup invariant table)
  CREATE TABLE miner_suppressions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    miner_binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    candidate_ref text NOT NULL,
    reason text,
    suppressed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- llm_usage (parent for llm_usage_debug)
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

  -- llm_usage_debug (Cleanup target)
  CREATE TABLE llm_usage_debug (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    usage_id uuid NOT NULL REFERENCES llm_usage(id) ON DELETE CASCADE,
    prompt_text text NOT NULL,
    response_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
`;

export interface PipelineFixture {
  readonly db: PipelineTestDb;
  readonly raw: PGlite;
  readonly domainId: string;
  readonly bindingId: string;
}

export interface FreshOptions {
  readonly retentionDays?: number;
  readonly reviewRole?: string;
}

export async function freshPipelineDb(
  opts: FreshOptions = {},
): Promise<PipelineFixture> {
  const pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(TABLES_DDL);
  const db: PipelineTestDb = drizzle(pg, { schema });

  const domainResult = await pg.query<{ id: string }>(
    `INSERT INTO domains (slug, name, retention_days, review_role) VALUES ('test-domain', 'Test Domain', $1, $2) RETURNING id`,
    [opts.retentionDays ?? null, opts.reviewRole ?? null],
  );
  const domainId = domainResult.rows[0]!.id;
  const bindingResult = await pg.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, allowed_paths) VALUES ($1, 'drive', $2) RETURNING id`,
    [domainId, ["strategy/**", "executive/**"]],
  );
  const bindingId = bindingResult.rows[0]!.id;

  return { db, raw: pg, domainId, bindingId };
}
