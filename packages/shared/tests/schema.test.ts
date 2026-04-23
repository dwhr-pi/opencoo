import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import {
  agentDefinitions,
  agentInstances,
  agentRuns,
  agentRunStatus,
  agentTrigger,
  automationCandidates,
  automationCandidateStatus,
  automationDeployments,
  automationDeploymentStatus,
  catalogCandidate,
  catalogCandidateStatus,
  catalogClass,
  credentials,
  domains,
  domainClass,
  erasureAction,
  erasureLog,
  errorClass,
  governanceCadence,
  guardFailMode,
  ingestionIntake,
  intakeStatus,
  llmEngine,
  llmTier,
  llmUsage,
  marketplaceUpdates,
  marketplaceUpdateStatus,
  minerRuns,
  minerSuppressions,
  pageCitations,
  redactionEvents,
  reviewMode,
  sourcesBindings,
  userRole,
  users,
  webhookEvents,
  webhookStatus,
} from "../src/db/schema/index.js";

interface ColumnLike {
  readonly name: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly default: unknown;
  readonly primary: boolean;
  readonly isUnique: boolean;
  readonly getSQLType: () => string;
}

function tableCfg<T extends PgTable>(table: T): ReturnType<typeof getTableConfig> {
  return getTableConfig(table);
}

function columnByName(
  cfg: ReturnType<typeof getTableConfig>,
  name: string,
): ColumnLike {
  const col = cfg.columns.find((c) => c.name === name);
  if (col === undefined) {
    throw new Error(
      `column '${name}' not found on table '${cfg.name}' (found: ${cfg.columns
        .map((c) => c.name)
        .join(", ")})`,
    );
  }
  return col as unknown as ColumnLike;
}

function uniqueColumnNames(cfg: ReturnType<typeof getTableConfig>): string[] {
  return [
    ...cfg.uniqueConstraints.flatMap((u) => u.columns.map((c) => c.name)),
    ...cfg.columns
      .filter((c) => (c as unknown as ColumnLike).isUnique)
      .map((c) => c.name),
  ];
}

function primaryKeyColumnNames(
  cfg: ReturnType<typeof getTableConfig>,
): string[] {
  return [
    ...cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
    ...cfg.columns
      .filter((c) => (c as unknown as ColumnLike).primary)
      .map((c) => c.name),
  ];
}

function indexedColumnTuples(
  cfg: ReturnType<typeof getTableConfig>,
): string[][] {
  return cfg.indexes.map((i) =>
    (i.config.columns as ReadonlyArray<{ name: string }>).map((c) => c.name),
  );
}

function hasIndexOn(
  cfg: ReturnType<typeof getTableConfig>,
  columns: readonly string[],
): boolean {
  return indexedColumnTuples(cfg).some(
    (cols) =>
      cols.length === columns.length &&
      cols.every((name, i) => name === columns[i]),
  );
}

// Shared FK-find helper. Matches the foreign key on `cfg` whose
// foreign table is `target` (optionally disambiguated by the source
// column name when a table has multiple FKs to the same target), then
// asserts its `onDelete` action. The two thin wrappers below are the
// public API so call sites read as "this FK drops refs on delete" or
// "this FK refuses deletes" rather than "this FK has onDelete='set null'".
function expectFkTo(
  cfg: ReturnType<typeof getTableConfig>,
  target: PgTable,
  onDelete: "restrict" | "set null",
  fromColumn?: string,
): void {
  const fk = cfg.foreignKeys.find((f) => {
    if (f.reference().foreignTable !== target) return false;
    if (fromColumn === undefined) return true;
    return f.reference().columns.some((c) => c.name === fromColumn);
  });
  expect(fk).toBeDefined();
  expect(fk?.onDelete).toBe(onDelete);
}

// Assert an `ON DELETE RESTRICT` FK on `cfg` pointing at `target`.
function expectRestrictFkTo(
  cfg: ReturnType<typeof getTableConfig>,
  target: PgTable,
  fromColumn?: string,
): void {
  expectFkTo(cfg, target, "restrict", fromColumn);
}

// Assert an `ON DELETE SET NULL` FK on `cfg` pointing at `target`.
// Used on the two columns backfilled by migration 0002
// (page_citations.compiled_by_run_id and llm_usage.run_id) — audit
// history survives Cleanup pruning of the referenced agent_runs row.
function expectSetNullFkTo(
  cfg: ReturnType<typeof getTableConfig>,
  target: PgTable,
  fromColumn?: string,
): void {
  expectFkTo(cfg, target, "set null", fromColumn);
}

// Assert that `column` carries no foreign-key constraint. Used for
// logical-reference columns like `agent_instances.definition_slug`
// that name a TypeScript-defined agent rather than a DB row.
function expectNoFkOn(
  cfg: ReturnType<typeof getTableConfig>,
  column: string,
): void {
  const fkCols = cfg.foreignKeys.flatMap((f) =>
    f.reference().columns.map((c) => c.name),
  );
  expect(fkCols).not.toContain(column);
}

describe("pg enums", () => {
  it("domain_class has three values: knowledge, catalog-workflows, catalog-skills", () => {
    expect(domainClass.enumName).toBe("domain_class");
    expect([...domainClass.enumValues]).toEqual([
      "knowledge",
      "catalog-workflows",
      "catalog-skills",
    ]);
  });

  it("governance_cadence has five values", () => {
    expect(governanceCadence.enumName).toBe("governance_cadence");
    expect([...governanceCadence.enumValues]).toEqual([
      "continuous",
      "nightly",
      "weekly",
      "quarterly",
      "adhoc",
    ]);
  });

  it("review_mode has three values", () => {
    expect(reviewMode.enumName).toBe("review_mode");
    expect([...reviewMode.enumValues]).toEqual(["auto", "approve", "review"]);
  });

  it("user_role has two values", () => {
    expect(userRole.enumName).toBe("user_role");
    expect([...userRole.enumValues]).toEqual(["admin", "operator"]);
  });
});

