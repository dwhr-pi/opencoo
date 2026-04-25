/**
 * Compilation Worker — catalog-workflow dispatch + guard wiring
 * (PR 26 / plan #122).
 *
 * Two new behaviors the worker must support:
 *
 *   1. **Guard wiring** — `guardAdapter.classify()` runs at the
 *      worker entry, BEFORE the contentKind dispatch. The
 *      transformedText is what flows into the downstream
 *      classifier / catalog template. Every event the guard emits
 *      becomes a row in `redaction_events` with the binding's
 *      domain_id + binding_id stamped on. The guard call is
 *      unconditional — applies to BOTH document and n8n-workflow
 *      content.
 *
 *   2. **contentKind dispatch** — when the binding's config
 *      carries `contentKind: 'n8n-workflow'`, the worker calls
 *      `compileCatalogWorkflow` instead of the
 *      `classify → compile` path. No LLM, no classifier, no
 *      worldview-impact merge. Single atomic wikiWrite via the
 *      catalog template.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";
import type {
  GuardAdapter,
  GuardClassifyInput,
  GuardClassifyResult,
} from "@opencoo/shared/adapter-contract-tests/guard";

import { runCompilationWorker } from "../../src/pipelines/compilation-worker.js";
import type { ScannerClassifyJob } from "../../src/pipelines/scanner.js";

import { freshPipelineDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

interface RecordingGuardAdapter extends GuardAdapter {
  readonly capturedInputs: ReadonlyArray<string>;
  readonly callCount: () => number;
}

function makeRecordingGuard(
  result: (input: GuardClassifyInput) => GuardClassifyResult,
): RecordingGuardAdapter {
  const capturedInputs: string[] = [];
  return {
    slug: "guard-test",
    role: "redaction",
    categories: ["pii", "secret"],
    patternVersion: "v1-test",
    capturedInputs,
    callCount: () => capturedInputs.length,
    async classify(input) {
      capturedInputs.push(input.text);
      return result(input);
    },
  };
}

function passThroughGuard(): RecordingGuardAdapter {
  return makeRecordingGuard((input) => ({
    events: [],
    transformedText: input.text,
  }));
}

function redactingGuard(): RecordingGuardAdapter {
  return makeRecordingGuard((input) => ({
    events: [
      {
        category: "secret",
        patternVersion: "v1-test",
        matchedByteRanges: [{ start: 0, end: 5 }],
        failMode: "transform",
      },
    ],
    transformedText: "[REDACTED:secret] " + input.text.slice(5),
  }));
}

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

const SAMPLE_WORKFLOW = {
  id: "wf-001",
  name: "Test Workflow",
  active: false,
  tags: ["catalog"],
  nodes: [{ name: "noop", type: "n8n-nodes-base.NoOp" }],
  connections: {},
  settings: {},
};

function buildJob(overrides: {
  bindingId: string;
  intakeId: string;
  contentBase64?: string;
  sourceRef?: string;
}): ScannerClassifyJob {
  return {
    bindingId: overrides.bindingId,
    intakeId: overrides.intakeId,
    domainSlug: "test-domain",
    sourceRef: overrides.sourceRef ?? "n8n:wf-001",
    contentBase64:
      overrides.contentBase64 ??
      Buffer.from(JSON.stringify(SAMPLE_WORKFLOW)).toString("base64"),
    fetchedAt: "2026-04-25T12:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Guard wiring (unconditional, BEFORE contentKind dispatch)
// ---------------------------------------------------------------------------

describe("runCompilationWorker — guard wiring (PR 26)", () => {
  it("invokes guardAdapter.classify exactly once per job (document branch)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "x",
          target_domains: [
            { domain_slug: "test-domain", page_paths: ["strategy/q3-2026.md"] },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 10,
        tokensOut: 10,
      },
    });
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q\n",
          worldview_impact: ["x"],
        }),
        tokensIn: 10,
        tokensOut: 10,
      },
    });
    const f = await makeFixture(mock);
    const guard = passThroughGuard();
    await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: guard,
      job: {
        ...buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
        contentBase64: Buffer.from("Q3 priorities: distribution.").toString("base64"),
        sourceRef: "drive:doc-1",
      },
    });
    expect(guard.callCount()).toBe(1);
  });

  it("persists redaction_events when the guard emits any (one row per event)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "x",
          target_domains: [
            { domain_slug: "test-domain", page_paths: ["strategy/q3-2026.md"] },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 10,
        tokensOut: 10,
      },
    });
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q\n",
          worldview_impact: ["x"],
        }),
        tokensIn: 10,
        tokensOut: 10,
      },
    });
    const f = await makeFixture(mock);
    const guard = redactingGuard();
    await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: guard,
      job: {
        ...buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
        contentBase64: Buffer.from("Hello world.").toString("base64"),
        sourceRef: "drive:doc-1",
      },
    });
    const rows = (await f.db.execute(
      sql`SELECT category, fail_mode, guard_slug, pattern_version FROM redaction_events`,
    )) as unknown as { rows: Array<{ category: string; fail_mode: string; guard_slug: string; pattern_version: string }> };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.category).toBe("secret");
    expect(rows.rows[0]?.guard_slug).toBe("guard-test");
    expect(rows.rows[0]?.pattern_version).toBe("v1-test");
  });

  it("downstream classifier sees the guard's transformedText, not the raw input", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Classifier" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "x",
          target_domains: [
            { domain_slug: "test-domain", page_paths: ["strategy/q3-2026.md"] },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 10,
        tokensOut: 10,
      },
    });
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q\n",
          worldview_impact: ["x"],
        }),
        tokensIn: 10,
        tokensOut: 10,
      },
    });
    const f = await makeFixture(mock);
    const guard = redactingGuard();
    const promptsSeen: string[] = [];
    const wrappedRouter = new LlmRouter({
      db: f.db as unknown as Parameters<typeof LlmRouter>[0]["db"],
      env: {},
      logger: silentLogger(),
      pauser: { paused: () => false, pause: () => undefined, resume: () => undefined },
      provider: {
        async generate(args) {
          promptsSeen.push(args.prompt);
          return mock.generate(args);
        },
      },
    });
    await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: wrappedRouter,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: guard,
      job: {
        ...buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
        contentBase64: Buffer.from("Hello world.").toString("base64"),
        sourceRef: "drive:doc-1",
      },
    });
    // Classifier prompt should contain the redacted token, not "Hello".
    const classifierPrompt = promptsSeen[0] ?? "";
    expect(classifierPrompt).toContain("[REDACTED:secret]");
    expect(classifierPrompt).not.toContain("Hello");
  });
});

// ---------------------------------------------------------------------------
// contentKind dispatch — n8n-workflow path (deterministic, no LLM)
// ---------------------------------------------------------------------------

describe("runCompilationWorker — n8n-workflow contentKind dispatch (PR 26)", () => {
  it("routes a binding with contentKind='n8n-workflow' to compileCatalogWorkflow (no classifier call)", async () => {
    const mock = new MockLlmClient(); // intentionally empty — fail loud if classifier is called
    const f = await makeFixture(mock);
    // Update the binding's adapter_slug + config to mark it n8n-workflow.
    await f.raw.query(
      `UPDATE sources_bindings SET adapter_slug = 'n8n', config = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ baseUrl: "https://x", contentKind: "n8n-workflow" }), f.bindingId],
    );
    const guard = passThroughGuard();
    const result = await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: guard,
      job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
    });
    expect(result.commitsLanded).toBe(1);
    expect(result.classifiedDomains).toBe(1);
    // Guard did fire (decision: unconditional).
    expect(guard.callCount()).toBe(1);
  });

  it("writes the catalog page at catalog/workflows/<slug>-<id>.md", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);
    await f.raw.query(
      `UPDATE sources_bindings SET adapter_slug = 'n8n', config = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ baseUrl: "https://x", contentKind: "n8n-workflow" }), f.bindingId],
    );
    const guard = passThroughGuard();
    await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: guard,
      job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
    });
    const pages = await f.wikiAdapter.listMarkdown(
      "test-domain" as Parameters<typeof f.wikiAdapter.listMarkdown>[0],
    );
    expect(pages).toContain("catalog/workflows/test-workflow-wf-001.md");
  });

  it("page_citations row carries prompt_version='catalog-workflow:1.0'", async () => {
    const mock = new MockLlmClient();
    const f = await makeFixture(mock);
    await f.raw.query(
      `UPDATE sources_bindings SET adapter_slug = 'n8n', config = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ baseUrl: "https://x", contentKind: "n8n-workflow" }), f.bindingId],
    );
    const guard = passThroughGuard();
    await runCompilationWorker({
      db: f.db as unknown as Parameters<typeof runCompilationWorker>[0]["db"],
      logger: silentLogger(),
      router: f.router,
      wikiDeps: f.wikiDeps,
      author: COMPILER_AUTHOR,
      guardAdapter: guard,
      job: buildJob({ bindingId: f.bindingId, intakeId: f.intakeId }),
    });
    const rows = (await f.raw.query<{ prompt_version: string }>(
      `SELECT prompt_version FROM page_citations`,
    ));
    expect(rows.rows[0]?.prompt_version).toBe("catalog-workflow:1.0");
  });
});
