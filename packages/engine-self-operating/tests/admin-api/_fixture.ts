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

  -- PR-Z4 (phase-a appendix #12 G5): output-channels CRUD surface.
  -- Mirror of the production migration 0012; FK to credentials omitted
  -- because the InMemoryCredentialStore tests use doesn't persist
  -- credential rows.
  CREATE TABLE IF NOT EXISTS output_channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    adapter_slug text NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    credentials_id uuid,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT output_channels_adapter_slug_name_unique UNIQUE (adapter_slug, name)
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

  -- PR-R7 (phase-a appendix #10): page_citations underlies the
  -- forget-impact-preview planner. Append-only per THREAT-MODEL §2
  -- invariant 8 — the planner never writes here; it aggregates per
  -- (domain_slug, page_path) to determine which pages would
  -- recompile vs delete on source forget.
  CREATE TABLE IF NOT EXISTS page_citations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_slug text NOT NULL,
    page_path text NOT NULL,
    source_binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    source_ref text NOT NULL,
    compiled_by_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
    prompt_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS page_citations_domain_slug_page_path_idx
    ON page_citations (domain_slug, page_path);
  CREATE INDEX IF NOT EXISTS page_citations_source_binding_id_idx
    ON page_citations (source_binding_id);

  -- PR-W2 (phase-a appendix #15): prompt_overrides — per-(domain,
  -- instance, prompt_name, locale) operator-managed overrides of
  -- the shipped baseline prompts. Mirrors the production schema
  -- from packages/shared/src/db/schema/prompt-overrides.ts; the
  -- admin-API tests INSERT/UPDATE/DELETE here through the
  -- sovereignty-confirm flow.
  CREATE TABLE IF NOT EXISTS prompt_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    instance_id uuid REFERENCES agent_instances(id) ON DELETE CASCADE,
    prompt_name text NOT NULL CHECK (prompt_name IN ('classifier','compiler','heartbeat','lint','chat','surfacer','builder','worldview-domain','worldview-company')),
    locale text NOT NULL CHECK (locale IN ('en','pl')),
    body text NOT NULL CHECK (length(body) <= 100000),
    overrides_version text NOT NULL,
    baseline_version text NOT NULL,
    updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prompt_overrides_scope_unique UNIQUE NULLS NOT DISTINCT (domain_id, instance_id, prompt_name, locale)
  );

  -- Phase-a appendix #10 PR-R5: cost analytics dashboard reads
  -- llm_usage to surface per-domain × agent × tier spend. The
  -- schema mirrors packages/shared/src/db/schema/llm-usage.ts.
  -- Ships in the base fixture so cost-summary tests work without
  -- per-test table creation.
  CREATE TABLE IF NOT EXISTS llm_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    engine llm_engine NOT NULL,
    tier llm_tier NOT NULL,
    model text NOT NULL,
    pipeline_or_agent text NOT NULL,
    document_id text,
    run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
    domain_id uuid REFERENCES domains(id) ON DELETE SET NULL,
    tokens_in integer NOT NULL,
    tokens_out integer NOT NULL,
    cost_usd numeric(10, 6) NOT NULL,
    latency_ms integer NOT NULL,
    prompt_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS llm_usage_timestamp_idx ON llm_usage ("timestamp");
  CREATE INDEX IF NOT EXISTS llm_usage_pipeline_or_agent_timestamp_idx
    ON llm_usage (pipeline_or_agent, "timestamp");
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

/** Stub /refresh-all ping callable (phase-a appendix #12 PR-Z8 G10).
 *  Records every dispatch and (by default) resolves cleanly so the
 *  domain-create handler never observes a failure mode through this
 *  seam. Tests that want to assert fire-and-forget semantics can set
 *  `nextError` to verify the route still returns 201. */
export class MockWikiMcpRefresh {
  readonly calls: ReadonlyArray<{
    readonly slug: string;
    readonly owner: string;
    readonly name?: string;
    readonly default?: boolean;
    readonly aggregator?: boolean;
  }>[] = [];
  /** When set, the next ping rejects with this error. The
   *  domain-create handler must STILL return 201 — the helper
   *  is fire-and-forget. */
  nextError: Error | null = null;

  async ping(
    repos: ReadonlyArray<{
      readonly slug: string;
      readonly owner: string;
      readonly name?: string;
      readonly default?: boolean;
      readonly aggregator?: boolean;
    }>,
  ): Promise<void> {
    (this.calls as Array<typeof repos>).push(repos);
    if (this.nextError !== null) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
  }
}

export interface AdminFixture {
  readonly app: FastifyInstance;
  readonly db: AdminTestDb;
  readonly raw: PGlite;
  readonly gitea: MockGiteaClient;
  readonly provisioner: MockProvisioner;
  readonly wikiMcpRefresh: MockWikiMcpRefresh;
  readonly credentialStore: InMemoryCredentialStore;
  readonly close: () => Promise<void>;
}

export interface AdminFixtureOptions {
  readonly adminTeamSlug?: string;
  readonly llmDebugLog?: boolean;
  /** Phase-a appendix #4 PR-B — injected queue for pipelines-list tests. */
  readonly ingestionQueue?: {
    getJobCounts: (...states: string[]) => Promise<Record<string, number>>;
    name?: string;
    add?: (jobName: string, payload: unknown, opts?: unknown) => Promise<{ id?: string | null }>;
  };
  /** Phase-a appendix #4 PR-B — injected SSE bus for heartbeat / run-lifecycle tests. */
  readonly sseBus?: SseBus;
  /** PR-R7 (phase-a appendix #10) — read-only delete-cap state injection
   *  for forget-impact-preview tests. The route reads `peek` to surface
   *  today's cap budget and `reserve` to commit when the operator
   *  confirms. Tests inject a fresh `InMemoryDeleteCap` (or a stub) so
   *  the cap state is deterministic. */
  readonly deleteCap?: import("@opencoo/shared/wiki-write").DeleteCap;
  /** PR-R7 — enqueue callable for the actual-forget action. Tests inject
   *  a `vi.fn()` to assert the route DID call it on `?dryRun=0` and did
   *  NOT call it on `?dryRun=1`. */
  readonly forgetJobEnqueuer?: (args: import("../../src/admin-api/routes/source-bindings.js").ForgetJobEnqueueArgs) => Promise<void>;
  /** PR-Z4 — output-adapter descriptor map. Tests inject a stub
   *  registry so the routes exercise the descriptor lookups without
   *  the `@opencoo/output-asana` import surface. */
  readonly outputChannelRegistry?: Readonly<
    Record<
      import("../../src/admin-api/routes/output-channels.js").OutputAdapterSlug,
      import("../../src/admin-api/routes/output-channels.js").OutputAdapterDescriptor
    >
  >;
  /** PR-W1 (phase-a appendix #13) — worldview-compile queue handle
   *  for the `POST /api/admin/domains/:slug/recompile-worldview`
   *  endpoint. Tests inject a stub queue (or a `QueueWithThis`
   *  receiver-binding regression class) to assert the route enqueues
   *  + handles the failure surfaces. */
  readonly worldviewQueue?: {
    add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  };
  /** PR-W2 (phase-a appendix #14) — failed-classify-jobs enumerator
   *  for the `POST /api/admin/source-bindings/:id/retry-failed` route.
   *  Tests inject a stub that closes over a simulated failed set. */
  readonly failedClassifyJobsEnumerator?: (
    bindingId: string,
    intakeId?: string,
  ) => Promise<readonly import("../../src/admin-api/routes/source-bindings.js").RetryableFailedJob[]>;
  /** PR-W2 — companion enqueuer that the retry-failed route hands
   *  the original payloads to. Tests inject a stub that records
   *  every call so the audit-before-enqueue invariant and the
   *  payload-round-trip can be asserted. */
  readonly classifyJobEnqueuer?: (
    name: string,
    data: unknown,
    opts?: unknown,
  ) => Promise<unknown>;
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
  const wikiMcpRefresh = new MockWikiMcpRefresh();
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
    pingWikiMcpRefresh: (repos) => wikiMcpRefresh.ping(repos),
    credentialStore,
    ...(opts.ingestionQueue !== undefined
      ? { ingestionQueue: opts.ingestionQueue }
      : {}),
    ...(opts.sseBus !== undefined
      ? { sseBus: opts.sseBus }
      : {}),
    ...(opts.deleteCap !== undefined
      ? { deleteCap: opts.deleteCap }
      : {}),
    ...(opts.forgetJobEnqueuer !== undefined
      ? { forgetJobEnqueuer: opts.forgetJobEnqueuer }
      : {}),
    ...(opts.outputChannelRegistry !== undefined
      ? { outputChannelRegistry: opts.outputChannelRegistry }
      : {}),
    ...(opts.worldviewQueue !== undefined
      ? { worldviewQueue: opts.worldviewQueue }
      : {}),
    // PR-W2 (phase-a appendix #14)
    ...(opts.failedClassifyJobsEnumerator !== undefined
      ? { failedClassifyJobsEnumerator: opts.failedClassifyJobsEnumerator }
      : {}),
    ...(opts.classifyJobEnqueuer !== undefined
      ? { classifyJobEnqueuer: opts.classifyJobEnqueuer }
      : {}),
  });

  return {
    app,
    db,
    raw: pg,
    gitea,
    provisioner,
    wikiMcpRefresh,
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
