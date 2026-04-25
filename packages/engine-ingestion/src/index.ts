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
