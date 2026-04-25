/**
 * Engine-ingestion port surface — `PipelineDefinition` is what
 * concrete pipelines (Scanner, Compiler, Lint, Heartbeat in PRs
 * 14-17) export and register at boot. `PipelineContext` is the
 * dependency bundle a pipeline receives from the engine harness.
 *
 * Both types live here (single file) so PR 14+ pipelines can import
 * them without pulling in the registry / server / queue surface.
 */
import type { Pool } from "pg";
import type { Redis } from "ioredis";

import type { Logger } from "@opencoo/shared/logger";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { WikiAdapter } from "@opencoo/shared/wiki-write";

/**
 * What a concrete pipeline contributes. v0.1 keeps the shape
 * deliberately narrow; richer surface (per-pipeline config schema,
 * status reporting, lint hooks) is a v0.2 problem.
 */
export interface PipelineDefinition {
  /** Slug used as the queue name suffix (`ingestion.<name>`). Must
   *  be a stable slug, not a display label — downstream audit /
   *  metrics key on it. */
  readonly name: string;
  /**
   * Optional cron expression. When present, the engine harness
   * schedules the pipeline at this cadence. When absent, the
   * pipeline runs only on explicit enqueue (e.g. webhook trigger).
   */
  readonly schedule?: string;
  /**
   * Optional max-parallel-workers count. Architecture §16.2 calls
   * for concurrency:1 on the per-domain BullMQ queue; the engine
   * harness defaults to 1 when this field is absent.
   */
  readonly concurrency?: number;
  /**
   * Pipeline body. Receives the engine context via DI; never
   * touches process.env or imports `@ai-sdk/*` / wiki-gitea
   * directly (THREAT-MODEL §2 invariants 5 + 2).
   */
  run(context: PipelineContext): Promise<void>;
}

/**
 * Dependency bundle a pipeline receives. Constructed once at engine
 * boot in `start()` and passed to each `run()` invocation.
 *
 * `llmRouter` is optional. When the engine is configured with LLM
 * access (composition root in PR 30 wires up an LlmRouter from
 * @opencoo/shared/llm-router), the harness populates this field
 * for every pipeline run. Pipelines that don't make LLM calls
 * (Scanner, the static-analysis half of Lint) tolerate it being
 * absent — they simply ignore the field.
 *
 * Note: there is no `needsLlm` opt-in mechanism on
 * PipelineDefinition. Wiring is all-or-nothing at the engine
 * level: if an LlmRouter is configured it's available to every
 * pipeline; otherwise no pipeline sees one.
 */
export interface PipelineContext {
  readonly db: Pool;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly wikiAdapter: WikiAdapter;
  readonly llmRouter?: LlmRouter;
}
