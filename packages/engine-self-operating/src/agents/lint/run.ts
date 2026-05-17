/**
 * Lint orchestrator. Read-only — fans out to the 5 v0.1
 * detectors and concatenates their findings into a single
 * LintOutput. Plan #92 part B adds `automation_drift` as the
 * 6th detector + reintroduces `callerPat` to the harness for
 * the Chat agent.
 *
 * Two layers:
 *   - `runLintCore` — pure analysis given already-loaded data.
 *     Trivial to unit-test; the orchestrator integration test
 *     drives this layer.
 *   - `runLint` — the agent body. Loads bindings + page
 *     citations from Postgres, page paths + bodies from the
 *     MCP tool client, and threads them into runLintCore.
 *
 * No wikiWrite, no MCP write tool — Lint is read-only by
 * construction, mirroring Heartbeat. The integration test
 * `agents-readers.test.ts` asserts wikiWrite has 0 calls
 * across both agents' invocations.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { DomainId } from "@opencoo/shared/db";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import { PROMPT_NAMES, loadPrompt } from "@opencoo/shared/prompts";

import type {
  AgentDefinitionRegistry,
  AgentRunContext,
} from "../../agent-harness/index.js";
import type { McpToolClient } from "../../mcp-tool-client/index.js";
import { assertDomainSlugInScope } from "../scope-check.js";
import { indexSearch, wikiReadPage } from "../tools/index.js";

import {
  detectAutomationDrift,
  type ToolCallObservation,
} from "./detectors/automation-drift.js";
import {
  CONTRADICTIONS_PAGE_CAP,
  detectContradictions,
  type PageBody,
} from "./detectors/contradictions.js";
import { detectOrphans } from "./detectors/orphans.js";
import {
  detectPromptVersionDrift,
  type PageNewestPromptVersion,
} from "./detectors/prompt-version-drift.js";
import {
  detectStalePages,
  type PageNewestCitation,
} from "./detectors/stale-pages.js";
import {
  detectWildcardBindings,
  type WildcardBindingsInput,
} from "./detectors/wildcard-bindings.js";

import type { LintFinding, LintOutput } from "./types.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
}

export const STALE_PAGES_DEFAULT_THRESHOLD_DAYS = 90;

/**
 * Max in-flight `wiki.read_page` calls during contradictions
 * sampling. With HTTP-backed McpToolClient, batching at 4
 * caps the network parallelism without overwhelming the
 * gitea-mcp server. Hardcoded for v0.1 — promotion to a
 * llm_policy or per-domain config is a v0.2 concern. (copilot
 * #22 PERF)
 */
export const WIKI_READ_PAGE_CONCURRENCY = 4;

/**
 * Window over which the automation_drift detector inspects
 * past tool_calls (plan #97 Q6). 30 days matches the v0.1
 * Lint cadence (weekly) with enough history to catch a
 * regression that landed mid-cycle.
 */
export const AUTOMATION_DRIFT_WINDOW_DAYS = 30;

export interface RunLintCoreArgs {
  readonly bindings: readonly WildcardBindingsInput[];
  readonly newestCitations: readonly PageNewestCitation[];
  readonly newestPromptVersions: readonly PageNewestPromptVersion[];
  readonly currentPromptVersions: Readonly<Record<string, string>>;
  readonly wikiPaths: readonly string[];
  readonly citedPaths: ReadonlySet<string>;
  readonly contradictionInputs: readonly PageBody[];
  /** Past tool-call observations (30-day window, status='success'
   *  only) for the automation_drift detector. The orchestrator
   *  loads these via SQL; the core takes them already-flattened. */
  readonly toolCallObservations: readonly ToolCallObservation[];
  /** Definition slug → allowed tool name set, snapshotted from
   *  the AgentDefinitionRegistry at run time. */
  readonly allowedToolsBySlug: ReadonlyMap<string, ReadonlySet<string>>;
  readonly thresholdDays: number;
  readonly domainSlug: string;
  readonly domainId: DomainId;
  readonly locale: "en" | "pl" | "auto";
  readonly router: LlmRouter;
  readonly now: Date;
  /** PR-W1 — Drizzle handle forwarded into the LLM-backed
   *  `detectContradictions` so its `loadPromptForScope` lookup
   *  reads from the same connection as the orchestrator. */
  readonly db: Db;
  /** Lint instance id, forwarded into `detectContradictions`
   *  so an instance-scoped lint-prompt override wins over the
   *  domain-scoped one. */
  readonly instanceId: string;
}

