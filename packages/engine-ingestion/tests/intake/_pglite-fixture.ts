/**
 * pglite test fixture for intake tests. Spins up a fresh in-process
 * Postgres with the minimum set of tables `recordIntake` /
 * `recordWebhook` need: domains, credentials, sources_bindings,
 * webhook_events, ingestion_intake. Per CLAUDE.md schema-ownership,
 * the source-of-truth schema lives in @opencoo/shared/db/schema —
 * we mirror just the DDL needed for this package's tests.
 *
 * pglite is real Postgres (gen_random_uuid, JSONB, UNIQUE indexes
 * with WHERE clauses, MERGE-like ON CONFLICT) so the constraints
 * we exercise behave exactly as in production.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import * as schema from "@opencoo/shared/db/schema";

export type IntakeTestDb = PgliteDatabase<typeof schema>;

const DDL = `
  -- enums (only those PR-14 tables reference)
  CREATE TYPE intake_status AS ENUM ('pending', 'classified', 'skipped');
  CREATE TYPE webhook_status AS ENUM ('pending', 'classified', 'skipped', 'invalid');
  CREATE TYPE error_class AS ENUM ('transient', 'upstream-quota', 'validation');
  CREATE TYPE domain_class AS ENUM ('knowledge', 'catalog-workflows', 'catalog-skills');
  CREATE TYPE governance_cadence AS ENUM ('continuous', 'weekly', 'monthly');
  CREATE TYPE review_mode AS ENUM ('auto', 'review-required');

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

  -- minimal credentials
  CREATE TABLE credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    schema_ref text NOT NULL,
    ciphertext bytea NOT NULL,
    iv bytea NOT NULL,
    aad bytea NOT NULL,
    encryption_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone
  );

  -- sources_bindings — FK to domains kept (load-bearing for the
  -- intake tests). The credentials_id FK is intentionally dropped
  -- here: tests use InMemoryCredentialStore (in-memory, not backed
  -- by the DB credentials table), so the binding's credentials_id
  -- column just stores the in-memory store's UUID. Production
  -- DDL keeps the FK; the test fixture relaxes it for ergonomics.
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

  -- ingestion_intake (3-column UNIQUE)
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

  -- webhook_events (partial UNIQUE on (provider, event_id))
  CREATE TABLE webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    event_id text,
    payload_hash text NOT NULL,
    payload jsonb,
    signature_ok boolean NOT NULL,
    binding_id uuid REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    delivery_count integer DEFAULT 1 NOT NULL,
    status webhook_status DEFAULT 'pending' NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX webhook_events_provider_event_id_unique ON webhook_events (provider, event_id) WHERE event_id IS NOT NULL;
`;

export interface IntakeFixture {
  readonly db: IntakeTestDb;
  readonly bindingId: string;
  readonly domainId: string;
}

export async function freshIntakeDb(): Promise<IntakeFixture> {
  const pg = new PGlite();
  await pg.exec(DDL);
  const db: IntakeTestDb = drizzle(pg, { schema });

  // Seed one domain + one binding so tests have a valid FK target.
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
