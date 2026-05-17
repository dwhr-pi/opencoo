/**
 * `contradictions` detector — the only LLM-backed Lint detector.
 * Samples up to N pages from the input, asks the LLM (lint
 * prompt, thinker tier) which pages carry factually
 * contradictory claims with each other, and surfaces each
 * detected contradiction as a finding.
 *
 * Per Q7 (architecture): cap at 50 pages per run so cost stays
 * bounded. v0.1 sends ALL sampled pages to a single LLM call
 * — the model picks pairs internally — so the cap bounds the
 * prompt size, not the number of pairwise comparisons. (The
 * earlier name `CONTRADICTIONS_PAIR_CAP` was misleading; the
 * impl never iterates pairwise.)
 *
 * The LLM call is a single prompt that includes ALL the
 * sampled page bodies (each spotlighted in its own
 * <source_content>). The Zod-validated output is an array of
 * contradiction records that this detector translates into
 * `LintFinding[]`.
 */
import { z } from "zod";

import { spotlight } from "@opencoo/shared/spotlight";
import {
  loadPromptForScope,
  type ScopeResolverDb,
} from "@opencoo/shared/prompts";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { DomainId } from "@opencoo/shared/db";

import type { LintFinding } from "../types.js";

/**
 * Architectural cap on the max number of PAGES analysed in a
 * single contradictions pass (Q7). The orchestrator slices the
 * sampled-paths list to this length before reading bodies, and
 * the detector slices defensively too so a buggy caller can't
 * blow the per-run budget.
 */
export const CONTRADICTIONS_PAGE_CAP = 50;

const CONTRADICTION_RECORD = z
  .object({
    page_a: z.string().min(1),
    page_b: z.string().min(1),
    claim_a: z.string().min(1),
    claim_b: z.string().min(1),
    severity: z.enum(["low", "medium", "high"]),
    rationale: z.string().min(1),
  })
  .strict();

export const CONTRADICTIONS_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    contradictions: z.array(CONTRADICTION_RECORD),
  })
  .strict();

export interface PageBody {
  readonly domainSlug: string;
  readonly path: string;
  readonly body: string;
}

export interface ContradictionsArgs {
  readonly router: LlmRouter;
  /** Drizzle handle for the per-(domain, instance) prompt
   *  override resolver (PR-W1). The orchestrator forwards the
   *  same handle it uses for binding/citation queries. */
  readonly db: ScopeResolverDb;
  readonly domainId: DomainId;
  /** Lint instance id — used to resolve instance-scoped lint
   *  prompt overrides. The orchestrator forwards
   *  `ctx.instance.id`. */
  readonly instanceId?: string;
  readonly locale: "en" | "pl" | "auto";
  /** The page bodies the orchestrator picked for this run.
   *  Already capped by the orchestrator; the detector enforces
   *  the cap defensively. */
  readonly pages: readonly PageBody[];
  readonly fetchedAt: Date;
}

export async function detectContradictions(
  args: ContradictionsArgs,
): Promise<readonly LintFinding[]> {
  const sampled = args.pages.slice(0, CONTRADICTIONS_PAGE_CAP);
  if (sampled.length < 2) return [];

  const prompt = await loadPromptForScope({
    name: "lint",
    locale: args.locale,
    domainId: args.domainId,
    db: args.db,
    ...(args.instanceId !== undefined ? { instanceId: args.instanceId } : {}),
  });
  const envelopes = sampled
    .map((p) =>
      spotlight({
        content: `<<page-path>>${p.domainSlug}/${p.path}<<end>>\n${p.body}`,
        source: `wiki://${p.domainSlug}/${p.path}`,
        fetchedAt: args.fetchedAt,
      }),
    )
    .join("\n\n");

  const fullPrompt = `${prompt.body}\n\n# Pages to analyse\n${envelopes}`;

  const result = await args.router.generateObject({
    domainId: args.domainId,
    tier: "thinker",
    pipelineOrAgent: "lint:contradictions",
    prompt: fullPrompt,
    schema: CONTRADICTIONS_OUTPUT_SCHEMA,
  });

  const findings: LintFinding[] = [];
  for (const c of result.object.contradictions) {
    findings.push({
      kind: "contradictions",
      severity: c.severity,
      scope: `${c.page_a}↔${c.page_b}`,
      message: `${c.page_a} and ${c.page_b} carry contradictory claims: "${c.claim_a}" vs "${c.claim_b}"`,
      detail: {
        pageA: c.page_a,
        pageB: c.page_b,
        claimA: c.claim_a,
        claimB: c.claim_b,
        rationale: c.rationale,
      },
    });
  }
  return findings;
}
