/**
 * Classifier orchestrator — wires spotlight + LLM router +
 * Zod-strict parse + binding-guard + path-guard + cross-domain
 * check into one `classify(input, deps)` function.
 *
 * Tests cover the orchestration shape: happy path returns a
 * structured result; any one of the guards throws → orchestrator
 * surfaces a typed error the caller (Scanner pipeline, PR 16+)
 * routes to DLQ.
 *
 * The injection corpus (tests/classifier/injection.test.ts) is
 * the END-TO-END proof against the adversarial-LLM threat model.
 */
import { describe, it, expect } from "vitest";

import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { classify } from "../../src/classifier/classifier.js";
import {
  ClassifierValidationError,
} from "../../src/classifier/errors.js";
import { ClassifierPathError } from "../../src/classifier/path-guard.js";
import { BindingConfigError } from "../../src/classifier/binding-guard.js";

import { freshClassifierDb, type ClassifierTestDb } from "./_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

interface FixtureBundle {
  router: LlmRouter;
  domainId: string;
  db: ClassifierTestDb;
}

async function makeFixture(provider: LlmProvider): Promise<FixtureBundle> {
  const { db, domainId } = await freshClassifierDb();
  const router = new LlmRouter({
    db: db as unknown as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: { paused: () => false, pause: () => undefined, resume: () => undefined },
    provider,
  });
  return { router, domainId, db };
}

/** PR-W1 hand-off helper — narrow the pglite-flavoured db to
 *  the resolver's structural type so `classify({ db })` calls
 *  stay tidy. */
function asResolverDb(
  db: ClassifierTestDb,
): Parameters<typeof classify>[0]["db"] {
  return db as unknown as Parameters<typeof classify>[0]["db"];
}

const ALLOWED_PATHS = ["strategy/**", "executive/**"];
const SOURCE_CONTENT = "Q3 priorities: ship the AI-native distribution.";

describe("classify — happy path", () => {
  it("returns a structured ClassifierOutput for a well-behaved LLM response", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "Q3 priorities — AI-native distribution focus.",
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

    const { router, domainId, db } = await makeFixture(mock);
    const result = await classify({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof classify>[0]["domainId"],
      sourceRef: "drive:doc-1",
      content: SOURCE_CONTENT,
      locale: "en",
      allowedPaths: ALLOWED_PATHS,
      allowedDomains: ["test-domain"],
    });
    expect(result.summary).toContain("Q3 priorities");
    expect(result.targetDomains).toHaveLength(1);
    expect(result.targetDomains[0]?.domainSlug).toBe("test-domain");
    expect(result.targetDomains[0]?.pagePaths).toEqual(["strategy/q3-2026.md"]);
    expect(result.pipelines).toEqual(["compile.single-source"]);
  });
});

describe("classify — adversarial LLM defenses", () => {
  it("DLQs when the LLM emits a path outside allowed_paths (path-guard catch)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "exfil",
          target_domains: [
            {
              domain_slug: "test-domain",
              // Adversarial: claims to write to hr/ even though
              // allowed_paths only permits strategy/** + executive/**.
              page_paths: ["hr/secret-payroll.md"],
            },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });

    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      classify({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toBeInstanceOf(ClassifierPathError);
  });

  it("DLQs when the LLM emits a domain outside allowed_domains (cross-domain catch)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "cross-domain attempt",
          target_domains: [
            {
              // Adversarial: fakes a different domain slug.
              domain_slug: "wiki-finance-secrets",
              page_paths: ["strategy/x.md"],
            },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });

    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      classify({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toBeInstanceOf(ClassifierValidationError);
  });

  it("DLQs when the LLM response is not valid JSON (parse fail)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: "this is not JSON, the model went off-script",
        tokensIn: 100,
        tokensOut: 10,
      },
    });

    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      classify({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toThrow();
  });

  it("DLQs when the LLM emits an unknown extra field (Zod strict)", async () => {
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "ok",
          target_domains: [
            {
              domain_slug: "test-domain",
              page_paths: ["strategy/x.md"],
            },
          ],
          pipelines: ["compile.single-source"],
          // Adversarial: extra field the model invented.
          execute_arbitrary_code: "rm -rf /",
        }),
        tokensIn: 100,
        tokensOut: 50,
      },
    });

    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      classify({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toThrow();
  });

  it("rejects at boot when allowed_paths is wildcard-only (binding-guard)", async () => {
    const mock = new MockLlmClient();
    // No registration needed — the binding-guard catches before
    // the LLM is invoked.
    const { router, domainId, db } = await makeFixture(mock);
    await expect(
      classify({
        router,
        db: asResolverDb(db),
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: "drive:doc-1",
        content: SOURCE_CONTENT,
        locale: "en",
        allowedPaths: ["**"],
        allowedDomains: ["test-domain"],
      }),
    ).rejects.toBeInstanceOf(BindingConfigError);
  });
});

