/**
 * Production AgentRunnerRegistry composition (PR-N3, phase-a
 * appendix #6). Wires the three scheduled-class agent runners
 * (Heartbeat, Lint, Surfacer) into closures the
 * `engine-self-operating` AgentDispatcher invokes per scheduled
 * job.
 *
 * The registry is constructed once by the orchestrator
 * (`packages/cli/src/commands/serve.ts`) and threaded into
 * `engine-self-operating.start({ agentRunners })`. With the
 * registry populated, BullMQ recurring jobs registered by the
 * dispatcher resolve to a real runner closure rather than the
 * empty Map the dispatcher boots with by default.
 *
 * On-demand agents (Chat, Builder) are NOT in the scheduled
 * registry — they're invoked from the admin API on a per-call
 * basis with their own context (Chat carries a `callerPat`,
 * Builder is operator-triggered from the Review Dashboard). The
 * dispatcher's `scheduler.invalid_cron` log + the harness's
 * registry miss surface any misconfigured scheduling on a slug
 * outside the v0.1 set.
 *
 * The closure shape: `(ctx: AgentRunContext) => Promise<unknown>`
 * — the dispatcher invokes it with the harness-prepared context
 * (instance, runId, spotlightedMemory, router, callTool, etc.);
 * the closure then dispatches to the underlying `runHeartbeat /
 * runLint / runSurfacer` with the production deps captured at
 * registry-construction time.
 *
 * Domain selection: the closure resolves the domain slug PER
 * DISPATCH from `ctx.instance.scopeDomainIds[0]` — every
 * agent_instances row already carries its scope, so no env var
 * is needed (THREAT-MODEL §2 invariant 9: no feature env vars).
 * v0.1 single-domain pilots have exactly one entry in scope; the
 * lookup pattern remains correct when v0.2 introduces per-domain
 * scheduling.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import {
  runHeartbeat,
  runLint,
  runSurfacer,
  type AgentDefinitionRegistry,
  type AgentRunContext,
  type AgentRunner,
  type AgentRunnerRegistry,
  type McpToolClient,
} from "@opencoo/engine-self-operating";
import type { Logger } from "@opencoo/shared/logger";
import type { LlmRouter } from "@opencoo/shared/llm-router";

/** Module-level alias for the Drizzle wrapper around node-postgres'
 *  `pg.Pool`. Used by `createProductionAgentRunners` (wrap once at
 *  registry construction) and the `resolveDomainSlug` helper. */
type DrizzleDb = ReturnType<typeof drizzle>;

export interface ProductionAgentRunnersDeps {
  /** Postgres pool — handed verbatim to each runner that needs
   *  Drizzle access (Heartbeat for the scope cross-check, Lint
   *  for binding/citation queries, Surfacer for candidate
   *  inserts). The dispatcher does NOT own this pool — the
   *  orchestrator constructs it once and threads it through. */
  readonly db: Pool;
  /** Production McpToolClient. v0.1 wires `HttpMcpToolClient`;
   *  test paths can substitute `InMemoryMcpToolClient` to drive
   *  the registry without a network. */
  readonly mcp: McpToolClient;
  /** Shared LlmRouter instance — already wired against the
   *  multi-provider dispatcher per `production-composition.ts`.
   *  Runners that don't make LLM calls ignore it; this remains
   *  the path the harness's AgentRunContext.router exposes. */
  readonly router: LlmRouter;
  /** Logger handle. Runner closures log nothing themselves; the
   *  underlying `run*` functions plus the harness's recorder
   *  emit per-step events. */
  readonly logger: Logger;
  /** Definition registry — needed by Lint's
   *  `automation_drift` detector to snapshot every agent's
   *  allowed tool names. */
  readonly definitions: AgentDefinitionRegistry;
  /** Optional explicit domain slug. Test seam — production
   *  paths leave this undefined and let the closure resolve from
   *  `ctx.instance.scopeDomainIds[0]` at dispatch time. */
  readonly domainSlug?: string;
  /** The closed set of n8n template slugs Surfacer can propose.
   *  Mirrors the prompt's allow-list; `runSurfacer` rejects any
   *  candidate with an unknown slug. */
  readonly availableTemplateSlugs: readonly string[];
  /** Round-2 fix #2 on PR #57 (Copilot review): when false,
   *  Surfacer is OMITTED from the registry. The orchestrator
   *  sets this to false when `availableTemplateSlugs.length === 0`
   *  so a scheduled Surfacer doesn't silently drop every
   *  candidate against an empty catalog — instead the
   *  dispatcher's runner-missing path throws + the operator
   *  sees the failure surface (one BullMQ retry burst per
   *  Surfacer instance, then DLQ). Defaults to true (back-
   *  compat for tests that wire a non-empty list and expect
   *  Surfacer registered without explicitly opting in). */
  readonly surfacerEnabled?: boolean;
}

