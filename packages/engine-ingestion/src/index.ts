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
  type StartedEngine,
  type StartOptions,
} from "./start.js";
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
  WEBHOOK_BODY_LIMIT_BYTES,
  type WebhookReceiverOptions,
  type WebhookQueueLike,
} from "./intake/webhook-receiver.js";
