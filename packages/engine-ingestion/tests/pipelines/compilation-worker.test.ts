/**
 * Compilation Worker (PR 17 / plan #77).
 *
 * Consumes one scanner.classify job, runs classify → compile,
 * marks the intake row classified.
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { runCompilationWorker } from "../../src/pipelines/compilation-worker.js";
import type { ScannerClassifyJob } from "../../src/pipelines/scanner.js";

import { freshPipelineDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

async function makeFixture(provider: LlmProvider): Promise<{
  router: LlmRouter;
  bindingId: string;
  intakeId: string;
  domainId: string;
  wikiAdapter: InMemoryWikiAdapter;
  wikiDeps: WikiWriteDeps;
  db: Awaited<ReturnType<typeof freshPipelineDb>>["db"];
  raw: Awaited<ReturnType<typeof freshPipelineDb>>["raw"];
}> {
  const f = await freshPipelineDb({});
  const router = new LlmRouter({
    db: f.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: { paused: () => false, pause: () => undefined, resume: () => undefined },
    provider,
  });
  // Pre-seed an intake row so the worker has something to mark.
  const intakeResult = await f.raw.query<{ id: string }>(
    `INSERT INTO ingestion_intake (binding_id, source_doc_id, source_revision, content_hash) VALUES ($1, 'doc-1', 'rev-1', 'hash') RETURNING id`,
    [f.bindingId],
  );
  const intakeId = intakeResult.rows[0]!.id;
  const wikiAdapter = new InMemoryWikiAdapter();
  const wikiDeps: WikiWriteDeps = {
    adapter: wikiAdapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: silentLogger(),
    clock: () => new Date("2026-04-25T12:00:00Z"),
    instanceId: "test",
  };
  return {
    router,
    bindingId: f.bindingId,
    intakeId,
    domainId: f.domainId,
    wikiAdapter,
    wikiDeps,
    db: f.db,
    raw: f.raw,
  };
}

function buildJob(overrides: Partial<ScannerClassifyJob> & {
  bindingId: string;
  intakeId: string;
}): ScannerClassifyJob {
  return {
    bindingId: overrides.bindingId,
    intakeId: overrides.intakeId,
    domainSlug: "test-domain",
    sourceRef: "drive:doc-1",
    contentBase64: Buffer.from("Q3 priorities: distribution.").toString("base64"),
    fetchedAt: "2026-04-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("runCompilationWorker — happy path", () => {
  it("runs classify → compile and marks the intake row classified", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "Q3 priorities",
          target_domains: [
            {
              domain_slug: "test-domain",
              page_paths: ["strategy/q3-2026.md"],
            },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q3\n\nDistribution motion.\n",
          worldview_impact: ["Distribution prioritised"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });
    const f = await makeFixture(mock);
    const result = await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
    });
    expect(result.classifiedDomains).toBe(1);
    expect(result.commitsLanded).toBe(1);

    // intake.status flipped to classified.
    const after = await f.raw.query<{ status: string }>(
      `SELECT status FROM ingestion_intake WHERE id = $1`,
      [f.intakeId],
    );
    expect(after.rows[0]?.status).toBe("classified");
  });
});

describe("runCompilationWorker — binding lookup", () => {
  it("throws when the binding is missing or disabled", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);
    // Disable the binding.
    await f.raw.query(`UPDATE sources_bindings SET enabled = false WHERE id = $1`, [
      f.bindingId,
    ]);
    await expect(
      runCompilationWorker({
        db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
        logger: silentLogger(),
        router: f.router,
        wikiDeps: f.wikiDeps,
        author: COMPILER_AUTHOR,
        job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
      }),
    ).rejects.toThrow();
  });
});