interface SlugRow {
  slug: string;
}

/** Resolve the domain slug for a dispatched run. v0.1 pattern:
 *  every scheduled instance row has at least one entry in
 *  `scope_domain_ids`; the runner reads the first id and looks
 *  up its slug. Throws when scope is empty (the upstream
 *  agent body would also throw, but a clearer message here helps
 *  the operator pinpoint the misconfigured row). */
async function resolveDomainSlug(
  db: DrizzleDb,
  ctx: AgentRunContext,
  override: string | undefined,
): Promise<string> {
  if (override !== undefined) return override;
  const scope = ctx.instance.scopeDomainIds;
  if (scope.length === 0) {
    throw new Error(
      `agent-runners: instance ${ctx.instance.id} has empty scope_domain_ids — cannot resolve domain slug`,
    );
  }
  const result = (await db.execute(sql`
    SELECT slug FROM domains WHERE id = ${scope[0]}::uuid LIMIT 1
  `)) as unknown as { rows: SlugRow[] };
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `agent-runners: instance ${ctx.instance.id} scope_domain_ids[0]=${scope[0]} did not resolve to a domain row`,
    );
  }
  return row.slug;
}

export function createProductionAgentRunners(
  deps: ProductionAgentRunnersDeps,
): AgentRunnerRegistry {
  // The runner closure shape is `(ctx) => Promise<unknown>`. We
  // dispatch to the underlying `run*` with `(ctx, args)` where
  // args is the production-deps bundle. The runners' run*
  // functions accept a Drizzle `PgDatabase` (calling
  // `db.execute(sql\`...\`)`), so we wrap the raw `pg.Pool` once
  // at registry-construction time and hand the wrapped db to
  // every closure plus the slug resolver. Wrapping per dispatch
  // (the prior pattern) was both wasteful and only covered the
  // resolver path — the runner closures were still passing the
  // raw pool, which threw `args.db.execute is not a function`
  // on first dispatch (PR-Q2, phase-a appendix #9).
  const drizzleDb: DrizzleDb = drizzle(deps.db);

  const heartbeat: AgentRunner = async (ctx: AgentRunContext) => {
    const domainSlug = await resolveDomainSlug(drizzleDb, ctx, deps.domainSlug);
    return runHeartbeat(ctx, {
      db: drizzleDb,
      mcp: deps.mcp,
      domainSlug,
    } as unknown as Parameters<typeof runHeartbeat>[1]);
  };

  const lint: AgentRunner = async (ctx: AgentRunContext) => {
    const domainSlug = await resolveDomainSlug(drizzleDb, ctx, deps.domainSlug);
    return runLint(ctx, {
      db: drizzleDb,
      mcp: deps.mcp,
      domainSlug,
      definitions: deps.definitions,
    } as unknown as Parameters<typeof runLint>[1]);
  };

  const surfacer: AgentRunner = async (ctx: AgentRunContext) => {
    const domainSlug = await resolveDomainSlug(drizzleDb, ctx, deps.domainSlug);
    return runSurfacer(ctx, {
      db: drizzleDb,
      mcp: deps.mcp,
      domainSlug,
      availableTemplateSlugs: deps.availableTemplateSlugs,
    } as unknown as Parameters<typeof runSurfacer>[1]);
  };

  // Round-2 fix #2 on PR #57: Surfacer is OMITTED from the
  // registry when `surfacerEnabled === false` (default true for
  // back-compat with tests that wire a non-empty
  // availableTemplateSlugs and expect Surfacer registered).
  // Without the omit, scheduled Surfacer instances would run
  // against an empty `availableTemplateSlugs` allow-list and
  // `runSurfacer` would silently reject every candidate the
  // LLM proposed — invisible failure. With the omit, the
  // dispatcher's runner-missing throw surfaces the misconfig.
  const surfacerEnabled = deps.surfacerEnabled ?? true;
  const entries: Array<[string, AgentRunner]> = [
    ["heartbeat", heartbeat],
    ["lint", lint],
  ];
  if (surfacerEnabled) {
    entries.push(["surfacer", surfacer]);
  }
  const map = new Map<string, AgentRunner>(entries);

  return {
    get(definitionSlug: string): AgentRunner | undefined {
      return map.get(definitionSlug);
    },
  };
}
