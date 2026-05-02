/**
 * Agent definitions registry. The canonical definition lives
 * in TypeScript (per architecture §17 Resolved "Agent harness
 * shape"); the `agent_definitions` table is metadata-only —
 * it mirrors what the engine has registered so the Management
 * UI catalog and the Review Dashboard can look up an agent by
 * slug without importing the engine package.
 *
 * The harness boots, walks every registered AgentDefinition,
 * and upserts a metadata row per slug. Re-registration with
 * a bumped version ticks `updated_at` (mutation-adjacent —
 * the row is NOT append-only, the agent_definitions table is
 * explicitly excluded from the §2 invariant 8 set).
 *
 * Concrete agents (Heartbeat, Lint, Builder, Chat, Surfacer)
 * arrive in PR 20+. v0.1 ships only the registry + the
 * upsert harness path so the schema-of-record stays in
 * lockstep with the in-memory definitions.
 */

import { sql } from "drizzle-orm";

import type { Logger } from "@opencoo/shared/logger";

/**
 * Per-agent contract. Concrete agent modules export a
 * factory that returns this shape; the engine boot path
 * imports them and calls `register()` on this registry.
 */
export interface AgentDefinition {
  /** Stable slug — single source of truth for the agent
   *  identity. Used as the FK target for agent_instances and
   *  the join key with agent_definitions.slug. */
  readonly slug: string;
  /** Semver-ish version. Mutation tick on re-registration. */
  readonly version: string;
  /** Human-readable description shown in the UI catalog. */
  readonly description: string;
  /** Name of the Zod output schema the harness uses to
   *  parse the agent's JSON output (e.g. "HeartbeatOutput",
   *  "LintFindings"). The schema itself lives in the agent
   *  module; this string is just the UI label. */
  readonly outputSchemaName: string;
  /** Default memory configuration the harness applies to a
   *  new agent_instance row when it's seeded with no
   *  explicit memory config. */
  readonly defaultMemory: Record<string, unknown>;
  /** The closed set of tool names the agent is allowed to
   *  invoke via `ctx.callTool`. Used by the
   *  `automation_drift` Lint detector (plan #97 Q6) to flag
   *  past runs whose `tool_calls[].name` is not in this set —
   *  evidence of a removed tool that's still being invoked,
   *  or a new tool slipped in without being declared. The
   *  detector treats the definition as the source of truth;
   *  the harness's deny-list is a destructive-tool floor and
   *  the definition is the per-agent ceiling. */
  readonly toolNames: readonly string[];
  /** Default cron pattern for the `opencoo agents seed` CLI to
   *  populate `agent_instances.schedule_cron` with when the
   *  operator hasn't explicitly set one. Only set on agents that
   *  belong to the scheduled-class set (Heartbeat, Lint, Surfacer);
   *  on-demand agents (Chat, Builder) leave this undefined so the
   *  seeder skips them. UTC; PR-M2 (phase-a appendix #5). */
  readonly defaultScheduleCron?: string;
}

/**
 * In-memory registry of agent definitions. v0.1 keeps this
 * stateful (one instance per engine process) and rejects
 * duplicate slugs at register time so a misconfigured engine
 * fails loud at boot rather than silently overriding a
 * production agent.
 */
export class AgentDefinitionRegistry {
  private readonly bySlug = new Map<string, AgentDefinition>();

  register(def: AgentDefinition): void {
    if (this.bySlug.has(def.slug)) {
      throw new Error(
        `agent-harness: duplicate agent definition slug '${def.slug}' — registry rejects re-registration`,
      );
    }
    this.bySlug.set(def.slug, def);
  }

  get(slug: string): AgentDefinition | undefined {
    return this.bySlug.get(slug);
  }

  list(): readonly AgentDefinition[] {
    return [...this.bySlug.values()];
  }

  size(): number {
    return this.bySlug.size;
  }
}

/**
 * Sync the registry's in-memory definitions to the
 * `agent_definitions` Postgres table. Called once at boot
 * after every concrete agent has called register(). Inserts
 * new rows; updates the version + metadata + updated_at on
 * existing rows (mutation-adjacent). Returns the inserted/
 * updated row ids per slug for telemetry.
 */
export interface SyncDefinitionsArgs {
  readonly registry: AgentDefinitionRegistry;
  readonly db: SyncDefinitionsDb;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface SyncDefinitionsDb {
  execute(query: { toString(): string }): Promise<unknown>;
}

export async function syncDefinitions(
  args: SyncDefinitionsArgs,
): Promise<void> {
  const now = (args.now ?? ((): Date => new Date()))();
  for (const def of args.registry.list()) {
    await args.db.execute(sql`
      INSERT INTO agent_definitions
        (slug, version, description, output_schema_name, default_memory, registered_at, created_at, updated_at)
      VALUES (
        ${def.slug},
        ${def.version},
        ${def.description},
        ${def.outputSchemaName},
        ${JSON.stringify(def.defaultMemory)}::jsonb,
        ${now.toISOString()},
        ${now.toISOString()},
        ${now.toISOString()}
      )
      ON CONFLICT (slug) DO UPDATE SET
        version = EXCLUDED.version,
        description = EXCLUDED.description,
        output_schema_name = EXCLUDED.output_schema_name,
        default_memory = EXCLUDED.default_memory,
        registered_at = EXCLUDED.registered_at,
        updated_at = EXCLUDED.updated_at
    `);
  }
  args.logger.info("agent_definitions.synced", {
    count: args.registry.size(),
  });
}
