/**
 * `classify()` — Classifier orchestrator.
 *
 * Wires the four §3.4 fail-closed layers together:
 *   1. Binding-guard — refuse wildcard-only `allowed_paths` BEFORE
 *      the LLM is invoked. A compromised binding is a config bug,
 *      not a poison signal; we don't waste an LLM call on it.
 *   2. Spotlight — wrap the source content in the
 *      `<source_content>` envelope so the prompt can disclaim it.
 *   3. Strict Zod — `generateObject<ClassifierOutput>` parses the
 *      LLM's JSON and rejects unknown fields (`.strict()`).
 *   4. Domain + path guards — cross-check `target_domains` against
 *      `allowedDomains` and every `page_paths` entry against the
 *      binding's `allowed_paths` glob list.
 *
 * Failure in any layer throws a typed error the caller (Scanner
 * pipeline, PR 16+) routes to DLQ:
 *   - `BindingConfigError`        — config layer
 *   - `LlmProviderError`          — LLM call / Zod-strict parse
 *   - `ClassifierValidationError` — cross-domain or other
 *                                   orchestrator-level violation
 *   - `ClassifierPathError`       — path outside allow-list
 *                                   (also covers shape-guard rejects
 *                                    via WikiPathError chained cause)
 *
 * No retry on any of these — adversarial signals get DLQ'd, not
 * re-tried with the same prompt.
 */

import { loadPromptForScope, type PromptLocale, type ScopeResolverDb } from "@opencoo/shared/prompts";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { DomainId } from "@opencoo/shared/db";

import { assertBindingNotWildcardOnly } from "./binding-guard.js";
import { ClassifierValidationError } from "./errors.js";
import { validateAllowedPath } from "./path-guard.js";
import { spotlight } from "./spotlight.js";
import {
  CLASSIFIER_OUTPUT_SCHEMA,
  type ClassifierOutput,
} from "./types.js";

export interface ClassifyArgs {
  readonly router: LlmRouter;
  /** Drizzle handle for the per-(domain) prompt-override lookup
   *  (`loadPromptForScope`). The orchestrator already has a db
   *  handle for the surrounding intake-row UPDATE; we thread the
   *  same handle through so the classifier reads from the same
   *  consistency snapshot. */
  readonly db: ScopeResolverDb;
  readonly domainId: DomainId;
  readonly sourceRef: string;
  readonly content: string;
  readonly locale: PromptLocale;
  readonly allowedPaths: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly fetchedAt?: Date;
  readonly documentId?: string;
}

export async function classify(args: ClassifyArgs): Promise<ClassifierOutput> {
  // Layer 1 — config layer. Fail closed before the LLM is invoked.
  assertBindingNotWildcardOnly(args.allowedPaths);

  // Layer 2 — spotlight envelope.
  const fetchedAt = args.fetchedAt ?? new Date();
  const envelope = spotlight({
    content: args.content,
    source: args.sourceRef,
    fetchedAt,
  });

  const prompt = await loadPromptForScope({
    name: "classifier",
    locale: args.locale,
    domainId: args.domainId,
    db: args.db,
  });

  // Inject the binding's allowed_domains and allowed_paths as a
  // runtime-constructed constraints block BETWEEN the prompt body
  // (which references "the binding's allowed_domains/allowed_paths"
  // in the abstract) and the spotlight envelope (the untrusted
  // source content). Without this, the LLM has no per-run list of
  // valid slugs/paths and hallucinates them from the document
  // body — every emission then fails Layer 4 below, DLQ'ing the
  // run. Each value is `JSON.stringify`'d so glob characters,
  // unicode, and embedded quotes round-trip unambiguously.
  const bindingConstraints = [
    "# Binding constraints (this run only)",
    "",
    "These are the ONLY values you may emit:",
    "",
    `- allowed_domains (you MUST pick one of these for every \`target_domains[].domain_slug\`):`,
    ...args.allowedDomains.map((d) => `    - ${JSON.stringify(d)}`),
    "",
    `- allowed_paths (every \`target_domains[].page_paths[*]\` must match one of these globs):`,
    ...args.allowedPaths.map((p) => `    - ${JSON.stringify(p)}`),
    "",
    "Any other value is rejected and the run is DLQ'd. If the document spans multiple of these allowed paths, list them in `page_paths`; do NOT invent new ones.",
  ].join("\n");

  const fullPrompt = `${prompt.body}\n\n${bindingConstraints}\n\n${envelope}`;

  // Layer 3 — LLM call + strict-Zod parse. `generateObject` wraps
  // any Zod failure in `LlmProviderError` (errorClass:'validation')
  // which is the correct DLQ signal.
  const result = await args.router.generateObject({
    domainId: args.domainId,
    tier: "worker",
    pipelineOrAgent: "classifier",
    prompt: fullPrompt,
    schema: CLASSIFIER_OUTPUT_SCHEMA,
    ...(args.documentId !== undefined ? { documentId: args.documentId } : {}),
  });

  const wire = result.object;

  // Layer 4 — orchestrator-level checks the schema can't express:
  //   - target_domains[].domain_slug ∈ allowedDomains
  //   - target_domains[].page_paths[*] passes the binding path guard
  const allowedDomainSet = new Set(args.allowedDomains);
  for (const td of wire.target_domains) {
    if (!allowedDomainSet.has(td.domain_slug)) {
      throw new ClassifierValidationError(
        `classifier emitted domain_slug '${td.domain_slug}' not in allowedDomains ${JSON.stringify(args.allowedDomains)}`,
      );
    }
    for (const pp of td.page_paths) {
      // Throws ClassifierPathError on failure — both shape-guard
      // rejects (wrapped from WikiPathError, preserved as `.cause`)
      // and glob-mismatch rejects surface as the same type so the
      // caller routes path failures uniformly.
      validateAllowedPath(pp, args.allowedPaths);
    }
  }

  // Normalise wire shape (snake_case) to camelCase for the rest of
  // the engine. Read-only `as const` casts keep the literal types.
  return {
    version: wire.version,
    language: wire.language,
    summary: wire.summary,
    targetDomains: wire.target_domains.map((td) => ({
      domainSlug: td.domain_slug,
      pagePaths: [...td.page_paths],
    })),
    pipelines: [...wire.pipelines],
  };
}