export async function runLintCore(args: RunLintCoreArgs): Promise<LintOutput> {
  const findings: LintFinding[] = [];

  findings.push(...detectWildcardBindings(args.bindings));
  findings.push(
    ...detectStalePages({
      pages: args.newestCitations,
      thresholdDays: args.thresholdDays,
      now: args.now,
    }),
  );
  findings.push(
    ...detectOrphans({
      domainSlug: args.domainSlug,
      wikiPaths: args.wikiPaths,
      citedPaths: args.citedPaths,
    }),
  );
  findings.push(
    ...detectPromptVersionDrift({
      pages: args.newestPromptVersions,
      currentVersions: args.currentPromptVersions,
    }),
  );
  findings.push(
    ...(await detectContradictions({
      router: args.router,
      db: args.db,
      domainId: args.domainId,
      instanceId: args.instanceId,
      locale: args.locale,
      pages: args.contradictionInputs.slice(0, CONTRADICTIONS_PAGE_CAP),
      fetchedAt: args.now,
    })),
  );
  findings.push(
    ...detectAutomationDrift({
      observations: args.toolCallObservations,
      allowedToolsBySlug: args.allowedToolsBySlug,
    }),
  );

  return { version: "v1", findings };
}

/** Snapshot the loader's current `prompts.version` per name so
 *  the prompt-drift detector can compare. */
export function currentLoaderPromptVersions(): Readonly<
  Record<string, string>
> {
  const out: Record<string, string> = {};
  for (const name of PROMPT_NAMES) {
    out[name] = loadPrompt({ name, locale: "en" }).version;
  }
  return out;
}

interface BindingRow {
  id: string;
  domain_slug: string;
  adapter_slug: string;
  allowed_paths: string[];
}

interface PageNewestCitationRow {
  domain_slug: string;
  page_path: string;
  newest_at: string;
  newest_prompt_version: string | null;
}

interface ToolCallRow {
  definition_slug: string;
  run_id: string;
  started_at: string;
  tool_calls: Array<{ name: string }>;
}

export interface RunLintArgs {
  readonly db: Db;
  readonly mcp: McpToolClient;
  readonly domainSlug: string;
  /** Full registry — needed for the automation_drift detector
   *  to snapshot every agent's allowed toolNames. The body
   *  iterates `definitions.list()` to build the per-slug
   *  allowed-tools Map. */
  readonly definitions: AgentDefinitionRegistry;
  readonly thresholdDays?: number;
  /** Window over which the automation_drift detector inspects
   *  past tool_calls. Defaults to AUTOMATION_DRIFT_WINDOW_DAYS. */
  readonly automationDriftWindowDays?: number;
  readonly now?: () => Date;
}

