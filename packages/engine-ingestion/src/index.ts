// Public surface for @opencoo/engine-ingestion. Concrete pipelines
// (PRs 14-17) consume these exports; the runtime composition root
// (PR 30 CLI) imports `start` to launch the engine.

export {
  loadEngineConfig,
  type EngineConfig,
} from "./config.js";
export {
  PipelineRegistry,
} from "./registry.js";
export {
  buildIngestionQueue,
  INGESTION_QUEUE_PREFIX,
  type BuildIngestionQueueOptions,
} from "./queue.js";
export {
  buildServer,
  type BuildServerOptions,
  type ProbeFn,
  type ProbeMap,
} from "./server.js";
export {
  postgresProbe,
  type PostgresProbeTarget,
} from "./probes/postgres.js";
export {
  redisProbe,
  type RedisProbeTarget,
} from "./probes/redis.js";
export type { ProbeResult } from "./probes/types.js";
export {
  start,
  mountWebhookRoute,
  type IngestionStartMode,
  type StartedEngine,
  type StartOptions,
} from "./start.js";

// Production WorkerContext composition (PR-M2, phase-a appendix #5).
// The orchestrator (CLI `serve.ts`) constructs the heavy ingredients
// (db pool, Redis, WikiAdapter, GuardAdapter, LlmRouter,
// CredentialStore, source-adapter factories) and hands them to
// `composeProductionWorkerContext` which returns the WorkerContext the
// engine's `start({ mode: 'workers' })` consumes.
export {
  composeProductionWorkerContext,
  SCANNER_CRON_DEFAULT,
  SCANNER_REPEAT_KEY,
  type ComposeProductionContextArgs,
  type ProductionSourceAdapterFactory,
  type ProductionWorkerContext,
} from "./workers/production-context.js";

// Workers public surface (PR-M1, phase-a appendix #5). The
// orchestrator (CLI `serve.ts`) constructs a WorkerContext and
// passes it into `start({ mode: 'workers', workerContext, ... })`
// to boot the per-pipeline BullMQ Workers. Tests can also import
// `startIngestionWorkers` directly for use-case coverage.
export {
  DEFAULT_CLOSE_TIMEOUT_MS,
  MISSING_ENQUEUE,
  MISSING_ENQUEUE_MESSAGE,
  buildCleanupHandler,
  buildCompilationHandler,
  buildIndexRebuildHandler,
  buildReviewDispatchHandler,
  buildScannerHandler,
  startIngestionWorkers,
  startCleanupWorker,
  startCompileWorker,
  startIndexRebuildWorker,
  startReviewDispatchWorker,
  startScannerWorker,
  type CleanupWorkerDeps,
  type CompileWorkerDeps,
  type IndexRebuildWorkerDeps,
  type IngestionRunEvent,
  type IngestionRunEventEmitter,
  type IngestionWorkers,
  type ReviewDispatchWorkerDeps,
  type ScannerWorkerDeps,
  type StartIngestionWorkersArgs,
  type WorkerContext,
} from "./workers/index.js";
export type {
  PipelineDefinition,
  PipelineContext,
} from "./types.js";

// Intake surface (PR 14): receiver + reusable record helpers + DI types.
export {
  AdapterNotFoundError,
  IntakeValidationError,
  WebhookSignatureError,
} from "./intake/errors.js";
export {
  InMemoryAdapterRegistry,
  type SourceAdapterStub,
} from "./intake/adapter-registry.js";
export {
  recordIntake,
  type RecordIntakeArgs,
  type RecordIntakeResult,
} from "./intake/record-intake.js";
export {
  recordWebhook,
  type RecordWebhookArgs,
  type RecordWebhookResult,
} from "./intake/record-webhook.js";
export {
  buildWebhookReceiver,
  registerWebhookRoute,
  WEBHOOK_BODY_LIMIT_BYTES,
  type WebhookReceiverOptions,
  type WebhookQueueLike,
} from "./intake/webhook-receiver.js";

// Classifier surface (PR 15): orchestrator + guards + spotlight.
// Adversarial-LLM defenses per THREAT-MODEL §3.4. The Scanner
// pipeline (PR 18+) consumes `classify` and the typed errors for
// DLQ routing.
export {
  classify,
  ClassifierValidationError,
  spotlight,
  assertBindingNotWildcardOnly,
  BindingConfigError,
  validateAllowedPath,
  ClassifierPathError,
  CLASSIFIER_OUTPUT_SCHEMA,
  TARGET_DOMAIN_SCHEMA,
  type ClassifyArgs,
  type ClassifierOutput,
  type ClassifierOutputWire,
  type ClassifierTargetDomain,
  type SpotlightArgs,
} from "./classifier/index.js";

// Compiler surface (PR 16, plan #72): orchestrator + LLM merge
// + frontmatter + page-citations + worldview-impact normalisation.
// Reads the Classifier's page_paths and produces atomic wiki commits.
export {
  compile,
  CompilerValidationError,
  buildFrontmatter,
  mergePage,
  normaliseWorldviewImpact,
  recordPageCitations,
  MERGED_PAGE_BODY_SCHEMA,
  type CompileArgs,
  type CompileResult,
  type BuildFrontmatterArgs,
  type MergePageArgs,
  type RecordPageCitationsArgs,
  type MergedPageBody,
  type MergedPageBodyWire,
  type ReviewDispatchEvent,
  type ReviewDispatchHook,
} from "./compiler/index.js";

// Pipelines surface (PR 17, plan #77): the 5 v0.1 ingestion
// pipelines. The composition root (PR 30 CLI) wires each one
// to its BullMQ queue + scheduler.
export {
  buildIndexBody,
  runIndexRebuilder,
  DEFAULT_DEBUG_RETENTION_DAYS,
  runCleanup,
  REVIEW_DISPATCH_QUEUE_SLUG,
  ReviewDispatchPayloadSchema,
  runReviewDispatcher,
  INLINE_CONTENT_CAP_BYTES,
  SCANNER_CLASSIFY_QUEUE_SLUG,
  runScanner,
  runCompilationWorker,
  type IndexRebuilderResult,
  type RunIndexRebuilderArgs,
  type CleanupResult,
  type RunCleanupArgs,
  type ReviewDispatchPayload,
  type ReviewDispatchResult,
  type RunReviewDispatcherArgs,
  type RunScannerArgs,
  type ScannerClassifyJob,
  type ScannerEnqueue,
  type ScannerResult,
  type SourceAdapterRegistry,
  type CompilationWorkerResult,
  type RunCompilationWorkerArgs,
} from "./pipelines/index.js";
