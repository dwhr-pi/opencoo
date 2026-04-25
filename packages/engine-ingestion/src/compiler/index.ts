// Public surface for the Compiler subsystem (architecture §6.6
// Layer 2, plan #72). The Scanner pipeline (PR 18+) drives
// `compile` after the Classifier returns.

export {
  compile,
  type CompileArgs,
  type CompileResult,
  type ReviewDispatchEvent,
  type ReviewDispatchHook,
} from "./compiler.js";
export {
  CompilerValidationError,
} from "./errors.js";
export {
  buildFrontmatter,
  type BuildFrontmatterArgs,
} from "./frontmatter.js";
export {
  mergePage,
  type MergePageArgs,
} from "./merge-page.js";
export {
  normaliseWorldviewImpact,
} from "./worldview-impact.js";
export {
  recordPageCitations,
  type RecordPageCitationsArgs,
} from "./page-citations.js";
export {
  CATALOG_WORKFLOW_PROMPT_VERSION,
  buildCatalogWorkflowBody,
  catalogPagePathForWorkflow,
  compileCatalogWorkflow,
  parseCatalogWorkflowBody,
  slugifyName,
  type BuildCatalogWorkflowBodyArgs,
  type BuildCatalogWorkflowBodyResult,
  type CatalogWorkflowInput,
  type CompileCatalogWorkflowArgs,
  type CompileCatalogWorkflowResult,
} from "./catalog-workflow.js";
export {
  MERGED_PAGE_BODY_SCHEMA,
  type MergedPageBody,
  type MergedPageBodyWire,
} from "./types.js";
