// Public surface for @opencoo/shared/prompts. Concrete pipelines
// (classifier today; compiler / lint in PR 16-17) consume this
// module; PR 14 webhook receiver does not — it doesn't make LLM
// calls.

export {
  loadPrompt,
  loadPromptForScope,
  PROMPT_NAMES,
  PROMPT_LOCALES,
  type LoadPromptArgs,
  type LoadPromptForScopeArgs,
  type LoadedPrompt,
  type LoadedPromptWithOverride,
  type PromptLocale,
  type PromptName,
  type PromptOverrideRef,
  type ScopeResolverDb,
} from "./loader.js";
export {
  PROMPT_VERSION_MANIFEST,
  type PromptVersionManifest,
} from "./version-manifest.js";
