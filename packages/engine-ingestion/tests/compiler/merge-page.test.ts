/**
 * `mergePage` — wraps one LlmRouter.generateObject<MergedPageBody>
 * call. Builds the prompt (compiler body + spotlighted source +
 * existing-page envelope), invokes the router with tier:'thinker',
 * and returns the strict-Zod-parsed { merged_body, worldview_impact }.
 *
 * This is the unit boundary the compiler orchestrator composes —
 * separates "talk to the model" from "decide what to do with the
 * result".
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { PROMPT_VERSION_MANIFEST } from "@opencoo/shared/prompts";

import { mergePage } from "../../src/compiler/merge-page.js";
import { CompilerValidationError } from "../../src/compiler/errors.js";

import { freshCompilerDb, type CompilerTestDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

interface FixtureBundle {
  router: LlmRouter;
  domainId: string;
  db: CompilerTestDb;
}

async function makeFixture(provider: LlmProvider): Promise<FixtureBundle> {
  const { db, domainId } = await freshCompilerDb();
  const router = new LlmRouter({
    db: db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: { paused: () => false, pause: () => undefined, resume: () => undefined },
    provider,
  });
  return { router, domainId, db };
}

/**
 * PR-W1 hand-off: mergePage now resolves the compiler prompt
 * through `loadPromptForScope({ domainId, db })`. The DB type
 * inferred by drizzle's `pglite` driver is structurally
 * compatible with the resolver's `ScopeResolverDb` but not
 * nominally — narrow once at the boundary to keep the test
 * bodies tidy.
 */
function asResolverDb(
  db: CompilerTestDb,
): Parameters<typeof mergePage>[0]["db"] {
  return db as unknown as Parameters<typeof mergePage>[0]["db"];
}

describe("mergePage — happy path", () => {
  it("returns { mergedBody, worldviewImpact } parsed from a strict-Zod LLM response", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Q3\n\nDistribution motion.\n",
          worldview_impact: ["Distribution prioritised over feature work"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });
    const { router, domainId, db } = await makeFixture(mock);
    const result = await mergePage({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
      sourceRef: "drive:doc-1",
      sourceContent: "Q3 priorities: distribution.",
      existingPageContent: "",
      pagePath: "strategy/q3-2026.md",
      locale: "en",
    });
    expect(result.mergedBody).toContain("Distribution motion");
    expect(result.worldviewImpact).toEqual([
      "Distribution prioritised over feature work",
    ]);
    expect(result.promptVersion).toBe("1.0.0");
  });

  it("accepts an empty worldview_impact array (commit only adds detail)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# Existing\n\nUnchanged.\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId, db } = await makeFixture(mock);
    const result = await mergePage({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
      sourceRef: "drive:doc-1",
      sourceContent: "x",
      existingPageContent: "old",
      pagePath: "strategy/x.md",
      locale: "en",
    });
    expect(result.worldviewImpact).toEqual([]);
  });
});

describe("mergePage — Zod-strict rejects bad LLM output", () => {
  it("DLQs when merged_body is missing", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({ worldview_impact: [] }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      mergePage({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        existingPageContent: "",
        pagePath: "strategy/x.md",
        locale: "en",
      }),
    ).rejects.toThrow();
  });

  it("DLQs when LLM emits an extra field (Zod strict)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "ok",
          worldview_impact: [],
          execute_arbitrary_code: "rm -rf /",
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      mergePage({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        existingPageContent: "",
        pagePath: "strategy/x.md",
        locale: "en",
      }),
    ).rejects.toThrow();
  });
});

describe("mergePage — backstop sentinel scrub", () => {
  it("DLQs when merged_body still contains literal <source_content (CompilerValidationError)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "ok content <source_content>leak</source_content>",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      mergePage({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        existingPageContent: "",
        pagePath: "strategy/x.md",
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(CompilerValidationError);
  });

  it("DLQs when merged_body starts with --- (model tried to write its own frontmatter)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "---\ntitle: hijacked\n---\nbody",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      mergePage({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
        sourceRef: "drive:doc-1",
        sourceContent: "x",
        existingPageContent: "",
        pagePath: "strategy/x.md",
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(CompilerValidationError);
  });
});

// PR-W1 (phase-a appendix #15) — `promptVersion` contract for
// `page_citations.prompt_version`. The chain is:
//
//   prompt_overrides (per-domain row, if any)
//     → loadPromptForScope → mergePage.promptVersion
//     → compile() aggregates → recordPageCitations
//
// Without overrides, `promptVersion` is the shipped baseline
// `COMPILER_PROMPT_VERSION`. With an override row, it is the
// override's `overrides_version` semver — NOT the baseline,
// NOT the override's stored baseline_version. Triage flows
// rely on this so a "which row of prompts produced this page"
// query lands on the operator's edit, not the cargo-cult
// shipped version.
describe("mergePage — page_citations.prompt_version override contract (PR-W1)", () => {
  it("returns the shipped baseline version when no override row exists", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "opencoo Compiler" },
      response: {
        text: JSON.stringify({
          merged_body: "# X\n\nbaseline path.\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId, db } = await makeFixture(mock);
    const result = await mergePage({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
      sourceRef: "drive:doc-1",
      sourceContent: "x",
      existingPageContent: "",
      pagePath: "strategy/x.md",
      locale: "en",
    });
    // Pinned to the shipped baseline (imported, not literal — a
    // prompt rev should not break this test's invariant which is
    // "baseline path returns the shipped baseline version").
    expect(result.promptVersion).toBe(PROMPT_VERSION_MANIFEST.compiler);
  });

  it("returns the override's overridesVersion when a domain-scoped override row exists (NOT the baseline)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      // Match on the OVERRIDE body, not the shipped baseline — proves
      // the resolver actually fed the override prompt to the model.
      match: { model: "gpt-4o-mini", promptIncludes: "TENANT OVERRIDE BODY" },
      response: {
        text: JSON.stringify({
          merged_body: "# X\n\noverride path.\n",
          worldview_impact: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      },
    });
    const { router, domainId, db } = await makeFixture(mock);
    // Insert a domain-scoped compiler override. The
    // `overrides_version` field is the persisted semver the
    // page_citations writer MUST surface; `baseline_version`
    // stays separate so a triage query can still resolve back
    // to the shipped revision the operator was editing against.
    await db.execute(sql`
      INSERT INTO prompt_overrides
        (domain_id, instance_id, prompt_name, locale,
         body, overrides_version, baseline_version)
      VALUES (
        ${domainId}::uuid,
        NULL,
        'compiler',
        'en',
        'TENANT OVERRIDE BODY — opencoo Compiler',
        '7.7.7',
        '1.0.0'
      )
    `);
    const result = await mergePage({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof mergePage>[0]["domainId"],
      sourceRef: "drive:doc-1",
      sourceContent: "x",
      existingPageContent: "",
      pagePath: "strategy/x.md",
      locale: "en",
    });
    // Persisted prompt_version is the OVERRIDE's semver
    // (7.7.7), NOT the shipped baseline (1.0.0). The triage
    // chain re-discovers the baseline via the override row's
    // `baseline_version` column.
    expect(result.promptVersion).toBe("7.7.7");
  });
});
