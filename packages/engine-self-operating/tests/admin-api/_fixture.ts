/**
 * Test fixture for admin-API tests (PR 28 / plan #128).
 *
 * Spins up a Fastify instance with the admin-API plugin
 * registered against a pglite-backed Drizzle DB. The DB schema
 * is the real shared schema (walking PgEnum) so a regression
 * in the migration shape surfaces in this test file.
 *
 * Test seams:
 *   - `MockGiteaClient` — programmable whoami; throws when
 *     `nextWhoami` is set to an Error.
 *   - `__resetAdminAuthCache()` invoked between tests so the
 *     PAT cache from a prior assertion doesn't leak.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import Fastify, { type FastifyInstance } from "fastify";

import * as schema from "@opencoo/shared/db/schema";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  registerAdminApi,
  type GiteaClient,
  type GiteaWhoamiResult,
} from "../../src/admin-api/index.js";
import { __resetAdminAuthCache } from "../../src/admin-api/auth.js";
import type { SseBus } from "../../src/admin-api/sse-bus.js";

export type AdminTestDb = PgliteDatabase<typeof schema>;

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
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
  -- Partial UNIQUE INDEX from migration 0005 — at most one
  -- aggregator at a time. The PR-R1 soft-delete handler clears
  -- is_aggregator on disable so the operator can promote a
  -- successor without tripping this constraint; pin that
  -- behavior by mirroring the production index here.
  CREATE UNIQUE INDEX "domains_is_aggregator_singleton" ON domains (is_aggregator) WHERE is_aggregator = true;

  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    gitea_username text NOT NULL UNIQUE,
    role user_role DEFAULT 'operator' NOT NULL,
    gitea_teams jsonb DEFAULT '[]'::jsonb NOT NULL,
    gitea_teams_refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE admin_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    action text NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    metadata jsonb NOT NULL,
    source_ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE INDEX admin_audit_log_action_created_at_idx ON admin_audit_log (action, created_at);
  CREATE INDEX admin_audit_log_user_id_created_at_idx ON admin_audit_log (user_id, created_at);

  -- The InMemoryCredentialStore used in tests does NOT write to
  -- the credentials table — it persists rows in an in-process
  -- Map. The test fixture therefore omits the FK from
  -- sources_bindings.credentials_id → credentials(id) (and the
  -- corresponding webhook_secret_credentials_id FK). The real
  -- migration's FK is exercised by the schema test
  -- (sources-bindings-webhook-secret.test.ts) and by the
  -- DrizzleCredentialStore round-trip tests.
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
    webhook_secret_credentials_id uuid,
    retention_days_override integer,
    enabled boolean DEFAULT true NOT NULL,
    last_scanned_at timestamp with time zone,
    last_scan_cursor text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

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

  CREATE TABLE marketplace_updates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    marketplace_source text NOT NULL,
    release_tag text NOT NULL,
    target_commitish text NOT NULL,
    tree_sha text NOT NULL,
    skills_diff jsonb NOT NULL,
    status marketplace_update_status NOT NULL DEFAULT 'pending',
    reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketplace_updates_source_release_tag_unique UNIQUE (marketplace_source, release_tag)
  );

  -- Phase-a appendix #4 PR-A: status probing queries in the GET
  -- /api/admin/source-bindings handler reference these two tables.
  -- Including them in the base fixture so all source-binding tests
  -- work without per-test table creation.
  CREATE TABLE IF NOT EXISTS webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    event_id text,
    payload_hash text NOT NULL,
    payload jsonb,
    signature_ok boolean NOT NULL,
    binding_id uuid REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    delivery_count integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'pending',
    received_at timestamp with time zone NOT NULL DEFAULT now(),
    created_at timestamp with time zone NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS ingestion_intake (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    source_doc_id text NOT NULL,
    source_revision text NOT NULL,
    content_hash text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    last_classifier_run_id text,
    error_class text,
    error_text text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
  );

  -- Phase-a appendix #4 PR-D: redaction events surface.
  -- APPEND-ONLY per THREAT-MODEL §2 invariant 8. Metadata-only per §3.3:
  -- matched_byte_ranges stores offsets only; matched CONTENT is never persisted.
  CREATE TABLE IF NOT EXISTS redaction_events (
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
  CREATE INDEX IF NOT EXISTS redaction_events_pipeline_created_at_idx
    ON redaction_events (pipeline, created_at);

  -- Phase-a appendix #4 PR-D: agent_instances table (needed for
  -- heartbeat reader JOIN). Omit the unique constraint so the test
  -- can insert multiple instances with the same name for isolation.
  CREATE TABLE IF NOT EXISTS agent_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    definition_slug text NOT NULL,
    name text NOT NULL,
    scope_domain_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    output_channel_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    schedule_cron text,
    memory jsonb DEFAULT '{}'::jsonb NOT NULL,
    locale text NOT NULL DEFAULT 'en',
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  -- PR-R1 follow-up: catalog_candidate + miner_suppressions FK
  -- domains via ON DELETE RESTRICT, so domain hard-delete must
  -- pre-check them. The fixture mirrors the production FK shape
  -- (only the columns load-bearing for the pre-check + tests).
  -- miner_runs is FK'd by catalog_candidate so it ships too.
  CREATE TABLE IF NOT EXISTS miner_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    miner_binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    class catalog_class NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    candidate_count integer NOT NULL DEFAULT 0,
    suppressed_count integer NOT NULL DEFAULT 0,
    tokens_total integer NOT NULL DEFAULT 0,
    cost_usd numeric(10, 6) NOT NULL DEFAULT '0',
    latency_ms integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS catalog_candidate (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    miner_run_id uuid NOT NULL REFERENCES miner_runs(id) ON DELETE RESTRICT,
    catalog_domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    class catalog_class NOT NULL,
    status catalog_candidate_status NOT NULL DEFAULT 'detected',
    pattern_fingerprint text NOT NULL,
    evidence_refs jsonb NOT NULL,
    draft_payload jsonb NOT NULL,
    reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS miner_suppressions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    catalog_domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    pattern_fingerprint text NOT NULL,
    reviewer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
`;

export class MockGiteaClient implements GiteaClient {
  /** Pre-stored map of PAT → whoami response. Tests configure
   *  this before issuing requests. */
  readonly responses = new Map<string, GiteaWhoamiResult | Error>();
  /** Captures every call; tests assert no extra Gitea
   *  round-trips on cache hits. */
  readonly calls: string[] = [];

  async whoami(pat: string): Promise<GiteaWhoamiResult> {
    this.calls.push(pat);
    const r = this.responses.get(pat);
    if (r === undefined) {
      throw new Error(`MockGiteaClient: no response configured for PAT '${pat}'`);
    }
    if (r instanceof Error) {
      throw r;
    }
    return r;
  }
}

