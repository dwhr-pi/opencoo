// Public surface for the 5 v0.1 ingestion pipelines (PR 17,
// architecture §9). The composition root (PR 30 CLI) wires
// each function to its BullMQ queue + scheduler; tests import
// the pure functions directly with mock dependencies.

export {
  buildIndexBody,
  runIndexRebuilder,
  type IndexRebuilderResult,
  type RunIndexRebuilderArgs,
} from "./index-rebuilder.js";

export {
  DEFAULT_DEBUG_RETENTION_DAYS,
  runCleanup,
  type CleanupResult,
  type RunCleanupArgs,
} from "./cleanup.js";

export {
  REVIEW_DISPATCH_QUEUE_SLUG,
  ReviewDispatchPayloadSchema,
  runReviewDispatcher,
  type ReviewDispatchPayload,
  type ReviewDispatchResult,
  type RunReviewDispatcherArgs,
} from "./review-dispatcher.js";

export {
  INLINE_CONTENT_CAP_BYTES,
  SCANNER_CLASSIFY_QUEUE_SLUG,
  runScanner,
  type RunScannerArgs,
  type ScannerClassifyJob,
  type ScannerEnqueue,
  type ScannerResult,
  type SourceAdapterRegistry,
} from "./scanner.js";

export {
  runCompilationWorker,
  type CompilationWorkerResult,
  type RunCompilationWorkerArgs,
} from "./compilation-worker.js";
