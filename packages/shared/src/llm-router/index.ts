export {
  LlmBudgetExceededError,
  LlmPolicyViolationError,
  LlmProviderError,
} from "./errors.js";
export {
  FALLBACK_POLICY,
  llmPolicySchema,
  llmPolicyTierSchema,
  PROVIDERS,
  type LlmPolicy,
  type ProviderName,
  type Tier,
} from "./llm-policy.js";
export {
  InMemoryQueuePauser,
  type QueuePauser,
} from "./queue-pauser.js";
export {
  type GenerateObjectOpts,
  type GenerateObjectResult,
  type GenerateOpts,
  type GenerateTextResult,
  type LlmProvider,
  type LlmProviderCall,
  type LlmProviderResponse,
} from "./interface.js";
export {
  LlmRouter,
  type LlmRouterDb,
  type LlmRouterOptions,
} from "./router.js";
export { MockLlmClient } from "./testing/mock-llm-client.js";

// OpenRouter provider helper — test-only, gated on RUN_REAL_LLM=1
// in the classifier injection corpus. NOT registered in the closed
// PROVIDERS tuple; production code never selects it.
export {
  createOpenRouterProvider,
  type OpenRouterProviderOptions,
} from "./providers/openrouter.js";

// Production multi-provider dispatcher factory (PR-M2, phase-a
// appendix #5). The CLI's serve.ts composition root calls
// `createProvider(name, opts)` per `LlmProviderCall.provider` to
// route the LLM call to the right `@ai-sdk/*` package.
export {
  createProvider,
  type ProviderOptions,
} from "./providers/index.js";
