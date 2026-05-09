import type { Logger } from "../logger.js";

// Per-token pricing for supported models as of 2026-Q2. Numbers are
// USD per SINGLE token (not per thousand) to avoid a mental unit
// shift at call sites. Update as vendor price sheets change — a
// stale entry that's too low lets cost slip past the cap; too high
// just over-reserves budget (fail-safe). The budget-cap path reads
// these directly; do not fork the constants into a second source.
export interface PricingEntry {
  readonly inputPerToken: number;
  readonly outputPerToken: number;
}

export const PRICING: Readonly<Record<string, PricingEntry>> = {
  // OpenAI (2026 rates; per-token = per-1M/1e6).
  "gpt-4o-mini": { inputPerToken: 0.00000015, outputPerToken: 0.0000006 },
  "gpt-4o": { inputPerToken: 0.0000025, outputPerToken: 0.00001 },
  "gpt-4-turbo": { inputPerToken: 0.00001, outputPerToken: 0.00003 },
  "o1-mini": { inputPerToken: 0.0000011, outputPerToken: 0.0000044 },
  // PR-W2: o1 listed in MODEL_CATALOG ($15/M in, $60/M out per OpenAI's
  // 2026 reasoning-tier price sheet).
  o1: { inputPerToken: 0.000015, outputPerToken: 0.00006 },
  // Anthropic.
  "claude-3-5-sonnet-latest": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
  },
  "claude-3-5-haiku-latest": {
    inputPerToken: 0.0000008,
    outputPerToken: 0.000004,
  },
  "claude-3-opus-latest": {
    inputPerToken: 0.000015,
    outputPerToken: 0.000075,
  },
  // PR-W2: Anthropic catalog members (4-series, dated snapshot). The
  // *-latest aliases above remain priced for any deployment still using
  // them. Opus / Sonnet / Haiku follow the established Anthropic
  // tier shape ($15/$75, $3/$15, $0.80/$4 per million).
  "claude-opus-4-7": {
    inputPerToken: 0.000015,
    outputPerToken: 0.000075,
  },
  "claude-sonnet-4-6": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
  },
  "claude-haiku-4-5": {
    inputPerToken: 0.0000008,
    outputPerToken: 0.000004,
  },
  "claude-3-5-sonnet-20241022": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
  },
  // Google.
  "gemini-2.0-flash": { inputPerToken: 0.0000001, outputPerToken: 0.0000004 },
  "gemini-1.5-pro": { inputPerToken: 0.00000125, outputPerToken: 0.000005 },
  // PR-W2: remaining Google catalog members. Flash-thinking shares
  // 2.0-flash's standard-output rate (Google bills thinking tokens as
  // output tokens at the same per-token price); 1.5-flash matches the
  // published $0.075/M in + $0.30/M out tier.
  "gemini-2.0-flash-thinking": {
    inputPerToken: 0.0000001,
    outputPerToken: 0.0000004,
  },
  "gemini-1.5-flash": {
    inputPerToken: 0.000000075,
    outputPerToken: 0.0000003,
  },
  // OpenRouter (PR-W2). The provider-prefixed slugs are distinct
  // billable rows from the direct-vendor entries above. Mirroring
  // upstream direct-vendor rates ignores OpenRouter's small markup
  // (typically 5-10%); the cost dashboard will under-report for
  // OpenRouter routes by that margin until v0.2 fetches the actual
  // rate from OpenRouter's /models endpoint daily and overwrites
  // these (per the CHANGES-v0.1.md appendix #11 W2 note). Note that
  // FALLBACK_PRICING does NOT compensate here — it only applies for
  // models NOT present in this table; once an entry exists, costFor()
  // uses it directly.
  // moonshotai/kimi-k2.6 is the design-partner-pinned model across
  // all three tiers; verify against https://openrouter.ai/moonshotai/kimi-k2.6
  // before each tag.
  "moonshotai/kimi-k2.6": {
    inputPerToken: 0.0000006,
    outputPerToken: 0.0000025,
  },
  "anthropic/claude-sonnet-4": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
  },
  "anthropic/claude-opus-4-7": {
    inputPerToken: 0.000015,
    outputPerToken: 0.000075,
  },
  "openai/gpt-4o": { inputPerToken: 0.0000025, outputPerToken: 0.00001 },
  "google/gemini-2.0-flash": {
    inputPerToken: 0.0000001,
    outputPerToken: 0.0000004,
  },
  "deepseek/deepseek-r1": {
    inputPerToken: 0.00000055,
    outputPerToken: 0.00000219,
  },
};

// Used when the model name isn't in PRICING. Chosen to be slightly
// higher than the cheapest known model so the budget-cap path
// overestimates rather than under-counts an unknown call. A warn-
// level log event fires once so ops sees the unknown model.
export const FALLBACK_PRICING: PricingEntry = {
  inputPerToken: 0.000003,
  outputPerToken: 0.000015,
};

export interface CostForOptions {
  readonly logger?: Logger;
}

export function costFor(
  model: string,
  tokensIn: number,
  tokensOut: number,
  options: CostForOptions = {},
): number {
  const entry = PRICING[model];
  if (entry === undefined) {
    options.logger?.warn("cost-tracker.unknown_model", { model });
  }
  const rates = entry ?? FALLBACK_PRICING;
  return tokensIn * rates.inputPerToken + tokensOut * rates.outputPerToken;
}
