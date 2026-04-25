/**
 * Public surface for `@opencoo/source-n8n` (PR 26 / plan #122).
 *
 * SourceAdapter that polls the n8n REST API for tagged
 * workflows and emits each as a `content_kind: 'n8n-workflow'`
 * document. The engine-ingestion compilation-worker dispatches
 * these to the deterministic `compileCatalogWorkflow` template
 * (no LLM); the lossless round-trip across a fenced JSON block
 * is the load-bearing assertion (architecture §6.3.1, plan #122).
 */
export {
  N8N_DEFAULT_TAG_FILTER,
  n8nBindingConfigSchema,
  type N8nBindingConfig,
} from "./binding-config.js";

export {
  N8N_ADAPTER_SLUG,
  createN8nSourceAdapter,
  computeWorkflowRevision,
  canonicalBytes,
  type CreateN8nSourceAdapterArgs,
  type MakeN8nListingApi,
} from "./adapter.js";

export {
  type N8nListWorkflowsArgs,
  type N8nListWorkflowsResult,
  type N8nListingApi,
  type N8nWorkflowSummary,
} from "./n8n-listing-api.js";