describe("classify — locale fallback (Q7)", () => {
  it("uses the English prompt when locale='auto'", async () => {
    let promptSeen = "";
    const recorder: LlmProvider = {
      async generate(call) {
        promptSeen = call.prompt;
        return {
          text: JSON.stringify({
            version: "v1",
            language: "en",
            summary: "ok",
            target_domains: [
              { domain_slug: "test-domain", page_paths: ["strategy/x.md"] },
            ],
            pipelines: ["compile.single-source"],
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    };

    const { router, domainId, db } = await makeFixture(recorder);
    await classify({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof classify>[0]["domainId"],
      sourceRef: "drive:doc-1",
      content: SOURCE_CONTENT,
      locale: "auto",
      allowedPaths: ALLOWED_PATHS,
      allowedDomains: ["test-domain"],
    });
    // English prompt anchor.
    expect(promptSeen).toContain("opencoo Classifier");
  });
});

describe("classify — binding constraints injection (PR-Y9)", () => {
  // Root cause of the partner cross-domain hallucination: the
  // prompt body referenced "the binding's allowed_domains" in the
  // abstract, but the actual `args.allowedDomains` /
  // `args.allowedPaths` values were never injected into the LLM
  // input. The LLM had no constrained list and hallucinated slugs
  // from document content; Layer 4 then DLQ'd every emission.
  //
  // These tests capture the assembled `fullPrompt` via a stub
  // provider and assert that BOTH the allowedDomains values and
  // the allowedPaths globs appear in the prompt, between the
  // prompt body and the <source_content> envelope.

  function makeRecorder(): {
    provider: LlmProvider;
    getPrompt: () => string;
  } {
    let promptSeen = "";
    const provider: LlmProvider = {
      async generate(call) {
        promptSeen = call.prompt;
        return {
          text: JSON.stringify({
            version: "v1",
            language: "en",
            summary: "binding-constraints test",
            target_domains: [
              {
                domain_slug: "wiki-pilot-alpha",
                page_paths: ["strategy/q3-2026.md"],
              },
            ],
            pipelines: ["compile.single-source"],
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    };
    return { provider, getPrompt: () => promptSeen };
  }

  it("injects allowedDomains values into the prompt as JSON-stringified strings", async () => {
    const { provider, getPrompt } = makeRecorder();
    const { router, domainId, db } = await makeFixture(provider);
    await classify({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof classify>[0]["domainId"],
      sourceRef: "drive:doc-1",
      content: SOURCE_CONTENT,
      locale: "en",
      allowedPaths: ALLOWED_PATHS,
      allowedDomains: ["wiki-pilot-alpha"],
    });
    const captured = getPrompt();
    // The prompt body references the block by name ("Binding
    // constraints (this run only)"), so anchor on a phrase that
    // only the injected block contains — "These are the ONLY
    // values you may emit:" proves the block was actually
    // assembled into the prompt rather than merely referenced.
    expect(captured).toContain("These are the ONLY values you may emit:");
    // JSON-stringified, including the surrounding quotes — this is
    // the exact byte sequence the LLM sees on the line.
    expect(captured).toContain('"wiki-pilot-alpha"');
    expect(captured).toContain("allowed_domains");
  });

  it("injects allowedPaths globs into the prompt", async () => {
    const { provider, getPrompt } = makeRecorder();
    const { router, domainId, db } = await makeFixture(provider);
    await classify({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof classify>[0]["domainId"],
      sourceRef: "drive:doc-1",
      content: SOURCE_CONTENT,
      locale: "en",
      allowedPaths: ALLOWED_PATHS,
      allowedDomains: ["wiki-pilot-alpha"],
    });
    const captured = getPrompt();
    expect(captured).toContain("allowed_paths");
    for (const glob of ALLOWED_PATHS) {
      expect(captured).toContain(JSON.stringify(glob));
    }
  });

  it("regression: the constraints block sits between prompt body and the <source_content> envelope", async () => {
    // The order matters — the prompt body references "the
    // constraints block AFTER this prompt body and BEFORE the
    // source content", so the assembled prompt must respect that
    // ordering. If a refactor flips them, this regression test
    // catches it.
    const { provider, getPrompt } = makeRecorder();
    const { router, domainId, db } = await makeFixture(provider);
    await classify({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof classify>[0]["domainId"],
      sourceRef: "drive:doc-1",
      content: SOURCE_CONTENT,
      locale: "en",
      allowedPaths: ALLOWED_PATHS,
      allowedDomains: ["wiki-pilot-alpha"],
    });
    const captured = getPrompt();
    const promptBodyAnchor = captured.indexOf("opencoo Classifier");
    // The prompt body now references the constraints block by
    // name ("Binding constraints (this run only)" block), so a
    // bare "Binding constraints" substring is not unique. Anchor
    // on a phrase that only the injected block contains —
    // "These are the ONLY values you may emit:" is in the
    // assembled constraints block and nowhere in the prompt body.
    const constraintsAnchor = captured.indexOf(
      "These are the ONLY values you may emit:",
    );
    // The prompt body itself mentions <source_content> in the
    // Spotlighting section, so anchor on the actual envelope
    // opening (with the `source=` attribute), which only appears
    // once and only on the real envelope.
    const envelopeAnchor = captured.indexOf('<source_content source="');
    expect(promptBodyAnchor).toBeGreaterThanOrEqual(0);
    expect(constraintsAnchor).toBeGreaterThan(promptBodyAnchor);
    expect(envelopeAnchor).toBeGreaterThan(constraintsAnchor);
  });

  it("happy path with the constrained slug: classify() returns successfully when the LLM picks an allowed domain", async () => {
    // End-to-end proof that the wiring stays intact post-fix —
    // when the stub LLM returns a slug from allowedDomains and a
    // path from allowedPaths, classify() completes without
    // throwing and produces the expected structured output.
    const mock = new MockLlmClient();
    mock.register({
      match: { model: "gpt-4o-mini", promptIncludes: "Q3 priorities" },
      response: {
        text: JSON.stringify({
          version: "v1",
          language: "en",
          summary: "happy-path with binding constraints",
          target_domains: [
            {
              domain_slug: "wiki-pilot-alpha",
              page_paths: ["strategy/q3-2026.md"],
            },
          ],
          pipelines: ["compile.single-source"],
        }),
        tokensIn: 50,
        tokensOut: 25,
      },
    });

    const { router, domainId, db } = await makeFixture(mock);
    const result = await classify({
      router,
      db: asResolverDb(db),
      domainId: domainId as Parameters<typeof classify>[0]["domainId"],
      sourceRef: "drive:doc-1",
      content: SOURCE_CONTENT,
      locale: "en",
      allowedPaths: ALLOWED_PATHS,
      allowedDomains: ["wiki-pilot-alpha"],
    });
    expect(result.targetDomains[0]?.domainSlug).toBe("wiki-pilot-alpha");
    expect(result.targetDomains[0]?.pagePaths).toEqual(["strategy/q3-2026.md"]);
  });
});
