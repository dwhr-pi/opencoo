/**
 * Per-domain worldview compiler (PR 22 / plan #106).
 *
 * Reads the domain's pages via the WikiAdapter, asks the LLM
 * (thinker tier) to produce the bounded `worldview.md`
 * synthesis, and returns the resulting body. The orchestrator
 * (compile-pipeline.ts) is responsible for writing the body
 * via wikiWrite + tag `[compiler]`.
 *
 * Token-cap retry (LOAD-BEARING):
 *   - First attempt uses the worldview-domain prompt as-is.
 *   - If Zod-strict rejects (body > 24 KB UTF-8), retry once
 *     with a "compress further" suffix.
 *   - If retry also fails, throw `WorldviewOverflowError`
 *     (validation → DLQ).
 *
 * Spotlighting:
 *   - Every page body wrapped in <source_content> envelope.
 *   - Page paths are not trusted; we don't echo them as
 *     instructions, only as labelled headings.
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

export interface CompileDomainArgs {
  readonly router: LlmRouter;
  readonly wikiAdapter: WikiAdapter;
  /** Drizzle handle for the PR-W1 prompt-override resolver.
   *  Worldview-domain compiles are domain-scoped (no agent
   *  instance), so the resolver picks the domain-scoped row if
   *  one exists, otherwise the shipped baseline. */
  readonly db: ScopeResolverDb;
  readonly domainId: DomainId;
  readonly domainSlug: DomainSlug;
  readonly locale: "en" | "pl" | "auto";
  /** The non-`worldview.md` page paths in the domain. The
   *  compiler reads each via `wikiAdapter.readPage` and
   *  passes the bodies to the LLM. */
  readonly pagePaths: readonly string[];
  readonly fetchedAt?: Date;
}

export interface CompileDomainResult {
  readonly body: string;
  readonly bodyBytes: number;
  /** Whether the cap retry path fired. Tests use this to
   *  pin the retry semantics; production logs at info. */
  readonly retried: boolean;
}

export async function compileDomainWorldview(
  args: CompileDomainArgs,
): Promise<CompileDomainResult> {
  const fetchedAt = args.fetchedAt ?? new Date();

  // Read every page body via the adapter. Sovereignty-wise,
  // this is OK because a per-domain compile reads ONLY pages
  // within the same domain — the domain's LLM policy bounds
  // the data path. The company-aggregator pipeline is the
  // one that has to be careful (compile-company.ts).
  const pageEntries: Array<{ path: string; body: string }> = [];
  for (const path of args.pagePaths) {
    const page = await args.wikiAdapter.readPage(args.domainSlug, path);
    if (page === null) continue; // page deleted between list + read; skip
    pageEntries.push({ path, body: page.content });
  }

  const prompt = await loadPromptForScope({
    name: "worldview-domain",
    locale: args.locale,
    domainId: args.domainId,
    db: args.db,
  });

  const envelopes = pageEntries
    .map((p) =>
      spotlight({
        content: p.body,
        source: `wiki://${args.domainSlug}/${p.path}`,
        fetchedAt,
      }),
    )
    .join("\n\n");

  const baseFullPrompt = `${prompt.body}\n\n# Domain pages\n${envelopes}`;

  const result = await tryGenerate({
    router: args.router,
    domainId: args.domainId,
    pipelineOrAgent: "worldview-domain",
    prompt: baseFullPrompt,
  });
  if (result.kind === "ok") {
    return {
      body: result.value.body,
      bodyBytes: utf8ByteLength(result.value.body),
      retried: false,
    };
  }

  // Retry once with the compress-further suffix.
  const retryPrompt = `${baseFullPrompt}${COMPRESS_FURTHER_SUFFIX}`;
  const retry = await tryGenerate({
    router: args.router,
    domainId: args.domainId,
    pipelineOrAgent: "worldview-domain",
    prompt: retryPrompt,
  });
  if (retry.kind === "ok") {
    return {
      body: retry.value.body,
      bodyBytes: utf8ByteLength(retry.value.body),
      retried: true,
    };
  }

  // Still over cap — give up. We surface `observedBytes` if the
  // upstream LlmProviderError happened to carry it, else
  // `undefined` (the error formatter prints "unknown" rather
  // than a misleading 0).
  throw new WorldviewOverflowError(
    result.observedBytes,
    WORLDVIEW_BODY_MAX_BYTES,
  );
}

/**
 * Single attempt at the LLM call. Returns ok | overflow.
 * Overflow is detected by Zod's refinement on body byte count;
 * any other Zod failure is a different bug and re-thrown.
 */
async function tryGenerate(args: {
  readonly router: LlmRouter;
  readonly domainId: DomainId;
  readonly pipelineOrAgent: string;
  readonly prompt: string;
}): Promise<
  | { kind: "ok"; value: WorldviewOutput }
  | { kind: "overflow"; observedBytes: number | undefined }
> {
  try {
    const result = await args.router.generateObject({
      domainId: args.domainId,
      tier: "thinker",
      pipelineOrAgent: args.pipelineOrAgent,
      prompt: args.prompt,
      schema: WORLDVIEW_OUTPUT_SCHEMA,
    });
    return { kind: "ok", value: result.object };
  } catch (err) {
    if (
      err instanceof LlmProviderError &&
      isWorldviewOverflowZodError(err)
    ) {
      return { kind: "overflow", observedBytes: extractObservedBytes(err) };
    }
    throw err;
  }
}

/**
 * The Zod refinement message is the structural signal for
 * "too big" — we match on it because LlmProviderError wraps
 * the Zod error and doesn't surface a typed handle. Production
 * `LlmProviderError.cause` is the ZodError instance; we
 * walk it to find the byte-cap refinement.
 */
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

function extractObservedBytes(err: unknown): number | undefined {
  // The Zod refinement that fires for over-cap bodies doesn't
  // surface the rejected body's byte count on the issue object
  // (only its message). We *could* re-parse `err.cause` and
  // walk the issue path back to the input, but Zod doesn't
  // attach the raw input to its issues at runtime — so v0.1
  // returns undefined here and `WorldviewOverflowError`
  // formats the field as "unknown" rather than 0.
  void err;
  return undefined;
}