/** Stub provisioning function the binding-create + domain-create
 *  routes consume. Tests inject a mock that records calls + can
 *  throw to exercise rollback paths. */
export interface ProvisionStubCall {
  readonly slug: string;
  readonly domainClass: string;
  readonly defaultLocale: string;
  readonly pat: string;
}

export class MockProvisioner {
  readonly calls: ProvisionStubCall[] = [];
  /** When set, the next provision call throws this error. */
  nextError: Error | null = null;
  /** When set, repoUrl returned. Else deterministic baseUrl/org/slug. */
  nextRepoUrl: string | null = null;

  async provision(args: ProvisionStubCall): Promise<{ readonly repoUrl: string }> {
    this.calls.push(args);
    if (this.nextError !== null) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const url = this.nextRepoUrl ?? `https://gitea.test/opencoo/${args.slug}`;
    this.nextRepoUrl = null;
    return { repoUrl: url };
  }
}

export interface AdminFixture {
  readonly app: FastifyInstance;
  readonly db: AdminTestDb;
  readonly raw: PGlite;
  readonly gitea: MockGiteaClient;
  readonly provisioner: MockProvisioner;
  readonly credentialStore: InMemoryCredentialStore;
  readonly close: () => Promise<void>;
}

export interface AdminFixtureOptions {
  readonly adminTeamSlug?: string;
  readonly llmDebugLog?: boolean;
  /** Phase-a appendix #4 PR-B — injected queue for pipelines-list tests. */
  readonly ingestionQueue?: { getJobCounts: (...states: string[]) => Promise<Record<string, number>>; name?: string };
  /** Phase-a appendix #4 PR-B — injected SSE bus for heartbeat / run-lifecycle tests. */
  readonly sseBus?: SseBus;
}

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

export async function makeAdminFixture(
  opts: AdminFixtureOptions = {},
): Promise<AdminFixture> {
  __resetAdminAuthCache();

  const pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(TABLES_DDL);
  const db: AdminTestDb = drizzle(pg, { schema });

  const gitea = new MockGiteaClient();
  const provisioner = new MockProvisioner();
  const credentialStore = new InMemoryCredentialStore({
    logger: silentLogger(),
  });
  const app = Fastify({ logger: false });
  await registerAdminApi({
    app,
    db: db as unknown as Parameters<typeof registerAdminApi>[0]["db"],
    giteaClient: gitea,
    adminTeamSlug: opts.adminTeamSlug ?? "opencoo-admins",
    sessionHmacKey: Buffer.from("test-session-hmac-key-32-bytes-x"),
    logger: silentLogger(),
    llmDebugLog: opts.llmDebugLog ?? false,
    provisionDomainRepo: (a) =>
      provisioner.provision({
        slug: a.slug,
        domainClass: a.domainClass,
        defaultLocale: a.defaultLocale,
        pat: a.pat,
      }),
    provisionOrg: "opencoo",
    credentialStore,
    ...(opts.ingestionQueue !== undefined
      ? { ingestionQueue: opts.ingestionQueue }
      : {}),
    ...(opts.sseBus !== undefined
      ? { sseBus: opts.sseBus }
      : {}),
  });

  return {
    app,
    db,
    raw: pg,
    gitea,
    provisioner,
    credentialStore,
    close: async () => {
      await app.close();
      await pg.close();
    },
  };
}

/** Helper: issue a CSRF token for the given PAT and return both
 *  the token + the cookie value. The auth path runs once, the
 *  cookie is set, and we extract the token for re-use on the
 *  state-changing request. */
export async function getCsrf(
  fixture: AdminFixture,
  pat: string,
): Promise<{ readonly csrfToken: string; readonly cookie: string }> {
  const res = await fixture.app.inject({
    method: "GET",
    url: "/api/admin/_csrf",
    headers: { authorization: `Bearer ${pat}` },
  });
  if (res.statusCode !== 200) {
    throw new Error(
      `getCsrf: expected 200 got ${res.statusCode}: ${res.body}`,
    );
  }
  const setCookie = res.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie.join(", ") : setCookie ?? "";
  const csrfMatch = /opencoo_csrf=([^;]+)/.exec(cookieHeader);
  const cookie = csrfMatch?.[1] ?? "";
  const body = JSON.parse(res.body) as { csrfToken: string };
  return { csrfToken: body.csrfToken, cookie };
}
