/**
 * Company-aggregator worldview compiler (PR 22 / plan #106).
 *
 * Runs on the (at most one) `is_aggregator=true` domain and
 * compiles `company.md` from every other domain's
 * `worldview.md`. The LOAD-BEARING sovereignty constraint:
 *
 *   The company-compile MUST NOT call `wikiAdapter.readPage`
 *   with `path !== 'worldview.md'` for non-aggregator
 *   domains. Each domain's underlying pages stay within that
 *   domain's LLM-policy boundary; only the bounded synthesis
 *   crosses.
 *
 * Two enforcement layers:
 *   1. **Code structure** — this file's loop only ever calls
 *      `readPage(slug, 'worldview.md')`. There is no other
 *      readPage call site.
 *   2. **Wrapper guard** — the integration test wraps the
 *      WikiAdapter in a spy that throws
 *      `WorldviewSovereigntyError` on any readPage call where
 *      `path !== 'worldview.md'` AND the domain is not the
 *      aggregator itself. Production wires the same wrapper
 *      at the engine boot path so a future refactor that
 *      breaks structure still fails loud.
 */
import { spotlight } from "@opencoo/shared/spotlight";
import {
  loadPromptForScope,
  type ScopeResolverDb,
} from "@opencoo/shared/prompts";
import type { DomainId, DomainSlug } from "@opencoo/shared/db";
import { LlmProviderError, type LlmRouter } from "@opencoo/shared/llm-router";
import type { WikiAdapter } from "@opencoo/shared/wiki-write";

import { WorldviewOverflowError } from "./errors.js";
import {
  WORLDVIEW_BODY_MAX_BYTES,
  WORLDVIEW_OUTPUT_SCHEMA,
  utf8ByteLength,
  type WorldviewOutput,
} from "./types.js";

const COMPRESS_FURTHER_SUFFIX = `

# RETRY — compress further

Your previous response was REJECTED for exceeding the
${WORLDVIEW_BODY_MAX_BYTES}-byte UTF-8 cap. Compress further:
drop redundant phrasings, prefer bullets over prose, prefer
one sentence over two. Do NOT extend; SHRINK.
`;

/**
 * The ONE path the aggregator is allowed to read from
 * non-aggregator domains. Centralised here so the
 * sovereignty-spy wrapper and the orchestrator both reference
 * the same string.
 */
export const SOVEREIGN_AGGREGATOR_INPUT_PATH = "worldview.md";

export interface CompileCompanyArgs {
  readonly router: LlmRouter;
  readonly wikiAdapter: WikiAdapter;
  /** Drizzle handle for the PR-W1 prompt-override resolver.
   *  Routed against the aggregator's `domainId` (its llm_policy
   *  bounds the aggregation call); a per-aggregator-domain
   *  override of `worldview-company` wins over the shipped
   *  baseline. */
  readonly db: ScopeResolverDb;
  /** The aggregator's own domainId — used to route the LLM
   *  call (its llm_policy applies). */
  readonly aggregatorDomainId: DomainId;
  /** Slugs of every NON-aggregator domain to fold into the
   *  company.md. The compiler reads ONLY 'worldview.md' from
   *  each. The aggregator's own slug is enforced by the
   *  `SovereigntySpyWikiAdapter` wrapper (constructed at the
   *  engine boot path with its own `aggregatorOwnSlug` arg);
   *  this function does not need it. */
  readonly nonAggregatorDomainSlugs: readonly DomainSlug[];
  readonly locale: "en" | "pl" | "auto";
  readonly fetchedAt?: Date;
}

export interface CompileCompanyResult {
  readonly body: string;
  readonly bodyBytes: number;
  readonly retried: boolean;
  /** Slugs whose worldview.md was successfully read +
   *  included. Slugs that didn't have a compiled worldview yet
   *  are skipped (logged separately by the orchestrator). */
  readonly contributingSlugs: readonly DomainSlug[];
}

export async function compileCompanyWorldview(
  args: CompileCompanyArgs,
): Promise<CompileCompanyResult> {
  const fetchedAt = args.fetchedAt ?? new Date();

  // Read ONLY 'worldview.md' from each non-aggregator domain.
  // This is the sovereignty pin — there is exactly one
  // readPage call site in this file, and the path arg is
  // hardcoded to SOVEREIGN_AGGREGATOR_INPUT_PATH.
  const inputs: Array<{ slug: DomainSlug; body: string }> = [];
  for (const slug of args.nonAggregatorDomainSlugs) {
    const page = await args.wikiAdapter.readPage(
      slug,
      SOVEREIGN_AGGREGATOR_INPUT_PATH,
    );
    if (page === null) continue; // domain hasn't compiled its worldview yet
    inputs.push({ slug, body: page.content });
  }

  const prompt = await loadPromptForScope({
    name: "worldview-company",
    locale: args.locale,
    domainId: args.aggregatorDomainId,
    db: args.db,
  });

  const envelopes = inputs
    .map((input) =>
      spotlight({
        content: input.body,
        source: `worldview://${input.slug}`,
        fetchedAt,
      }),
    )
    .join("\n\n");

  const baseFullPrompt = `${prompt.body}\n\n# Per-domain worldviews\n${envelopes}`;

  const first = await tryGenerate({
    router: args.router,
    domainId: args.aggregatorDomainId,
    prompt: baseFullPrompt,
  });
  if (first.kind === "ok") {
    return {
      body: first.value.body,
      bodyBytes: utf8ByteLength(first.value.body),
      retried: false,
      contributingSlugs: inputs.map((i) => i.slug),
    };
  }

  const retry = await tryGenerate({
    router: args.router,
    domainId: args.aggregatorDomainId,
    prompt: `${baseFullPrompt}${COMPRESS_FURTHER_SUFFIX}`,
  });
  if (retry.kind === "ok") {
    return {
      body: retry.value.body,
      bodyBytes: utf8ByteLength(retry.value.body),
      retried: true,
      contributingSlugs: inputs.map((i) => i.slug),
    };
  }

  // We don't have access to the rejected body bytes from the
  // Zod issue (same limitation as compile-domain.ts:135) — pass
  // `undefined` so the formatted error reads "(attempted bytes
  // unknown)" rather than the misleading "(attempted 0)".
  throw new WorldviewOverflowError(undefined, WORLDVIEW_BODY_MAX_BYTES);
}

async function tryGenerate(args: {
  readonly router: LlmRouter;
  readonly domainId: DomainId;
  readonly prompt: string;
}): Promise<
  | { kind: "ok"; value: WorldviewOutput }
  | { kind: "overflow" }
> {
  try {
    const result = await args.router.generateObject({
      domainId: args.domainId,
      tier: "thinker",
      pipelineOrAgent: "worldview-company",
      prompt: args.prompt,
      schema: WORLDVIEW_OUTPUT_SCHEMA,
    });
    return { kind: "ok", value: result.object };
  } catch (err) {
    if (
      err instanceof LlmProviderError &&
      isWorldviewOverflowZodError(err)
    ) {
      return { kind: "overflow" };
    }
    throw err;
  }
}

function isWorldviewOverflowZodError(err: unknown): boolean {
  const cause = (err as { cause?: unknown }).cause;
  if (cause === undefined || cause === null) return false;
  const issues = (cause as { issues?: ReadonlyArray<{ message?: string }> })
    .issues;
  if (!Array.isArray(issues)) return false;
  return issues.some(
    (i) =>
      typeof i.message === "string" && i.message.includes("byte UTF-8 cap"),
  );
}