export async function runLint(
  ctx: AgentRunContext,
  args: RunLintArgs,
): Promise<LintOutput> {
  const now = args.now ?? ((): Date => new Date());
  const scope = ctx.instance.scopeDomainIds;
  if (scope.length === 0) {
    throw new Error(
      `lint: instance ${ctx.instance.id} has empty scopeDomainIds — nothing to lint`,
    );
  }

  // Cross-check: domainSlug must resolve to an id in scope
  // BEFORE any LLM call, MCP read, or binding/citation query.
  // Throws DomainScopeMismatchError (validation → DLQ) on
  // mismatch or unknown slug. Same contract as Heartbeat.
  const resolvedDomainId = await assertDomainSlugInScope({
    db: args.db,
    domainSlug: args.domainSlug,
    scopeDomainIds: scope,
  });
  const domainId = resolvedDomainId as DomainId;

  // 1. Load source bindings for this domain (wildcard detector).
  const bindingsResult = (await args.db.execute(sql`
    SELECT b.id::text AS id,
           d.slug   AS domain_slug,
           b.adapter_slug,
           b.allowed_paths
    FROM sources_bindings b
    JOIN domains d ON d.id = b.domain_id
    WHERE b.domain_id = ${domainId}::uuid
      AND b.enabled = true
  `)) as unknown as ExecResult<BindingRow>;

  const bindings: WildcardBindingsInput[] = bindingsResult.rows.map((r) => ({
    id: r.id,
    domainSlug: r.domain_slug,
    adapterSlug: r.adapter_slug,
    allowedPaths: [...(r.allowed_paths ?? [])],
  }));

  // 2. Aggregate page_citations: per (domain_slug, page_path),
  //    the newest created_at + the newest prompt_version. Used
  //    by stale-pages + prompt-drift + (cited-set) orphans.
  const citationsResult = (await args.db.execute(sql`
    SELECT pc.domain_slug,
           pc.page_path,
           MAX(pc.created_at)::text AS newest_at,
           (
             SELECT pc2.prompt_version
             FROM page_citations pc2
             WHERE pc2.domain_slug = pc.domain_slug
               AND pc2.page_path = pc.page_path
             ORDER BY pc2.created_at DESC
             LIMIT 1
           ) AS newest_prompt_version
    FROM page_citations pc
    WHERE pc.domain_slug = ${args.domainSlug}
    GROUP BY pc.domain_slug, pc.page_path
  `)) as unknown as ExecResult<PageNewestCitationRow>;

  const newestCitations: PageNewestCitation[] = citationsResult.rows.map((r) => ({
    domainSlug: r.domain_slug,
    pagePath: r.page_path,
    newestCitationAt: r.newest_at,
  }));
  const newestPromptVersions: PageNewestPromptVersion[] =
    citationsResult.rows.map((r) => ({
      domainSlug: r.domain_slug,
      pagePath: r.page_path,
      newestPromptVersion: r.newest_prompt_version,
      promptName: "compiler",
    }));
  const citedPaths = new Set<string>(
    citationsResult.rows.map((r) => r.page_path),
  );

  // 3. Load wiki paths for the domain via the MCP tool client.
  //    Routed through ctx.callTool so the deny-list + tool-call
  //    ledger fire, same as Heartbeat's reads.
  const wikiPaths = await ctx.callTool("index.search", () =>
    indexSearch(args.mcp, { domainSlug: args.domainSlug }),
  );

  // 4. Sample the first N pages for the contradictions detector
  //    and read their bodies in bounded concurrent batches. With
  //    HTTP-backed McpToolClient, the previous serial loop took
  //    one round trip per page (up to 50 sequentially); the
  //    batched form caps at WIKI_READ_PAGE_CONCURRENCY in flight.
  //    Deterministic ordering: indexSearch returns sorted, and
  //    `Promise.all` resolves to results in input-array order,
  //    so pushing into `contradictionInputs` batch-by-batch
  //    preserves the sampledPaths order. (copilot #22 PERF)
  const sampledPaths = wikiPaths.slice(0, CONTRADICTIONS_PAGE_CAP);
  const contradictionInputs: PageBody[] = [];
  for (let i = 0; i < sampledPaths.length; i += WIKI_READ_PAGE_CONCURRENCY) {
    const batch = sampledPaths.slice(i, i + WIKI_READ_PAGE_CONCURRENCY);
    const bodies = await Promise.all(
      batch.map((path) =>
        ctx.callTool("wiki.read_page", () =>
          wikiReadPage(args.mcp, { domainSlug: args.domainSlug, path }),
        ),
      ),
    );
    for (let j = 0; j < batch.length; j++) {
      contradictionInputs.push({
        domainSlug: args.domainSlug,
        path: batch[j]!,
        body: bodies[j]!,
      });
    }
  }

  // 5. Load tool-call observations for the automation_drift
  //    detector. Window: last N days, status='success' only
  //    (a failed run's tool_calls aren't reliable evidence —
  //    the run blew up before completing). Unroll the JSONB
  //    `tool_calls` array into one observation per (run, name)
  //    so the detector is a pure JS filter.
  //
  //    CROSS-TENANT SCOPE (copilot #23 fix 3): only consider
  //    runs whose `agent_instances.scope_domain_ids` contains
  //    the current Lint run's resolved domainId. Without the
  //    JOIN, a per-domain Lint pass would surface findings
  //    from OTHER domains' agent runs — leaking runIds + tool
  //    names across tenants in shared deployments.
  const windowDays =
    args.automationDriftWindowDays ?? AUTOMATION_DRIFT_WINDOW_DAYS;
  const toolCallsResult = (await args.db.execute(sql`
    SELECT ar.definition_slug,
           ar.id::text AS run_id,
           ar.started_at::text AS started_at,
           ar.tool_calls
    FROM agent_runs ar
    JOIN agent_instances ai ON ai.id = ar.instance_id
    WHERE ar.status = 'success'
      AND ar.started_at >= NOW() - (${windowDays}::text || ' days')::interval
      AND ${domainId}::uuid = ANY(ai.scope_domain_ids)
  `)) as unknown as ExecResult<ToolCallRow>;

  const toolCallObservations: ToolCallObservation[] = [];
  for (const row of toolCallsResult.rows) {
    for (const call of row.tool_calls ?? []) {
      toolCallObservations.push({
        definitionSlug: row.definition_slug,
        runId: row.run_id,
        startedAt: row.started_at,
        name: call.name,
      });
    }
  }

  // Snapshot definition → allowed-tools map from the registry.
  // The detector skips any observation whose slug is missing
  // from this map, treating registry-drift as a separate
  // (logged) concern.
  const allowedToolsBySlug = new Map<string, ReadonlySet<string>>();
  for (const def of args.definitions.list()) {
    allowedToolsBySlug.set(def.slug, new Set(def.toolNames));
  }

  return runLintCore({
    bindings,
    newestCitations,
    newestPromptVersions,
    currentPromptVersions: currentLoaderPromptVersions(),
    wikiPaths,
    citedPaths,
    contradictionInputs,
    toolCallObservations,
    allowedToolsBySlug,
    thresholdDays: args.thresholdDays ?? STALE_PAGES_DEFAULT_THRESHOLD_DAYS,
    domainSlug: args.domainSlug,
    domainId,
    locale: ctx.instance.locale,
    router: ctx.router,
    now: now(),
    db: args.db,
    instanceId: ctx.instance.id,
  });
}