describe("domains table", () => {
  it("is named 'domains'", () => {
    expect(tableCfg(domains).name).toBe("domains");
  });

  it("has uuid PK 'id' with gen_random_uuid() default", () => {
    const cfg = tableCfg(domains);
    const id = columnByName(cfg, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(primaryKeyColumnNames(cfg)).toContain("id");
  });

  it("has slug text NOT NULL UNIQUE", () => {
    const cfg = tableCfg(domains);
    const slug = columnByName(cfg, "slug");
    expect(slug.getSQLType()).toBe("text");
    expect(slug.notNull).toBe(true);
    expect(uniqueColumnNames(cfg)).toContain("slug");
  });

  it("has name text NOT NULL", () => {
    const col = columnByName(tableCfg(domains), "name");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has class domain_class NOT NULL DEFAULT 'knowledge'", () => {
    const col = columnByName(tableCfg(domains), "class");
    expect(col.getSQLType()).toBe("domain_class");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("knowledge");
  });

  it("has locale text NOT NULL DEFAULT 'en' with IN check", () => {
    const cfg = tableCfg(domains);
    const col = columnByName(cfg, "locale");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("en");
    expect(cfg.checks.length).toBeGreaterThan(0);
  });

  it("has governance_cadence enum NOT NULL DEFAULT 'continuous'", () => {
    const col = columnByName(tableCfg(domains), "governance_cadence");
    expect(col.getSQLType()).toBe("governance_cadence");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("continuous");
  });

  it("has nullable review_role text", () => {
    const col = columnByName(tableCfg(domains), "review_role");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has llm_policy jsonb NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(tableCfg(domains), "llm_policy");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has nullable llm_budget_monthly_cap_usd numeric(10,2)", () => {
    const col = columnByName(
      tableCfg(domains),
      "llm_budget_monthly_cap_usd",
    );
    expect(col.getSQLType()).toBe("numeric(10, 2)");
    expect(col.notNull).toBe(false);
  });

  it("has nullable retention_days integer", () => {
    const col = columnByName(tableCfg(domains), "retention_days");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(false);
  });

  it("has worldview_enabled boolean NOT NULL DEFAULT true", () => {
    const col = columnByName(tableCfg(domains), "worldview_enabled");
    expect(col.getSQLType()).toBe("boolean");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(true);
  });

  it("has created_at + updated_at timestamptz NOT NULL DEFAULT now()", () => {
    const cfg = tableCfg(domains);
    const created = columnByName(cfg, "created_at");
    const updated = columnByName(cfg, "updated_at");
    expect(created.getSQLType()).toBe("timestamp with time zone");
    expect(created.notNull).toBe(true);
    expect(created.hasDefault).toBe(true);
    expect(updated.getSQLType()).toBe("timestamp with time zone");
    expect(updated.notNull).toBe(true);
    expect(updated.hasDefault).toBe(true);
  });
});

describe("credentials table", () => {
  it("is named 'credentials'", () => {
    expect(tableCfg(credentials).name).toBe("credentials");
  });

  it("has id uuid PK with gen_random_uuid() default", () => {
    const cfg = tableCfg(credentials);
    const id = columnByName(cfg, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(primaryKeyColumnNames(cfg)).toContain("id");
  });

  it("has name text NOT NULL", () => {
    const col = columnByName(tableCfg(credentials), "name");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has schema_ref text NOT NULL", () => {
    const col = columnByName(tableCfg(credentials), "schema_ref");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has ciphertext bytea NOT NULL", () => {
    const col = columnByName(tableCfg(credentials), "ciphertext");
    expect(col.getSQLType()).toBe("bytea");
    expect(col.notNull).toBe(true);
  });

  it("has iv bytea NOT NULL", () => {
    const col = columnByName(tableCfg(credentials), "iv");
    expect(col.getSQLType()).toBe("bytea");
    expect(col.notNull).toBe(true);
  });

  it("has aad bytea NOT NULL", () => {
    const col = columnByName(tableCfg(credentials), "aad");
    expect(col.getSQLType()).toBe("bytea");
    expect(col.notNull).toBe(true);
  });

  it("has encryption_version integer NOT NULL DEFAULT 1", () => {
    const col = columnByName(tableCfg(credentials), "encryption_version");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(1);
  });

  it("has created_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(credentials), "created_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has nullable rotated_at timestamptz", () => {
    const col = columnByName(tableCfg(credentials), "rotated_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });
});

describe("users table", () => {
  it("is named 'users'", () => {
    expect(tableCfg(users).name).toBe("users");
  });

  it("has id uuid PK with gen_random_uuid() default", () => {
    const cfg = tableCfg(users);
    const id = columnByName(cfg, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(primaryKeyColumnNames(cfg)).toContain("id");
  });

  it("has gitea_username text UNIQUE NOT NULL", () => {
    const cfg = tableCfg(users);
    const col = columnByName(cfg, "gitea_username");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    expect(uniqueColumnNames(cfg)).toContain("gitea_username");
  });

  it("has role user_role NOT NULL DEFAULT 'operator'", () => {
    const col = columnByName(tableCfg(users), "role");
    expect(col.getSQLType()).toBe("user_role");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("operator");
  });

  it("has created_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(users), "created_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });
});

describe("sources_bindings table", () => {
  it("is named 'sources_bindings'", () => {
    expect(tableCfg(sourcesBindings).name).toBe("sources_bindings");
  });

  it("has id uuid PK with gen_random_uuid() default", () => {
    const cfg = tableCfg(sourcesBindings);
    const id = columnByName(cfg, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
  });

  it("has domain_id uuid NOT NULL with FK to domains(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(sourcesBindings);
    const col = columnByName(cfg, "domain_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, domains);
  });

  it("has adapter_slug text NOT NULL", () => {
    const col = columnByName(tableCfg(sourcesBindings), "adapter_slug");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has nullable source_id text", () => {
    const col = columnByName(tableCfg(sourcesBindings), "source_id");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has config jsonb NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(tableCfg(sourcesBindings), "config");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has allowed_paths text[] NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(tableCfg(sourcesBindings), "allowed_paths");
    expect(col.getSQLType()).toBe("text[]");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has review_mode NOT NULL DEFAULT 'auto'", () => {
    const col = columnByName(tableCfg(sourcesBindings), "review_mode");
    expect(col.getSQLType()).toBe("review_mode");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("auto");
  });

  it("has nullable schedule_cron text", () => {
    const col = columnByName(tableCfg(sourcesBindings), "schedule_cron");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has nullable credentials_id uuid with FK to credentials(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(sourcesBindings);
    const col = columnByName(cfg, "credentials_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectRestrictFkTo(cfg, credentials);
  });

  it("has nullable retention_days_override integer", () => {
    const col = columnByName(
      tableCfg(sourcesBindings),
      "retention_days_override",
    );
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(false);
  });

  it("has enabled boolean NOT NULL DEFAULT true", () => {
    const col = columnByName(tableCfg(sourcesBindings), "enabled");
    expect(col.getSQLType()).toBe("boolean");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(true);
  });

  it("has nullable last_scanned_at timestamptz", () => {
    const col = columnByName(tableCfg(sourcesBindings), "last_scanned_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });

  it("has nullable notes text", () => {
    const col = columnByName(tableCfg(sourcesBindings), "notes");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has created_at + updated_at timestamptz NOT NULL DEFAULT now()", () => {
    const cfg = tableCfg(sourcesBindings);
    const created = columnByName(cfg, "created_at");
    const updated = columnByName(cfg, "updated_at");
    expect(created.notNull).toBe(true);
    expect(created.hasDefault).toBe(true);
    expect(updated.notNull).toBe(true);
    expect(updated.hasDefault).toBe(true);
  });

  it("has an index over (domain_id, adapter_slug)", () => {
    const cfg = tableCfg(sourcesBindings);
    const idxCols = cfg.indexes.map((i) =>
      (i.config.columns as ReadonlyArray<{ name: string }>).map((c) => c.name),
    );
    const match = idxCols.find(
      (cols) =>
        cols.length === 2 &&
        cols[0] === "domain_id" &&
        cols[1] === "adapter_slug",
    );
    expect(match).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PR 03 — ingestion-side schema (9 tables)
// ---------------------------------------------------------------------------

describe("pg enums (ingestion-side)", () => {
  it("intake_status has three values", () => {
    expect(intakeStatus.enumName).toBe("intake_status");
    expect([...intakeStatus.enumValues]).toEqual([
      "pending",
      "classified",
      "skipped",
    ]);
  });

  it("webhook_status has four values", () => {
    expect(webhookStatus.enumName).toBe("webhook_status");
    expect([...webhookStatus.enumValues]).toEqual([
      "pending",
      "classified",
      "skipped",
      "invalid",
    ]);
  });

  it("error_class has three values matching the ErrorClass taxonomy", () => {
    expect(errorClass.enumName).toBe("error_class");
    expect([...errorClass.enumValues]).toEqual([
      "transient",
      "upstream-quota",
      "validation",
    ]);
  });

  it("llm_engine has two values", () => {
    expect(llmEngine.enumName).toBe("llm_engine");
    expect([...llmEngine.enumValues]).toEqual(["ingestion", "self-op"]);
  });

  it("llm_tier has three values", () => {
    expect(llmTier.enumName).toBe("llm_tier");
    expect([...llmTier.enumValues]).toEqual(["thinker", "worker", "light"]);
  });

  it("catalog_class has two values", () => {
    expect(catalogClass.enumName).toBe("catalog_class");
    expect([...catalogClass.enumValues]).toEqual(["skill", "workflow-pattern"]);
  });

  it("catalog_candidate_status has six values (state machine)", () => {
    expect(catalogCandidateStatus.enumName).toBe("catalog_candidate_status");
    expect([...catalogCandidateStatus.enumValues]).toEqual([
      "detected",
      "drafted",
      "reviewing",
      "approved",
      "rejected",
      "promoted",
    ]);
  });

  it("guard_fail_mode has three values", () => {
    expect(guardFailMode.enumName).toBe("guard_fail_mode");
    expect([...guardFailMode.enumValues]).toEqual([
      "block",
      "transform",
      "review",
    ]);
  });

  it("erasure_action has five values", () => {
    expect(erasureAction.enumName).toBe("erasure_action");
    expect([...erasureAction.enumValues]).toEqual([
      "purge_intake",
      "purge_webhooks",
      "purge_llm_debug",
      "recompile_page",
      "delete_page",
    ]);
  });
});

describe("ingestion_intake table", () => {
  it("is named 'ingestion_intake'", () => {
    expect(tableCfg(ingestionIntake).name).toBe("ingestion_intake");
  });

  it("has uuid PK id with gen_random_uuid() default", () => {
    const cfg = tableCfg(ingestionIntake);
    const id = columnByName(cfg, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(primaryKeyColumnNames(cfg)).toContain("id");
  });

  it("has binding_id uuid NOT NULL with FK to sources_bindings(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(ingestionIntake);
    const col = columnByName(cfg, "binding_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, sourcesBindings);
  });

  it("has source_doc_id text NOT NULL", () => {
    const col = columnByName(tableCfg(ingestionIntake), "source_doc_id");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has source_revision text NOT NULL", () => {
    const col = columnByName(tableCfg(ingestionIntake), "source_revision");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has content_hash text NOT NULL", () => {
    const col = columnByName(tableCfg(ingestionIntake), "content_hash");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has status intake_status NOT NULL DEFAULT 'pending'", () => {
    const col = columnByName(tableCfg(ingestionIntake), "status");
    expect(col.getSQLType()).toBe("intake_status");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("pending");
  });

  it("has nullable last_classifier_run_id text", () => {
    const col = columnByName(
      tableCfg(ingestionIntake),
      "last_classifier_run_id",
    );
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has nullable error_class enum", () => {
    const col = columnByName(tableCfg(ingestionIntake), "error_class");
    expect(col.getSQLType()).toBe("error_class");
    expect(col.notNull).toBe(false);
  });

  it("has created_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(ingestionIntake), "created_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has UNIQUE (binding_id, source_doc_id, source_revision) idempotency key", () => {
    const cfg = tableCfg(ingestionIntake);
    const match = cfg.uniqueConstraints.find((u) => {
      const names = u.columns.map((c) => c.name);
      return (
        names.length === 3 &&
        names[0] === "binding_id" &&
        names[1] === "source_doc_id" &&
        names[2] === "source_revision"
      );
    });
    expect(match).toBeDefined();
  });
});

describe("webhook_events table", () => {
  it("is named 'webhook_events'", () => {
    expect(tableCfg(webhookEvents).name).toBe("webhook_events");
  });

  it("has uuid PK id with default", () => {
    const id = columnByName(tableCfg(webhookEvents), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has provider text NOT NULL", () => {
    const col = columnByName(tableCfg(webhookEvents), "provider");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has nullable event_id text", () => {
    const col = columnByName(tableCfg(webhookEvents), "event_id");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has payload_hash text NOT NULL", () => {
    const col = columnByName(tableCfg(webhookEvents), "payload_hash");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has nullable payload jsonb (untyped, provider-specific)", () => {
    const col = columnByName(tableCfg(webhookEvents), "payload");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(false);
  });

  it("has signature_ok boolean NOT NULL", () => {
    const col = columnByName(tableCfg(webhookEvents), "signature_ok");
    expect(col.getSQLType()).toBe("boolean");
    expect(col.notNull).toBe(true);
  });

  it("has nullable binding_id uuid with FK to sources_bindings(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(webhookEvents);
    const col = columnByName(cfg, "binding_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectRestrictFkTo(cfg, sourcesBindings);
  });

  it("has delivery_count integer NOT NULL DEFAULT 1", () => {
    const col = columnByName(tableCfg(webhookEvents), "delivery_count");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(1);
  });

  it("has status webhook_status NOT NULL DEFAULT 'pending'", () => {
    const col = columnByName(tableCfg(webhookEvents), "status");
    expect(col.getSQLType()).toBe("webhook_status");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("pending");
  });

  it("has received_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(webhookEvents), "received_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has created_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(webhookEvents), "created_at");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has a partial UNIQUE index on (provider, event_id) WHERE event_id IS NOT NULL", () => {
    const cfg = tableCfg(webhookEvents);
    const partial = cfg.indexes.find((i) => {
      const names = (
        i.config.columns as ReadonlyArray<{ name: string }>
      ).map((c) => c.name);
      return (
        i.config.unique === true &&
        names.length === 2 &&
        names[0] === "provider" &&
        names[1] === "event_id" &&
        i.config.where !== undefined
      );
    });
    expect(partial).toBeDefined();
  });

  it("has an index on received_at", () => {
    const cfg = tableCfg(webhookEvents);
    expect(hasIndexOn(cfg, ["received_at"])).toBe(true);
  });
});

describe("page_citations table (APPEND-ONLY)", () => {
  it("is named 'page_citations'", () => {
    expect(tableCfg(pageCitations).name).toBe("page_citations");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(pageCitations), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has domain_slug text NOT NULL", () => {
    const col = columnByName(tableCfg(pageCitations), "domain_slug");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has page_path text NOT NULL", () => {
    const col = columnByName(tableCfg(pageCitations), "page_path");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has source_binding_id uuid NOT NULL with FK to sources_bindings(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(pageCitations);
    const col = columnByName(cfg, "source_binding_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, sourcesBindings);
  });

  it("has source_ref text NOT NULL", () => {
    const col = columnByName(tableCfg(pageCitations), "source_ref");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has nullable compiled_by_run_id uuid with FK to agent_runs(id) ON DELETE SET NULL", () => {
    const cfg = tableCfg(pageCitations);
    const col = columnByName(cfg, "compiled_by_run_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectSetNullFkTo(cfg, agentRuns, "compiled_by_run_id");
  });

  it("has nullable prompt_version text", () => {
    const col = columnByName(tableCfg(pageCitations), "prompt_version");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has created_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(pageCitations), "created_at");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has an index on (domain_slug, page_path)", () => {
    expect(hasIndexOn(tableCfg(pageCitations), ["domain_slug", "page_path"]))
      .toBe(true);
  });

  it("has an index on (source_binding_id)", () => {
    expect(hasIndexOn(tableCfg(pageCitations), ["source_binding_id"])).toBe(
      true,
    );
  });

  it("has NO updated_at column (append-only)", () => {
    const cfg = tableCfg(pageCitations);
    expect(cfg.columns.map((c) => c.name)).not.toContain("updated_at");
  });
});

describe("llm_usage table", () => {
  it("is named 'llm_usage'", () => {
    expect(tableCfg(llmUsage).name).toBe("llm_usage");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(llmUsage), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has timestamp timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(llmUsage), "timestamp");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has engine llm_engine NOT NULL", () => {
    const col = columnByName(tableCfg(llmUsage), "engine");
    expect(col.getSQLType()).toBe("llm_engine");
    expect(col.notNull).toBe(true);
  });

  it("has tier llm_tier NOT NULL", () => {
    const col = columnByName(tableCfg(llmUsage), "tier");
    expect(col.getSQLType()).toBe("llm_tier");
    expect(col.notNull).toBe(true);
  });

  it("has model text NOT NULL", () => {
    const col = columnByName(tableCfg(llmUsage), "model");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has pipeline_or_agent text NOT NULL", () => {
    const col = columnByName(tableCfg(llmUsage), "pipeline_or_agent");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has nullable document_id text", () => {
    const col = columnByName(tableCfg(llmUsage), "document_id");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has nullable run_id uuid with FK to agent_runs(id) ON DELETE SET NULL", () => {
    const cfg = tableCfg(llmUsage);
    const col = columnByName(cfg, "run_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectSetNullFkTo(cfg, agentRuns, "run_id");
  });

  it("has tokens_in / tokens_out integer NOT NULL", () => {
    const cfg = tableCfg(llmUsage);
    const tIn = columnByName(cfg, "tokens_in");
    const tOut = columnByName(cfg, "tokens_out");
    expect(tIn.getSQLType()).toBe("integer");
    expect(tIn.notNull).toBe(true);
    expect(tOut.getSQLType()).toBe("integer");
    expect(tOut.notNull).toBe(true);
  });

  it("has cost_usd numeric(10, 6) NOT NULL", () => {
    const col = columnByName(tableCfg(llmUsage), "cost_usd");
    expect(col.getSQLType()).toBe("numeric(10, 6)");
    expect(col.notNull).toBe(true);
  });

  it("has latency_ms integer NOT NULL", () => {
    const col = columnByName(tableCfg(llmUsage), "latency_ms");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(true);
  });

  it("has nullable prompt_version text", () => {
    const col = columnByName(tableCfg(llmUsage), "prompt_version");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has created_at timestamptz NOT NULL", () => {
    const col = columnByName(tableCfg(llmUsage), "created_at");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has an index on timestamp", () => {
    expect(hasIndexOn(tableCfg(llmUsage), ["timestamp"])).toBe(true);
  });

  it("has an index on (pipeline_or_agent, timestamp)", () => {
    expect(
      hasIndexOn(tableCfg(llmUsage), ["pipeline_or_agent", "timestamp"]),
    ).toBe(true);
  });
});

describe("miner_runs table", () => {
  it("is named 'miner_runs'", () => {
    expect(tableCfg(minerRuns).name).toBe("miner_runs");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(minerRuns), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has miner_binding_id uuid NOT NULL with FK to sources_bindings(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(minerRuns);
    const col = columnByName(cfg, "miner_binding_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, sourcesBindings);
  });

  it("has class catalog_class NOT NULL", () => {
    const col = columnByName(tableCfg(minerRuns), "class");
    expect(col.getSQLType()).toBe("catalog_class");
    expect(col.notNull).toBe(true);
  });

  it("has window_start and window_end timestamptz NOT NULL", () => {
    const cfg = tableCfg(minerRuns);
    const s = columnByName(cfg, "window_start");
    const e = columnByName(cfg, "window_end");
    expect(s.getSQLType()).toBe("timestamp with time zone");
    expect(s.notNull).toBe(true);
    expect(e.getSQLType()).toBe("timestamp with time zone");
    expect(e.notNull).toBe(true);
  });

  it("has candidate_count integer NOT NULL DEFAULT 0", () => {
    const col = columnByName(tableCfg(minerRuns), "candidate_count");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(0);
  });

  it("has suppressed_count integer NOT NULL DEFAULT 0", () => {
    const col = columnByName(tableCfg(minerRuns), "suppressed_count");
    expect(col.default).toBe(0);
    expect(col.notNull).toBe(true);
  });

  it("has tokens_total integer NOT NULL DEFAULT 0", () => {
    const col = columnByName(tableCfg(minerRuns), "tokens_total");
    expect(col.default).toBe(0);
    expect(col.notNull).toBe(true);
  });

  it("has cost_usd numeric(10, 6) NOT NULL DEFAULT 0", () => {
    const col = columnByName(tableCfg(minerRuns), "cost_usd");
    expect(col.getSQLType()).toBe("numeric(10, 6)");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has latency_ms integer NOT NULL DEFAULT 0", () => {
    const col = columnByName(tableCfg(minerRuns), "latency_ms");
    expect(col.default).toBe(0);
    expect(col.notNull).toBe(true);
  });

  it("has created_at timestamptz NOT NULL", () => {
    const col = columnByName(tableCfg(minerRuns), "created_at");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has an index on (miner_binding_id, created_at)", () => {
    expect(
      hasIndexOn(tableCfg(minerRuns), ["miner_binding_id", "created_at"]),
    ).toBe(true);
  });
});

describe("miner_suppressions table (APPEND-ONLY)", () => {
  it("is named 'miner_suppressions'", () => {
    expect(tableCfg(minerSuppressions).name).toBe("miner_suppressions");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(minerSuppressions), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has catalog_domain_id uuid NOT NULL with FK to domains(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(minerSuppressions);
    const col = columnByName(cfg, "catalog_domain_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, domains);
  });

  it("has pattern_fingerprint text NOT NULL", () => {
    const col = columnByName(tableCfg(minerSuppressions), "pattern_fingerprint");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has reviewer_id uuid NOT NULL with FK to users(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(minerSuppressions);
    const col = columnByName(cfg, "reviewer_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, users);
  });

  it("has nullable reason text", () => {
    const col = columnByName(tableCfg(minerSuppressions), "reason");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has created_at NOT NULL", () => {
    const col = columnByName(tableCfg(minerSuppressions), "created_at");
    expect(col.notNull).toBe(true);
  });

  it("has UNIQUE (catalog_domain_id, pattern_fingerprint)", () => {
    const cfg = tableCfg(minerSuppressions);
    const match = cfg.uniqueConstraints.find((u) => {
      const names = u.columns.map((c) => c.name);
      return (
        names.length === 2 &&
        names[0] === "catalog_domain_id" &&
        names[1] === "pattern_fingerprint"
      );
    });
    expect(match).toBeDefined();
  });

  it("has NO updated_at column (append-only)", () => {
    const cfg = tableCfg(minerSuppressions);
    expect(cfg.columns.map((c) => c.name)).not.toContain("updated_at");
  });
});

describe("catalog_candidate table (MUTATION-ADJACENT)", () => {
  it("is named 'catalog_candidate'", () => {
    expect(tableCfg(catalogCandidate).name).toBe("catalog_candidate");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(catalogCandidate), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has miner_run_id uuid NOT NULL with FK to miner_runs(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(catalogCandidate);
    const col = columnByName(cfg, "miner_run_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, minerRuns);
  });

  it("has catalog_domain_id uuid NOT NULL with FK to domains(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(catalogCandidate);
    const col = columnByName(cfg, "catalog_domain_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, domains, "catalog_domain_id");
  });

  it("has class catalog_class NOT NULL", () => {
    const col = columnByName(tableCfg(catalogCandidate), "class");
    expect(col.getSQLType()).toBe("catalog_class");
    expect(col.notNull).toBe(true);
  });

  it("has status catalog_candidate_status NOT NULL DEFAULT 'detected'", () => {
    const col = columnByName(tableCfg(catalogCandidate), "status");
    expect(col.getSQLType()).toBe("catalog_candidate_status");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("detected");
  });

  it("has pattern_fingerprint text NOT NULL", () => {
    const col = columnByName(tableCfg(catalogCandidate), "pattern_fingerprint");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has evidence_refs jsonb NOT NULL", () => {
    const col = columnByName(tableCfg(catalogCandidate), "evidence_refs");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
  });

  it("has draft_payload jsonb NOT NULL", () => {
    const col = columnByName(tableCfg(catalogCandidate), "draft_payload");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
  });

  it("has nullable reviewed_by uuid with FK to users(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(catalogCandidate);
    const col = columnByName(cfg, "reviewed_by");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectRestrictFkTo(cfg, users, "reviewed_by");
  });

  it("has nullable reviewed_at timestamptz", () => {
    const col = columnByName(tableCfg(catalogCandidate), "reviewed_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });

  it("has both created_at AND updated_at (mutation-adjacent)", () => {
    const cfg = tableCfg(catalogCandidate);
    const created = columnByName(cfg, "created_at");
    const updated = columnByName(cfg, "updated_at");
    expect(created.notNull).toBe(true);
    expect(created.hasDefault).toBe(true);
    expect(updated.notNull).toBe(true);
    expect(updated.hasDefault).toBe(true);
  });

  it("has an index on status", () => {
    expect(hasIndexOn(tableCfg(catalogCandidate), ["status"])).toBe(true);
  });

  it("has an index on miner_run_id", () => {
    expect(hasIndexOn(tableCfg(catalogCandidate), ["miner_run_id"])).toBe(
      true,
    );
  });
});

describe("redaction_events table (APPEND-ONLY)", () => {
  it("is named 'redaction_events'", () => {
    expect(tableCfg(redactionEvents).name).toBe("redaction_events");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(redactionEvents), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has pipeline text NOT NULL", () => {
    const col = columnByName(tableCfg(redactionEvents), "pipeline");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has nullable domain_id uuid with FK to domains(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(redactionEvents);
    const col = columnByName(cfg, "domain_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectRestrictFkTo(cfg, domains);
  });

  it("has nullable binding_id uuid with FK to sources_bindings(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(redactionEvents);
    const col = columnByName(cfg, "binding_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectRestrictFkTo(cfg, sourcesBindings);
  });

  it("has guard_slug text NOT NULL", () => {
    const col = columnByName(tableCfg(redactionEvents), "guard_slug");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has category text NOT NULL", () => {
    const col = columnByName(tableCfg(redactionEvents), "category");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has pattern_version text NOT NULL", () => {
    const col = columnByName(tableCfg(redactionEvents), "pattern_version");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has matched_byte_ranges jsonb NOT NULL", () => {
    const col = columnByName(tableCfg(redactionEvents), "matched_byte_ranges");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
  });

  it("has fail_mode guard_fail_mode NOT NULL", () => {
    const col = columnByName(tableCfg(redactionEvents), "fail_mode");
    expect(col.getSQLType()).toBe("guard_fail_mode");
    expect(col.notNull).toBe(true);
  });

  it("has created_at NOT NULL", () => {
    const col = columnByName(tableCfg(redactionEvents), "created_at");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has an index on (pipeline, created_at)", () => {
    expect(
      hasIndexOn(tableCfg(redactionEvents), ["pipeline", "created_at"]),
    ).toBe(true);
  });

  it("has NO updated_at column (append-only)", () => {
    const cfg = tableCfg(redactionEvents);
    expect(cfg.columns.map((c) => c.name)).not.toContain("updated_at");
  });

  it("has NO matched content column — metadata only per §3.3", () => {
    const cfg = tableCfg(redactionEvents);
    const names = cfg.columns.map((c) => c.name);
    expect(names).not.toContain("matched_text");
    expect(names).not.toContain("matched_content");
    expect(names).not.toContain("original_text");
  });
});

describe("erasure_log table (APPEND-ONLY)", () => {
  it("is named 'erasure_log'", () => {
    expect(tableCfg(erasureLog).name).toBe("erasure_log");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(erasureLog), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has binding_id uuid NOT NULL with FK to sources_bindings(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(erasureLog);
    const col = columnByName(cfg, "binding_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, sourcesBindings);
  });

  it("has action erasure_action NOT NULL", () => {
    const col = columnByName(tableCfg(erasureLog), "action");
    expect(col.getSQLType()).toBe("erasure_action");
    expect(col.notNull).toBe(true);
  });

  it("has target_ref text NOT NULL", () => {
    const col = columnByName(tableCfg(erasureLog), "target_ref");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has executed_by uuid NOT NULL with FK to users(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(erasureLog);
    const col = columnByName(cfg, "executed_by");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, users);
  });

  it("has created_at NOT NULL", () => {
    const col = columnByName(tableCfg(erasureLog), "created_at");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has an index on (binding_id, created_at)", () => {
    expect(hasIndexOn(tableCfg(erasureLog), ["binding_id", "created_at"])).toBe(
      true,
    );
  });

  it("has NO updated_at column (append-only)", () => {
    const cfg = tableCfg(erasureLog);
    expect(cfg.columns.map((c) => c.name)).not.toContain("updated_at");
  });
});

// ---------------------------------------------------------------------------
// PR 04 — self-op schema (6 tables)
// ---------------------------------------------------------------------------

describe("pg enums (self-op)", () => {
  it("agent_trigger has three values", () => {
    expect(agentTrigger.enumName).toBe("agent_trigger");
    expect([...agentTrigger.enumValues]).toEqual([
      "scheduled",
      "http",
      "mcp",
    ]);
  });

  it("agent_run_status has four values", () => {
    expect(agentRunStatus.enumName).toBe("agent_run_status");
    expect([...agentRunStatus.enumValues]).toEqual([
      "running",
      "success",
      "failed",
      "timeout",
    ]);
  });

  it("automation_candidate_status has five values", () => {
    expect(automationCandidateStatus.enumName).toBe(
      "automation_candidate_status",
    );
    expect([...automationCandidateStatus.enumValues]).toEqual([
      "proposed",
      "approved",
      "rejected",
      "built",
      "skipped",
    ]);
  });

  it("automation_deployment_status has four values", () => {
    expect(automationDeploymentStatus.enumName).toBe(
      "automation_deployment_status",
    );
    expect([...automationDeploymentStatus.enumValues]).toEqual([
      "deployed",
      "activated",
      "deactivated",
      "removed",
    ]);
  });

  it("marketplace_update_status has three values", () => {
    expect(marketplaceUpdateStatus.enumName).toBe("marketplace_update_status");
    expect([...marketplaceUpdateStatus.enumValues]).toEqual([
      "pending",
      "accepted",
      "skipped",
    ]);
  });
});

describe("agent_definitions table", () => {
  it("is named 'agent_definitions'", () => {
    expect(tableCfg(agentDefinitions).name).toBe("agent_definitions");
  });

  it("has uuid PK id with gen_random_uuid() default", () => {
    const cfg = tableCfg(agentDefinitions);
    const id = columnByName(cfg, "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.notNull).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(primaryKeyColumnNames(cfg)).toContain("id");
  });

  it("has slug text UNIQUE NOT NULL", () => {
    const cfg = tableCfg(agentDefinitions);
    const col = columnByName(cfg, "slug");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    expect(uniqueColumnNames(cfg)).toContain("slug");
  });

  it("has version text NOT NULL", () => {
    const col = columnByName(tableCfg(agentDefinitions), "version");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has description text NOT NULL", () => {
    const col = columnByName(tableCfg(agentDefinitions), "description");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has output_schema_name text NOT NULL", () => {
    const col = columnByName(tableCfg(agentDefinitions), "output_schema_name");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has default_memory jsonb NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(tableCfg(agentDefinitions), "default_memory");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has registered_at timestamptz NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(agentDefinitions), "registered_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has created_at + updated_at timestamptz NOT NULL DEFAULT now()", () => {
    const cfg = tableCfg(agentDefinitions);
    const created = columnByName(cfg, "created_at");
    const updated = columnByName(cfg, "updated_at");
    expect(created.notNull).toBe(true);
    expect(created.hasDefault).toBe(true);
    expect(updated.notNull).toBe(true);
    expect(updated.hasDefault).toBe(true);
  });
});

describe("agent_instances table", () => {
  it("is named 'agent_instances'", () => {
    expect(tableCfg(agentInstances).name).toBe("agent_instances");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(agentInstances), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has definition_slug text NOT NULL (logical ref, no FK)", () => {
    const cfg = tableCfg(agentInstances);
    const col = columnByName(cfg, "definition_slug");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    expectNoFkOn(cfg, "definition_slug");
  });

  it("has name text NOT NULL", () => {
    const col = columnByName(tableCfg(agentInstances), "name");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has scope_domain_ids uuid[] NOT NULL DEFAULT '{}' and no FK", () => {
    const cfg = tableCfg(agentInstances);
    const col = columnByName(cfg, "scope_domain_ids");
    expect(col.getSQLType()).toBe("uuid[]");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
    expectNoFkOn(cfg, "scope_domain_ids");
  });

  it("has output_channel_ids jsonb NOT NULL", () => {
    const col = columnByName(tableCfg(agentInstances), "output_channel_ids");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has nullable schedule_cron text", () => {
    const col = columnByName(tableCfg(agentInstances), "schedule_cron");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has memory jsonb NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(tableCfg(agentInstances), "memory");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has locale text NOT NULL DEFAULT 'en' with IN check", () => {
    const cfg = tableCfg(agentInstances);
    const col = columnByName(cfg, "locale");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("en");
    expect(cfg.checks.length).toBeGreaterThan(0);
  });

  it("has enabled boolean NOT NULL DEFAULT true", () => {
    const col = columnByName(tableCfg(agentInstances), "enabled");
    expect(col.getSQLType()).toBe("boolean");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(true);
  });

  it("has created_at + updated_at timestamptz NOT NULL DEFAULT now()", () => {
    const cfg = tableCfg(agentInstances);
    expect(columnByName(cfg, "created_at").hasDefault).toBe(true);
    expect(columnByName(cfg, "updated_at").hasDefault).toBe(true);
  });

  it("has UNIQUE (definition_slug, name)", () => {
    const cfg = tableCfg(agentInstances);
    const match = cfg.uniqueConstraints.find((u) => {
      const names = u.columns.map((c) => c.name);
      return (
        names.length === 2 &&
        names[0] === "definition_slug" &&
        names[1] === "name"
      );
    });
    expect(match).toBeDefined();
  });
});

describe("agent_runs table (APPEND-ONLY)", () => {
  it("is named 'agent_runs'", () => {
    expect(tableCfg(agentRuns).name).toBe("agent_runs");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(agentRuns), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has definition_slug text NOT NULL (logical ref, no FK)", () => {
    const cfg = tableCfg(agentRuns);
    const col = columnByName(cfg, "definition_slug");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    expectNoFkOn(cfg, "definition_slug");
  });

  it("has instance_id uuid NOT NULL with FK to agent_instances(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(agentRuns);
    const col = columnByName(cfg, "instance_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, agentInstances);
  });

  it("has trigger agent_trigger NOT NULL", () => {
    const col = columnByName(tableCfg(agentRuns), "trigger");
    expect(col.getSQLType()).toBe("agent_trigger");
    expect(col.notNull).toBe(true);
  });

  it("has inputs jsonb NOT NULL DEFAULT '{}'", () => {
    const col = columnByName(tableCfg(agentRuns), "inputs");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has tool_calls jsonb NOT NULL DEFAULT '[]'", () => {
    const col = columnByName(tableCfg(agentRuns), "tool_calls");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has nullable output jsonb", () => {
    const col = columnByName(tableCfg(agentRuns), "output");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(false);
  });

  it("has skills_used jsonb NOT NULL DEFAULT '[]' (Builder-only)", () => {
    const col = columnByName(tableCfg(agentRuns), "skills_used");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has tokens_in / tokens_out integer NOT NULL DEFAULT 0", () => {
    const cfg = tableCfg(agentRuns);
    const tIn = columnByName(cfg, "tokens_in");
    const tOut = columnByName(cfg, "tokens_out");
    expect(tIn.getSQLType()).toBe("integer");
    expect(tIn.notNull).toBe(true);
    expect(tIn.default).toBe(0);
    expect(tOut.default).toBe(0);
  });

  it("has cost_usd numeric(10, 6) NOT NULL", () => {
    const col = columnByName(tableCfg(agentRuns), "cost_usd");
    expect(col.getSQLType()).toBe("numeric(10, 6)");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has latency_ms integer NOT NULL DEFAULT 0", () => {
    const col = columnByName(tableCfg(agentRuns), "latency_ms");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(0);
  });

  it("has status agent_run_status NOT NULL", () => {
    const col = columnByName(tableCfg(agentRuns), "status");
    expect(col.getSQLType()).toBe("agent_run_status");
    expect(col.notNull).toBe(true);
  });

  it("has nullable error_class enum (reused from PR 03)", () => {
    const col = columnByName(tableCfg(agentRuns), "error_class");
    expect(col.getSQLType()).toBe("error_class");
    expect(col.notNull).toBe(false);
  });

  it("has started_at NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(agentRuns), "started_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has nullable ended_at", () => {
    const col = columnByName(tableCfg(agentRuns), "ended_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });

  it("has created_at NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(agentRuns), "created_at");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has an index on (instance_id, started_at)", () => {
    expect(hasIndexOn(tableCfg(agentRuns), ["instance_id", "started_at"]))
      .toBe(true);
  });

  it("has an index on (definition_slug, started_at)", () => {
    expect(
      hasIndexOn(tableCfg(agentRuns), ["definition_slug", "started_at"]),
    ).toBe(true);
  });

  it("has an index on status", () => {
    expect(hasIndexOn(tableCfg(agentRuns), ["status"])).toBe(true);
  });

  it("has NO updated_at column (append-only)", () => {
    const cfg = tableCfg(agentRuns);
    expect(cfg.columns.map((c) => c.name)).not.toContain("updated_at");
  });
});

describe("automation_candidates table (mutation-adjacent)", () => {
  it("is named 'automation_candidates'", () => {
    expect(tableCfg(automationCandidates).name).toBe("automation_candidates");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(automationCandidates), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has surfacer_run_id uuid NOT NULL with FK to agent_runs(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(automationCandidates);
    const col = columnByName(cfg, "surfacer_run_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, agentRuns);
  });

  it("has source_page_refs jsonb NOT NULL", () => {
    const col = columnByName(
      tableCfg(automationCandidates),
      "source_page_refs",
    );
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
  });

  it("has proposal jsonb NOT NULL", () => {
    const col = columnByName(tableCfg(automationCandidates), "proposal");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
  });

  it("has status automation_candidate_status NOT NULL DEFAULT 'proposed'", () => {
    const col = columnByName(tableCfg(automationCandidates), "status");
    expect(col.getSQLType()).toBe("automation_candidate_status");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("proposed");
  });

  it("has nullable rationale text", () => {
    const col = columnByName(tableCfg(automationCandidates), "rationale");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(false);
  });

  it("has nullable reviewed_by with FK to users(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(automationCandidates);
    const col = columnByName(cfg, "reviewed_by");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectRestrictFkTo(cfg, users, "reviewed_by");
  });

  it("has nullable reviewed_at", () => {
    const col = columnByName(tableCfg(automationCandidates), "reviewed_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });

  it("has both created_at AND updated_at (mutation-adjacent)", () => {
    const cfg = tableCfg(automationCandidates);
    expect(columnByName(cfg, "created_at").hasDefault).toBe(true);
    expect(columnByName(cfg, "updated_at").hasDefault).toBe(true);
  });

  it("has an index on status", () => {
    expect(hasIndexOn(tableCfg(automationCandidates), ["status"])).toBe(true);
  });

  it("has an index on surfacer_run_id", () => {
    expect(hasIndexOn(tableCfg(automationCandidates), ["surfacer_run_id"])).toBe(
      true,
    );
  });
});

describe("automation_deployments table (mutation-adjacent)", () => {
  it("is named 'automation_deployments'", () => {
    expect(tableCfg(automationDeployments).name).toBe("automation_deployments");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(automationDeployments), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has candidate_id uuid NOT NULL with FK to automation_candidates(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(automationDeployments);
    const col = columnByName(cfg, "candidate_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, automationCandidates);
  });

  it("has builder_run_id uuid NOT NULL with FK to agent_runs(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(automationDeployments);
    const col = columnByName(cfg, "builder_run_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(true);
    expectRestrictFkTo(cfg, agentRuns, "builder_run_id");
  });

  it("has n8n_workflow_id text UNIQUE NOT NULL", () => {
    const cfg = tableCfg(automationDeployments);
    const col = columnByName(cfg, "n8n_workflow_id");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
    expect(uniqueColumnNames(cfg)).toContain("n8n_workflow_id");
  });

  it("has skills_used_snapshot jsonb NOT NULL", () => {
    const col = columnByName(
      tableCfg(automationDeployments),
      "skills_used_snapshot",
    );
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
  });

  it("has status automation_deployment_status NOT NULL DEFAULT 'deployed'", () => {
    const col = columnByName(tableCfg(automationDeployments), "status");
    expect(col.getSQLType()).toBe("automation_deployment_status");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("deployed");
  });

  it("has deployed_at NOT NULL DEFAULT now()", () => {
    const col = columnByName(tableCfg(automationDeployments), "deployed_at");
    expect(col.notNull).toBe(true);
    expect(col.hasDefault).toBe(true);
  });

  it("has nullable activated_at (observation-only; Gate 3 invariant)", () => {
    const col = columnByName(tableCfg(automationDeployments), "activated_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });

  it("has nullable last_observed_at", () => {
    const col = columnByName(
      tableCfg(automationDeployments),
      "last_observed_at",
    );
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });

  it("has both created_at AND updated_at (mutation-adjacent)", () => {
    const cfg = tableCfg(automationDeployments);
    expect(columnByName(cfg, "created_at").hasDefault).toBe(true);
    expect(columnByName(cfg, "updated_at").hasDefault).toBe(true);
  });

  it("has an index on status", () => {
    expect(hasIndexOn(tableCfg(automationDeployments), ["status"])).toBe(true);
  });

  it("has an index on candidate_id", () => {
    expect(hasIndexOn(tableCfg(automationDeployments), ["candidate_id"])).toBe(
      true,
    );
  });
});

describe("marketplace_updates table (mutation-adjacent)", () => {
  it("is named 'marketplace_updates'", () => {
    expect(tableCfg(marketplaceUpdates).name).toBe("marketplace_updates");
  });

  it("has uuid PK id", () => {
    const id = columnByName(tableCfg(marketplaceUpdates), "id");
    expect(id.getSQLType()).toBe("uuid");
    expect(id.hasDefault).toBe(true);
  });

  it("has marketplace_source text NOT NULL", () => {
    const col = columnByName(tableCfg(marketplaceUpdates), "marketplace_source");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has release_tag text NOT NULL", () => {
    const col = columnByName(tableCfg(marketplaceUpdates), "release_tag");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has target_commitish text NOT NULL", () => {
    const col = columnByName(tableCfg(marketplaceUpdates), "target_commitish");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has tree_sha text NOT NULL", () => {
    const col = columnByName(tableCfg(marketplaceUpdates), "tree_sha");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("has skills_diff jsonb NOT NULL", () => {
    const col = columnByName(tableCfg(marketplaceUpdates), "skills_diff");
    expect(col.getSQLType()).toBe("jsonb");
    expect(col.notNull).toBe(true);
  });

  it("has status marketplace_update_status NOT NULL DEFAULT 'pending'", () => {
    const col = columnByName(tableCfg(marketplaceUpdates), "status");
    expect(col.getSQLType()).toBe("marketplace_update_status");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe("pending");
  });

  it("has nullable reviewed_by with FK to users(id) ON DELETE RESTRICT", () => {
    const cfg = tableCfg(marketplaceUpdates);
    const col = columnByName(cfg, "reviewed_by");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expectRestrictFkTo(cfg, users, "reviewed_by");
  });

  it("has nullable reviewed_at", () => {
    const col = columnByName(tableCfg(marketplaceUpdates), "reviewed_at");
    expect(col.getSQLType()).toBe("timestamp with time zone");
    expect(col.notNull).toBe(false);
  });

  it("has both created_at AND updated_at (mutation-adjacent)", () => {
    const cfg = tableCfg(marketplaceUpdates);
    expect(columnByName(cfg, "created_at").hasDefault).toBe(true);
    expect(columnByName(cfg, "updated_at").hasDefault).toBe(true);
  });

  it("has UNIQUE (marketplace_source, release_tag)", () => {
    const cfg = tableCfg(marketplaceUpdates);
    const match = cfg.uniqueConstraints.find((u) => {
      const names = u.columns.map((c) => c.name);
      return (
        names.length === 2 &&
        names[0] === "marketplace_source" &&
        names[1] === "release_tag"
      );
    });
    expect(match).toBeDefined();
  });

  it("has an index on status", () => {
    expect(hasIndexOn(tableCfg(marketplaceUpdates), ["status"])).toBe(true);
  });
});
