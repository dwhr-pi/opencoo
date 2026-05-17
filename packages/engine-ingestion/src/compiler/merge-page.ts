/**
 * `mergePage` — single LlmRouter.generateObject call that takes
 * the spotlighted source content + existing page body and
 * returns a strict-Zod-parsed { merged_body, worldview_impact }.
 *
 * Backstop guards on top of Zod (the prompt asked the model to
 * obey these; we re-check):
 *   - merged_body must NOT contain literal `<source_content` (sentinel
 *     leaked from the source body into the page).
 *   - merged_body must NOT start with `---` (model tried to forge its
 *     own frontmatter; the compiler controls that block).
 *
 * This is the unit boundary the compiler orchestrator composes —
 * separates "talk to the model" from "decide what to do with the
 * result".
 */

import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { DomainId } from "@opencoo/shared/db";
import {
  loadPromptForScope,
  type PromptLocale,
  type ScopeResolverDb,
} from "@opencoo/shared/prompts";

import { spotlight } from "../classifier/spotlight.js";

import { CompilerValidationError } from "./errors.js";
import { MERGED_PAGE_BODY_SCHEMA, type MergedPageBody } from "./types.js";

export interface MergePageArgs {
  readonly router: LlmRouter;
  /** Drizzle handle for the prompt-override resolver. Plumbed
   *  alongside `domainId` so a per-domain `compiler` prompt
   *  override (PR-W1) wins over the shipped baseline. */
  readonly db: ScopeResolverDb;
  readonly domainId: DomainId;
  readonly sourceRef: string;
  readonly sourceContent: string;
  readonly existingPageContent: string;
  readonly pagePath: string;
  readonly locale: PromptLocale;
  readonly fetchedAt?: Date;
  readonly documentId?: string;
}

function buildPrompt(
  promptBody: string,
  pagePath: string,
  spotlightedSource: string,
  existingPageContent: string,
): string {
  // The page-path hint lets the test corpus' MockLlmClient route
  // multiple page calls to distinct registered responses by
  // matching on `promptIncludes: '<page_path>'`. Production
  // routing is unaffected — the model gets the same hint as
  // operator context.
  return [
    promptBody,
    "",
    `# Target page: ${pagePath}`,
    "",
    "<existing_page>",
    existingPageContent,
    "</existing_page>",
    "",
    spotlightedSource,
  ].join("\n");
}

export async function mergePage(args: MergePageArgs): Promise<MergedPageBody> {
  const fetchedAt = args.fetchedAt ?? new Date();
  const envelope = spotlight({
    content: args.sourceContent,
    source: args.sourceRef,
    fetchedAt,
  });

  const prompt = await loadPromptForScope({
    name: "compiler",
    locale: args.locale,
    domainId: args.domainId,
    db: args.db,
  });
  const fullPrompt = buildPrompt(
    prompt.body,
    args.pagePath,
    envelope,
    args.existingPageContent,
  );

  const result = await args.router.generateObject({
    domainId: args.domainId,
    tier: "thinker",
    pipelineOrAgent: "compiler",
    prompt: fullPrompt,
    schema: MERGED_PAGE_BODY_SCHEMA,
    ...(args.documentId !== undefined ? { documentId: args.documentId } : {}),
  });

  const wire = result.object;

  // Backstop sentinel scrub: the prompt told the model not to
  // include `<source_content` literals; if it did anyway, the
  // safest action is to DLQ rather than commit a poisoned page.
  if (wire.merged_body.includes("<source_content")) {
    throw new CompilerValidationError(
      `mergePage: merged_body contains literal <source_content sentinel for page '${args.pagePath}'`,
    );
  }
  // Backstop frontmatter scrub: the model is supposed to emit only
  // the body BELOW the frontmatter; the compiler builds the YAML
  // block separately. A model that opens with `---` is trying to
  // hijack the frontmatter.
  if (wire.merged_body.startsWith("---")) {
    throw new CompilerValidationError(
      `mergePage: merged_body for page '${args.pagePath}' starts with '---' — model tried to write its own frontmatter`,
    );
  }

  // PR-W1 page-citations contract: when an override is active,
  // the persisted `prompt_version` is the override's semver
  // (`overridesVersion`), NOT the shipped baseline. Triage flows
  // can still resolve back to the baseline because the override
  // row stores `baseline_version` alongside.
  const persistedPromptVersion =
    prompt.override?.overridesVersion ?? prompt.version;

  return {
    mergedBody: wire.merged_body,
    worldviewImpact: [...wire.worldview_impact],
    promptVersion: persistedPromptVersion,
  };
}
