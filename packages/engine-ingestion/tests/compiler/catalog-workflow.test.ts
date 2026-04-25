/**
 * compileCatalogWorkflow — deterministic compiler template for
 * `content_kind = 'n8n-workflow'` (PR 26 / plan #122).
 *
 * Two layers:
 *   1. Pure function tests for the parser + body builder
 *      (round-trip, fenced-block format, frontmatter shape,
 *      slug derivation, updatedAt strip).
 *   2. Orchestration tests: compileCatalogWorkflow produces ONE
 *      atomic wikiWrite operation, appends a page_citations row
 *      with `prompt_version: 'catalog-workflow:1.0'`, never
 *      calls the LLM router.
 *
 * The LOAD-BEARING assertion is the lossless round-trip across
 * the 3 fixtures (simple linear, branched-with-IF, loop-with-
 * SplitInBatches): adapter contentBytes → compiler fenced block
 * → re-parsed JSON deep-equal to the original (modulo top-level
 * `updatedAt`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  CATALOG_WORKFLOW_PROMPT_VERSION,
  buildCatalogWorkflowBody,
  catalogPagePathForWorkflow,
  compileCatalogWorkflow,
  parseCatalogWorkflowBody,
  slugifyName,
} from "../../src/compiler/catalog-workflow.js";
import { CompilerValidationError } from "../../src/compiler/errors.js";

import { freshCompilerDb } from "./_pglite-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(
  HERE,
  "../../../adapters/source-n8n/tests/fixtures",
);

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const COMPILER_AUTHOR = {
  name: "opencoo-compiler",
  email: "compiler@opencoo.local",
} as const;

interface FixtureWorkflow {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
  readonly nodes: readonly unknown[];
  readonly connections: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
  readonly active: boolean;
  readonly updatedAt?: string;
}

function loadFixture(name: string): FixtureWorkflow {
  const raw = readFileSync(resolve(FIXTURES_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw) as FixtureWorkflow;
}

function stripUpdatedAt(wf: FixtureWorkflow): Omit<FixtureWorkflow, "updatedAt"> {
  const copy: Record<string, unknown> = { ...wf };
  delete copy["updatedAt"];
  return copy as Omit<FixtureWorkflow, "updatedAt">;
}

// ---------------------------------------------------------------------------
// slug derivation
// ---------------------------------------------------------------------------

describe("slugifyName", () => {
  it("lowercases, strips special chars, and dashes spaces", () => {
    expect(slugifyName("Daily Heartbeat Digest")).toBe("daily-heartbeat-digest");
    expect(slugifyName("API → DB sync (v2)")).toBe("api-db-sync-v2");
  });

  it("collapses repeated dashes and trims", () => {
    expect(slugifyName("  --foo--bar--  ")).toBe("foo-bar");
  });

  it("falls back to 'workflow' on an empty/all-special input", () => {
    expect(slugifyName("")).toBe("workflow");
    expect(slugifyName("!!! ???")).toBe("workflow");
  });
});

describe("catalogPagePathForWorkflow", () => {
  it("emits catalog/workflows/<slug>-<id>.md", () => {
    expect(catalogPagePathForWorkflow({ id: "wf-001", name: "Daily Heartbeat" }))
      .toBe("catalog/workflows/daily-heartbeat-wf-001.md");
  });
});

// ---------------------------------------------------------------------------
// Body builder + parser — round-trip
// ---------------------------------------------------------------------------

describe("buildCatalogWorkflowBody — fence + frontmatter shape", () => {
  it("emits a single ```n8n-workflow fenced block (no LLM-merged prose)", () => {
    const wf = loadFixture("simple-linear");
    const out = buildCatalogWorkflowBody({
      workflow: wf,
      domainSlug: "automations",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
    });
    // Must contain the fenced block.
    expect(out.body).toContain("```n8n-workflow\n");
    expect(out.body).toContain("\n```\n");
  });

  it("frontmatter contains tags as ARRAY (not singular tag)", () => {
    const wf = loadFixture("simple-linear");
    const out = buildCatalogWorkflowBody({
      workflow: wf,
      domainSlug: "automations",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
    });
    // Frontmatter line shape: `tags: ["catalog", "n8n"]` or YAML
    // flow-list — assert array form, not `tag: catalog`.
    expect(out.body).toMatch(/^tags:\s*\[/m);
    expect(out.body).not.toMatch(/^tag:\s/m);
  });

  it("frontmatter defaults tags to ['catalog'] when the workflow has no tags", () => {
    const wf = loadFixture("simple-linear");
    const noTags: FixtureWorkflow = { ...wf, tags: [] };
    const out = buildCatalogWorkflowBody({
      workflow: noTags,
      domainSlug: "automations",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
    });
    expect(out.body).toMatch(/^tags:\s*\["catalog"\]/m);
  });

  it("body NEVER carries top-level updatedAt (compiler-side strip)", () => {
    const wf = loadFixture("simple-linear");
    const fenced = buildCatalogWorkflowBody({
      workflow: wf,
      domainSlug: "automations",
      compiledAt: new Date("2026-04-25T12:00:00Z"),
    });
    // Re-parse the fenced block to verify updatedAt is gone.
    const parsed = parseCatalogWorkflowBody(fenced.body);
    expect("updatedAt" in parsed).toBe(false);
  });
});

describe("parseCatalogWorkflowBody — strict body shape", () => {
  it("throws CompilerValidationError when prose appears outside the fence", () => {
    const bad = `---
title: x
---
some stray prose
\`\`\`n8n-workflow
{}
\`\`\`
`;
    expect(() => parseCatalogWorkflowBody(bad)).toThrow(CompilerValidationError);
  });

  it("throws on an unknown fence info-string", () => {
    const bad = `---
title: x
---
\`\`\`json
{}
\`\`\`
`;
    expect(() => parseCatalogWorkflowBody(bad)).toThrow(CompilerValidationError);
  });

  it("throws on missing fence", () => {
    const bad = `---
title: x
---
no fence here
`;
    expect(() => parseCatalogWorkflowBody(bad)).toThrow(CompilerValidationError);
  });

  it("throws on malformed JSON inside the fence", () => {
    const bad = `---
title: x
---
\`\`\`n8n-workflow
not-json
\`\`\`
`;
    expect(() => parseCatalogWorkflowBody(bad)).toThrow(CompilerValidationError);
  });
});

// ---------------------------------------------------------------------------
// Lossless round-trip across the 3 fixtures (LOAD-BEARING)
// ---------------------------------------------------------------------------

describe("compileCatalogWorkflow — lossless round-trip across fixtures", () => {
  const fixtures = [
    "simple-linear",
    "branched-with-if",
    "loop-with-splitinbatches",
  ] as const;
  for (const name of fixtures) {
    it(`fixture '${name}': originalJson → fenced-block → re-parsed JSON deep-equal (ignoring top-level updatedAt)`, () => {
      const wf = loadFixture(name);
      const out = buildCatalogWorkflowBody({
        workflow: wf,
        domainSlug: "automations",
        compiledAt: new Date("2026-04-25T12:00:00Z"),
      });
      const parsed = parseCatalogWorkflowBody(out.body);
      // The compiler strips updatedAt from the body, so the
      // round-trip target is the workflow MINUS updatedAt.
      expect(parsed).toEqual(stripUpdatedAt(wf));
    });
  }
});

// ---------------------------------------------------------------------------
// No LLM call (deterministic template)
// ---------------------------------------------------------------------------

describe("compileCatalogWorkflow — deterministic (no LLM)", () => {
  it("the catalog-workflow template module does NOT import @opencoo/shared/llm-router", () => {
    const src = readFileSync(
      resolve(HERE, "../../src/compiler/catalog-workflow.ts"),
      "utf8",
    );
    // Token-aware comment strip via the TS scanner — same shape
    // as PR 25's gate-3-source-grep.test.ts. The regex stripper
    // would consume `//` sequences inside string/template
    // literals (e.g. URLs), which is the false-positive vector
    // the scanner-based approach avoids. File headers may
    // legitimately mention the router by name when explaining
    // why we don't import it.
    const codeOnly = stripCommentsViaScanner(src);
    expect(codeOnly).not.toMatch(/from\s+["']@opencoo\/shared\/llm-router["']/);
  });

  it("emits prompt_version sentinel 'catalog-workflow:1.0'", () => {
    expect(CATALOG_WORKFLOW_PROMPT_VERSION).toBe("catalog-workflow:1.0");
  });
});

// ---------------------------------------------------------------------------
// Orchestration — one atomic wikiWrite + page_citations
// ---------------------------------------------------------------------------

describe("compileCatalogWorkflow — orchestration", () => {
  it("writes ONE replace operation for the catalog page (no LLM round-trips)", async () => {
    const f = await freshCompilerDb();
    const wf = loadFixture("simple-linear");
    const wikiAdapter = new InMemoryWikiAdapter();
    const wikiDeps: WikiWriteDeps = {
      adapter: wikiAdapter,
      queue: new InMemoryWikiWriteQueue(),
      deleteCap: new InMemoryDeleteCap(),
      logger: silentLogger(),
      clock: () => new Date("2026-04-25T12:00:00Z"),
      instanceId: "test",
    };
    const result = await compileCatalogWorkflow({
      db: f.db as unknown as Parameters<typeof compileCatalogWorkflow>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileCatalogWorkflow>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compileCatalogWorkflow>[0]["bindingId"],
      sourceRef: `n8n:${wf.id}`,
      workflow: wf,
      wikiDeps,
      author: COMPILER_AUTHOR,
    });
    expect(result.commitSha).not.toBeNull();
    expect(result.pagePath).toBe(catalogPagePathForWorkflow(wf));
  });

  it("appends a page_citations row with prompt_version='catalog-workflow:1.0'", async () => {
    const f = await freshCompilerDb();
    const wf = loadFixture("simple-linear");
    const wikiAdapter = new InMemoryWikiAdapter();
    const wikiDeps: WikiWriteDeps = {
      adapter: wikiAdapter,
      queue: new InMemoryWikiWriteQueue(),
      deleteCap: new InMemoryDeleteCap(),
      logger: silentLogger(),
      clock: () => new Date("2026-04-25T12:00:00Z"),
      instanceId: "test",
    };
    await compileCatalogWorkflow({
      db: f.db as unknown as Parameters<typeof compileCatalogWorkflow>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileCatalogWorkflow>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compileCatalogWorkflow>[0]["bindingId"],
      sourceRef: `n8n:${wf.id}`,
      workflow: wf,
      wikiDeps,
      author: COMPILER_AUTHOR,
    });
    const rows = (await f.db.execute(
      sql`SELECT prompt_version, source_ref FROM page_citations`,
    )) as unknown as { rows: Array<{ prompt_version: string; source_ref: string }> };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.prompt_version).toBe("catalog-workflow:1.0");
    expect(rows.rows[0]?.source_ref).toBe(`n8n:${wf.id}`);
  });

  it("re-running with an unchanged workflow + same path produces a no-op (skip-write)", async () => {
    const f = await freshCompilerDb();
    const wf = loadFixture("simple-linear");
    const wikiAdapter = new InMemoryWikiAdapter();
    const writeSpy = vi.spyOn(wikiAdapter, "writeAtomic");
    const wikiDeps: WikiWriteDeps = {
      adapter: wikiAdapter,
      queue: new InMemoryWikiWriteQueue(),
      deleteCap: new InMemoryDeleteCap(),
      logger: silentLogger(),
      clock: () => new Date("2026-04-25T12:00:00Z"),
      instanceId: "test",
    };
    const args = {
      db: f.db as unknown as Parameters<typeof compileCatalogWorkflow>[0]["db"],
      domainId: f.domainId as Parameters<typeof compileCatalogWorkflow>[0]["domainId"],
      domainSlug: "test-domain",
      bindingId: f.bindingId as Parameters<typeof compileCatalogWorkflow>[0]["bindingId"],
      sourceRef: `n8n:${wf.id}`,
      workflow: wf,
      wikiDeps,
      author: COMPILER_AUTHOR,
    };
    await compileCatalogWorkflow(args);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const second = await compileCatalogWorkflow(args);
    // Second invocation on identical input → no second wikiWrite.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(second.commitSha).toBeNull();
  });
});

/**
 * Token-aware comment strip via the TS scanner. Mirrors the
 * helper in `engine-self-operating/tests/automation-loop/
 * gate-3-source-grep.test.ts` — string/template/regex literals
 * are preserved verbatim so a `from "@opencoo/shared/llm-router"`
 * substring inside a string literal would still surface, while
 * the same substring inside a `//` or `/* *\/` comment is
 * legitimately stripped. Newlines preserved so failure messages
 * referencing line numbers stay accurate.
 */
function stripCommentsViaScanner(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source,
  );
  const parts: string[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      parts.push(scanner.getTokenText().replace(/[^\n]/g, ""));
    } else {
      parts.push(scanner.getTokenText());
    }
    token = scanner.scan();
  }
  return parts.join("");
}
