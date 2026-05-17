/**
 * Builder agent body (PR 21 / plan #102). Materialises an
 * approved automation_candidate as a deployed (NOT activated)
 * n8n workflow.
 *
 * # GATE 3 — manual activation only
 *
 * This file only handles deployment. The AutomationAdapter
 * port has no `activate` method (TYPE-LEVEL — adding one is a
 * compile-time error). As defense-in-depth, the source-grep
 * test in tests/automation-loop/gate-3-source-grep.test.ts
 * enforces the source-level guard: it strips comments first,
 * then asserts no `activate(d)?` / `enable(d)?` / `toggle(d)?`
 * verb appears in the executable code that remains. Comments
 * (including this one) are explicitly OK to mention activation
 * by name — the docstring's purpose is to explain the gate. The
 * prompt tells the LLM the same.
 *
 * # Flow
 *
 *   1. Gate 2: `requireApproved(db, candidateId)` — DLQs if
 *      candidate is not status='approved'.
 *   2. Spotlight the candidate's proposal + ask LLM (worker
 *      tier) for `resolved_params` + `skills_used`.
 *   3. `automationAdapter.deployWorkflow(...)` — the ONLY
 *      adapter method available; deploys at n8n's
 *      `active: false`.
 *   4. INSERT into automation_deployments at
 *      status='deployed'.
 *   5. `markBuilt(db, candidateId)` — flips approved → built
 *      (race-safe via WHERE clause).
 *
 * The agent never writes to n8n's activation state. The
 * operator does that step in the n8n UI on the deployed
 * workflow.
 */
import { sql } from "drizzle-orm";

import { spotlight } from "@opencoo/shared/spotlight";
import { loadPromptForScope } from "@opencoo/shared/prompts";
import type { DomainId } from "@opencoo/shared/db";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { AgentRunContext } from "../../agent-harness/index.js";
import {
  markBuilt,
  requireApproved,
} from "../../automation-loop/index.js";
import type { AutomationAdapter } from "../../automation-adapter/index.js";

import {
  BUILDER_OUTPUT_SCHEMA,
  type BuilderOutput,
} from "./types.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RunBuilderArgs {
  readonly db: Db;
  readonly automationAdapter: AutomationAdapter;
  readonly candidateId: string;
  readonly now?: () => Date;
}

export interface RunBuilderResult extends BuilderOutput {
  readonly deploymentId: string;
  readonly n8nWorkflowId: string;
}

export async function runBuilder(
  ctx: AgentRunContext,
  args: RunBuilderArgs,
): Promise<RunBuilderResult> {
  const now = args.now ?? ((): Date => new Date());

  // Gate 2: load + status assertion.
  const candidate = await requireApproved(args.db, args.candidateId);

  const scope = ctx.instance.scopeDomainIds;
  if (scope.length === 0) {
    throw new Error(
      `builder: instance ${ctx.instance.id} has empty scopeDomainIds — cannot route LLM call`,
    );
  }
  const domainId = scope[0]! as DomainId;

  const prompt = await loadPromptForScope({
    name: "builder",
    locale: ctx.instance.locale,
    domainId,
    instanceId: ctx.instance.id,
    db: args.db,
  });
  const fetchedAt = now();
  const proposalEnvelope = spotlight({
    content: JSON.stringify(candidate.proposal),
    source: `automation_candidate:${candidate.id}`,
    fetchedAt,
  });

  const fullPrompt = `${prompt.body}\n\n# Approved candidate (read-only context)\nid: ${candidate.id}\n\n${proposalEnvelope}`;

  const result = await ctx.router.generateObject({
    domainId,
    tier: "worker",
    pipelineOrAgent: "builder",
    prompt: fullPrompt,
    schema: BUILDER_OUTPUT_SCHEMA,
  });

  const build = result.object.build;

  // Defensive: the LLM might emit a candidate_id or
  // template_slug that doesn't match the approved row. Refuse
  // — this is a hallucination signal.
  if (build.candidate_id !== candidate.id) {
    throw new Error(
      `builder: LLM emitted candidate_id '${build.candidate_id}' but operator approved '${candidate.id}'`,
    );
  }
  if (build.template_slug !== candidate.proposal.template_slug) {
    throw new Error(
      `builder: LLM emitted template_slug '${build.template_slug}' but candidate's proposal.template_slug is '${candidate.proposal.template_slug}'`,
    );
  }

  // Gate 3 — `automationAdapter.deployWorkflow` is the ONLY
  // adapter method available. The adapter type has no
  // `activate()`, so the LLM cannot trick the body into
  // activating; the body cannot accidentally activate via
  // typo.
  const { n8nWorkflowId } = await args.automationAdapter.deployWorkflow({
    templateSlug: build.template_slug,
    resolvedParams: build.resolved_params,
    skillsUsed: build.skills_used,
  });

  // Persist the deployment row at status='deployed' (the column
  // default; the helper sets it explicitly for clarity).
  const deploymentResult = (await args.db.execute(sql`
    INSERT INTO automation_deployments
      (candidate_id, builder_run_id, n8n_workflow_id, skills_used_snapshot, status, deployed_at)
    VALUES (
      ${candidate.id}::uuid,
      ${ctx.runId}::uuid,
      ${n8nWorkflowId},
      ${JSON.stringify(build.skills_used)}::jsonb,
      'deployed',
      ${fetchedAt.toISOString()}
    )
    RETURNING id::text AS id
  `)) as unknown as { rows: Array<{ id: string }> };
  const deploymentId = deploymentResult.rows[0]?.id;
  if (deploymentId === undefined) {
    throw new Error(
      "builder: INSERT into automation_deployments returned no rows",
    );
  }

  // Flip the candidate from approved → built. Race-safe: the
  // WHERE status='approved' clause + 0-row → BuilderGate2Error
  // covers the case where a parallel UPDATE flipped the row.
  await markBuilt(args.db, candidate.id);

  return {
    version: result.object.version,
    build: result.object.build,
    deploymentId,
    n8nWorkflowId,
  };
}
