/**
 * Surfacer agent body (PR 21 / plan #102). Reads wiki content,
 * asks the LLM (worker tier) for candidate automations,
 * persists each candidate via `insertCandidate` (Gate 1 —
 * status hardcoded to 'proposed'). The agent's own JSON output
 * (the SurfacerOutput payload) records what was proposed for
 * audit; the Review Dashboard reads from `automation_candidates`.
 *
 * Tool surface is read-only (worldview.read, index.search,
 * wiki.read_page). No writes through ctx.callTool — the
 * candidate inserts are direct DB calls bypass-by-design (the
 * Surfacer can ONLY insert; Gate 1 is the helper-layer
 * guarantee that `status` is hardcoded).
 *
 * Same domainSlug × scopeDomainIds cross-check as the v0.1
 * reader agents (Heartbeat, Lint, Chat).
 */
import { spotlight } from "@opencoo/shared/spotlight";
import { loadPromptForScope } from "@opencoo/shared/prompts";
import type { DomainId } from "@opencoo/shared/db";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { AgentRunContext } from "../../agent-harness/index.js";
import { insertCandidate } from "../../automation-loop/index.js";
import type { McpToolClient } from "../../mcp-tool-client/index.js";
import { assertDomainSlugInScope } from "../scope-check.js";
import { indexSearch, worldviewRead } from "../tools/index.js";

import {
  SURFACER_OUTPUT_SCHEMA,
  type SurfacerOutput,
} from "./types.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RunSurfacerArgs {
  readonly db: Db;
  readonly mcp: McpToolClient;
  readonly domainSlug: string;
  /** The closed set of n8n template slugs that exist in the
   *  current deployment. The prompt embeds this list and
   *  the LLM is instructed to use only these slugs. The body
   *  enforces by Zod-strict on the schema (template_slug is a
   *  string; rejecting unknown slugs is the engine's
   *  responsibility — Builder will reject if it can't
   *  resolve). v0.1 ships with a small hardcoded set. */
  readonly availableTemplateSlugs: readonly string[];
  readonly now?: () => Date;
}

export interface RunSurfacerResult extends SurfacerOutput {
  readonly insertedCandidateIds: readonly string[];
}

export async function runSurfacer(
  ctx: AgentRunContext,
  args: RunSurfacerArgs,
): Promise<RunSurfacerResult> {
  const now = args.now ?? ((): Date => new Date());

  const scope = ctx.instance.scopeDomainIds;
  if (scope.length === 0) {
    throw new Error(
      `surfacer: instance ${ctx.instance.id} has empty scopeDomainIds — nothing to scan`,
    );
  }
  const resolvedDomainId = await assertDomainSlugInScope({
    db: args.db,
    domainSlug: args.domainSlug,
    scopeDomainIds: scope,
  });
  const domainId = resolvedDomainId as DomainId;

  const worldviewBody = await ctx.callTool("worldview.read", () =>
    worldviewRead(args.mcp, { domainSlug: args.domainSlug }),
  );
  const pagePaths = await ctx.callTool("index.search", () =>
    indexSearch(args.mcp, { domainSlug: args.domainSlug }),
  );

  const prompt = await loadPromptForScope({
    name: "surfacer",
    locale: ctx.instance.locale,
    domainId: resolvedDomainId,
    instanceId: ctx.instance.id,
    db: args.db,
  });

  const fetchedAt = now();
  const worldviewEnvelope = spotlight({
    content: worldviewBody,
    source: `worldview://${args.domainSlug}`,
    fetchedAt,
  });
  const indexEnvelope = spotlight({
    content: pagePaths.join("\n"),
    source: `index://${args.domainSlug}`,
    fetchedAt,
  });
  const templateBlock = `\n\n# Available n8n template slugs\n${args.availableTemplateSlugs.join("\n")}`;

  const fullPrompt = `${prompt.body}\n\n# Domain worldview\n${worldviewEnvelope}\n\n# Available wiki pages\n${indexEnvelope}${templateBlock}`;

  const result = await ctx.router.generateObject({
    domainId,
    tier: "worker",
    pipelineOrAgent: "surfacer",
    prompt: fullPrompt,
    schema: SURFACER_OUTPUT_SCHEMA,
  });

  // Gate 1 — every candidate the LLM returned lands in
  // automation_candidates at status='proposed'. The helper
  // hardcodes the status; the engine will surface them via
  // the Review Dashboard.
  const insertedCandidateIds: string[] = [];
  const allowedSlugs = new Set(args.availableTemplateSlugs);
  for (const c of result.object.candidates) {
    // Defensive: even though the prompt + the engine's allow-
    // list both hard-bound the slugs, the LLM could return a
    // slug we don't recognise. Refusing to insert is fail-
    // closed; the orchestrator can log and continue with the
    // remaining candidates.
    if (!allowedSlugs.has(c.template_slug)) {
      ctx.logger.warn("surfacer.candidate_rejected_unknown_slug", {
        template_slug: c.template_slug,
        title: c.title,
      });
      continue;
    }
    const inserted = await insertCandidate({
      db: args.db,
      surfacerRunId: ctx.runId,
      sourcePageRefs: c.source_page_refs,
      proposal: {
        title: c.title,
        summary: c.summary,
        template_slug: c.template_slug,
        params: c.params,
      },
      ...(c.rationale !== undefined ? { rationale: c.rationale } : {}),
    });
    insertedCandidateIds.push(inserted.candidateId);
  }

  return {
    version: result.object.version,
    candidates: result.object.candidates,
    insertedCandidateIds,
  };
}
