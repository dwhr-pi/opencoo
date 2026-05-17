/**
 * pglite test fixture for compiler tests. Extends the classifier
 * fixture with `sources_bindings`, `agent_runs`, and `page_citations`
 * — the three additional tables the compiler reads/writes.
 *
 * Same approach as the classifier fixture: mirror just the DDL
 * needed (CLAUDE.md schema-ownership keeps the source-of-truth
 * pgTable in @opencoo/shared/db/schema). The fixture relaxes some
 * production FK relationships (notably agent_runs ← agent_instances)
 * because the compiler tests don't exercise those join paths.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import * as schema from "@opencoo/shared/db/schema";

export type CompilerTestDb = PgliteDatabase<typeof schema>;

const DDL = `
  -- enums
  CREATE TYPE intake_status AS ENUM ('pending', 'classified', 'skipped');
  CREATE TYPE error_class AS ENUM ('transient', 'upstream-quota', 'validation');
  CREATE TYPE domain_class AS ENUM ('knowledge', 'catalog-workflows', 'catalog-skills');
  CREATE TYPE governance_cadence AS ENUM ('continuous', 'weekly', 'monthly');
  CREATE TYPE review_mode AS ENUM ('auto', 'review-required');
  CREATE TYPE llm_engine AS ENUM ('ingestion', 'self-op');
  CREATE TYPE llm_tier AS ENUM ('thinker', 'worker', 'light');
  CREATE TYPE agent_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed');
  CREATE TYPE agent_trigger AS ENUM ('schedule', 'webhook', 'manual', 'pipeline');

  -- minimal domains
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

  -- sources_bindings — compiler reads it to attribute page_citations
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
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- agent_runs (FK target only; relaxed: no instance_id FK in tests)
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

  -- page_citations (compiler appends one row per source attribution)
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
  CREATE INDEX page_citations_domain_slug_page_path_idx
    ON page_citations (domain_slug, page_path);
  CREATE INDEX page_citations_source_binding_id_idx
    ON page_citations (source_binding_id);

  -- llm_usage (router writes one row per call)
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

  -- llm_usage_debug (router writes one row per call when LLM_DEBUG_LOG=1)
  CREATE TABLE llm_usage_debug (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    usage_id uuid NOT NULL REFERENCES llm_usage(id) ON DELETE CASCADE,
    prompt_text text NOT NULL,
    response_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- prompt_overrides (PR-W1 phase-a appendix #15) — source for
  -- mergePage loadPromptForScope reads. The fixture starts with
  -- zero rows so every default mergePage call resolves to the
  -- shipped baseline; tests that exercise the override path
  -- insert a row before invoking the function.
  CREATE TABLE prompt_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    instance_id uuid,
    prompt_name text NOT NULL,
    locale text NOT NULL CHECK (locale IN ('en','pl')),
    body text NOT NULL CHECK (length(body) <= 100000),
    overrides_version text NOT NULL,
    baseline_version text NOT NULL,
    updated_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prompt_overrides_scope_unique UNIQUE NULLS NOT DISTINCT (domain_id, instance_id, prompt_name, locale)
  );
`;

export interface CompilerFixture {
  readonly db: CompilerTestDb;
  readonly domainId: string;
  readonly bindingId: string;
}

export async function freshCompilerDb(): Promise<CompilerFixture> {
  const pg = new PGlite();
  await pg.exec(DDL);
  const db: CompilerTestDb = drizzle(pg, { schema });

  const domainResult = await pg.query<{ id: string }>(
    `INSERT INTO domains (slug, name) VALUES ('test-domain', 'Test Domain') RETURNING id`,
  );
  const domainId = domainResult.rows[0]!.id;
  const bindingResult = await pg.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug) VALUES ($1, 'drive') RETURNING id`,
    [domainId],
  );
  const bindingId = bindingResult.rows[0]!.id;

  return { db, domainId, bindingId };
}
