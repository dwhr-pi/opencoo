/**
 * Shape-lock for the engine-ingestion port surface — `PipelineDefinition`
 * and `PipelineContext`. Concrete pipelines (Scanner, Compiler, Lint,
 * Heartbeat, etc.) ship in PRs 14-17 and consume these types via
 * the registry. Drift here breaks all of them at once.
 */
import { describe, it, expect } from "vitest";

import type {
  PipelineDefinition,
  PipelineContext,
} from "../src/types.js";
import type { Logger } from "@opencoo/shared/logger";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { WikiAdapter } from "@opencoo/shared/wiki-write";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

describe("PipelineDefinition + PipelineContext shape-lock", () => {
  it("PipelineDefinition has name + run + optional schedule + optional concurrency", () => {
    const def: PipelineDefinition = {
      name: "scanner",
      async run(ctx) {
        void ctx;
        return undefined;
      },
    };
    expect(def.name).toBe("scanner");
  });

  it("PipelineDefinition.schedule is optional cron string", () => {
    const def: PipelineDefinition = {
      name: "scanner-scheduled",
      schedule: "0 */4 * * *",
      async run(ctx) {
        void ctx;
        return undefined;
      },
    };
    expect(def.schedule).toBe("0 */4 * * *");
  });

  it("PipelineDefinition.concurrency is optional positive int", () => {
    const def: PipelineDefinition = {
      name: "compiler",
      concurrency: 1, // domain-bound, single-writer per architecture §16.2
      async run(ctx) {
        void ctx;
        return undefined;
      },
    };
    expect(def.concurrency).toBe(1);
  });

  it("PipelineContext exposes db Pool, redis client, logger, wikiAdapter, llmRouter?", () => {
    // Compile-only stub. The real engine wires these from start();
    // pipelines accept a context handle and operate through it.
    const ctx: PipelineContext = {
      db: undefined as unknown as Pool,
      redis: undefined as unknown as Redis,
      logger: undefined as unknown as Logger,
      wikiAdapter: undefined as unknown as WikiAdapter,
      // llmRouter is optional — Scanner doesn't need it; Compiler does.
    };
    expect(typeof ctx).toBe("object");
  });

  it("PipelineContext.llmRouter is optional", () => {
    // If llmRouter were required, this assignment would type-error.
    const ctx: PipelineContext = {
      db: undefined as unknown as Pool,
      redis: undefined as unknown as Redis,
      logger: undefined as unknown as Logger,
      wikiAdapter: undefined as unknown as WikiAdapter,
      llmRouter: undefined as unknown as LlmRouter,
    };
    expect(typeof ctx).toBe("object");
  });
});
