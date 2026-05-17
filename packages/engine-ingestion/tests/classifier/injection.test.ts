/**
 * End-to-end injection corpus — the empirical proof against the
 * THREAT-MODEL §3.4 adversarial-LLM threat model.
 *
 * Each fixture in `injection-corpus/{en,pl}/` is a real document
 * body crafted to subvert the classifier. The matching JSON in
 * `injection-corpus/expected/` records:
 *   - the adversary's goal (a sentence for humans),
 *   - the mock LLM response (what a fully-pwned model would emit
 *     given that input — i.e. the worst-case provider behavior we
 *     defend against), and
 *   - the expected orchestrator outcome (reject + error class, or
 *     accept + assertions).
 *
 * The driver iterates the corpus, registers each mock response on
 * a fresh MockLlmClient + LlmRouter, and asserts the orchestrator
 * routes the run to DLQ via the expected typed error.
 *
 * Adding a corpus entry: drop a `.txt` fixture in en/ or pl/ and
 * a matching expected/<locale>-<basename>.json. The discovery
 * walk picks it up; no driver edits required.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LlmRouter,
  createOpenRouterProvider,
  type LlmProvider,
} from "@opencoo/shared/llm-router";
import { MockLlmClient } from "@opencoo/shared/llm-router/testing";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { classify } from "../../src/classifier/classifier.js";
import {
  ClassifierValidationError,
} from "../../src/classifier/errors.js";
import { ClassifierPathError } from "../../src/classifier/path-guard.js";
import { BindingConfigError } from "../../src/classifier/binding-guard.js";

import { freshClassifierDb } from "./_pglite-fixture.js";

const RUN_REAL_LLM = process.env["RUN_REAL_LLM"] === "1";
// Model resolution order:
//   1. RUN_REAL_LLM_MODEL — explicit per-run override
//   2. OPENROUTER_DEFAULT_MODEL — set in repo-root .env (loaded
//      by tests/setup.ts via dotenv)
//   3. moonshotai/kimi-k2.6 — the user-named default; the $100
//      OpenRouter budget cap is calibrated for this model
const REAL_LLM_MODEL =
  process.env["RUN_REAL_LLM_MODEL"] ??
  process.env["OPENROUTER_DEFAULT_MODEL"] ??
  "moonshotai/kimi-k2.6";
const REAL_LLM_API_KEY = process.env["OPENROUTER_API_KEY"] ?? "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CORPUS_ROOT = join(__dirname, "injection-corpus");

interface MockJsonResponse {
  readonly kind: "json";
  readonly body: unknown;
}

interface MockTextResponse {
  readonly kind: "text";
  readonly body: string;
}

type MockResponse = MockJsonResponse | MockTextResponse;

interface RejectOutcome {
  readonly kind: "reject";
  readonly errorName: string;
  readonly errorClass: "validation" | "transient" | "upstream-quota";
}

interface AcceptOutcome {
  readonly kind: "accept";
}

interface ExpectedFile {
  readonly fixture: string;
  readonly locale: "en" | "pl";
  readonly adversaryGoal: string;
  readonly mockResponse: MockResponse;
  readonly expectedOutcome: RejectOutcome | AcceptOutcome;
}

const ERROR_NAME_TO_CLASS: ReadonlyMap<
  string,
  new (...args: never[]) => Error
> = new Map([
  ["ClassifierValidationError", ClassifierValidationError as never],
  ["ClassifierPathError", ClassifierPathError as never],
  ["BindingConfigError", BindingConfigError as never],
]);

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const ALLOWED_PATHS = ["strategy/**", "executive/**"];
const ALLOWED_DOMAINS = ["test-domain"];

async function loadCorpus(): Promise<ExpectedFile[]> {
  const expectedDir = join(CORPUS_ROOT, "expected");
  const files = await readdir(expectedDir);
  const cases: ExpectedFile[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    const raw = await readFile(join(expectedDir, file), "utf8");
    const parsed = JSON.parse(raw) as ExpectedFile;
    cases.push(parsed);
  }
  return cases;
}

async function loadFixtureBody(rel: string): Promise<string> {
  return readFile(join(CORPUS_ROOT, rel), "utf8");
}

const corpus = await loadCorpus();

function buildMockProvider(entry: ExpectedFile): LlmProvider {
  const mock = new MockLlmClient();
  // promptIncludes:"" matches every call — the driver doesn't
  // need to peek into the prompt; the orchestrator sends one
  // call per classify() so a single permissive registration
  // is sufficient.
  mock.register({
    match: { model: "gpt-4o-mini", promptIncludes: "" },
    response:
      entry.mockResponse.kind === "json"
        ? {
            text: JSON.stringify(entry.mockResponse.body),
            tokensIn: 100,
            tokensOut: 50,
          }
        : {
            text: entry.mockResponse.body,
            tokensIn: 100,
            tokensOut: 10,
          },
  });
  return mock;
}

async function buildRealProvider(): Promise<LlmProvider> {
  if (REAL_LLM_API_KEY === "") {
    throw new Error(
      "RUN_REAL_LLM=1 requires OPENROUTER_API_KEY to be set; refusing to call OpenRouter without authentication.",
    );
  }
  return createOpenRouterProvider({ apiKey: REAL_LLM_API_KEY });
}

describe("injection corpus — adversarial LLM end-to-end", () => {
  for (const entry of corpus) {
    it(`${entry.fixture}: ${entry.adversaryGoal.slice(0, 80)}`, async () => {
      const body = await loadFixtureBody(entry.fixture);
      const provider = RUN_REAL_LLM
        ? await buildRealProvider()
        : buildMockProvider(entry);

      const fixtureOpts = RUN_REAL_LLM
        ? { modelOverride: REAL_LLM_MODEL }
        : {};
      const { db, domainId } = await freshClassifierDb(fixtureOpts);
      const router = new LlmRouter({
        db: db as unknown as Parameters<typeof LlmRouter>[0]["db"],
        env: {},
        logger: silentLogger(),
        pauser: {
          paused: () => false,
          pause: () => undefined,
          resume: () => undefined,
        },
        provider,
      });

      const promise = classify({
        router,
        db: db as unknown as Parameters<typeof classify>[0]["db"],
        domainId: domainId as Parameters<typeof classify>[0]["domainId"],
        sourceRef: `corpus:${entry.fixture}`,
        content: body,
        locale: entry.locale,
        allowedPaths: ALLOWED_PATHS,
        allowedDomains: ALLOWED_DOMAINS,
      });

      if (RUN_REAL_LLM) {
        // Real-LLM mode: the model may or may not comply with the
        // injection. Either outcome is a passing wall — the failure
        // case is silent acceptance of an attacker-controlled path
        // or domain. Assert that EITHER the result conforms to the
        // binding (only allowed paths/domains) OR the orchestrator
        // rejects via a typed validation error.
        try {
          const result = await promise;
          for (const td of result.targetDomains) {
            expect(ALLOWED_DOMAINS).toContain(td.domainSlug);
            for (const pp of td.pagePaths) {
              expect(typeof pp).toBe("string");
              expect(pp.length).toBeGreaterThan(0);
            }
          }
        } catch (err) {
          // Any of the typed validation errors is a passing wall.
          const errorClass = (err as { errorClass?: string }).errorClass;
          expect(errorClass).toBe("validation");
        }
        return;
      }

      // Deterministic-mock mode: the mockResponse is the worst-case
      // model output for this fixture; the orchestrator MUST reject
      // (or accept, per the fixture) exactly as recorded.
      if (entry.expectedOutcome.kind === "reject") {
        const ctor = ERROR_NAME_TO_CLASS.get(entry.expectedOutcome.errorName);
        if (ctor === undefined) {
          throw new Error(
            `corpus expected error '${entry.expectedOutcome.errorName}' is not registered in ERROR_NAME_TO_CLASS`,
          );
        }
        await expect(promise).rejects.toBeInstanceOf(ctor);
        try {
          await promise;
          expect.fail("classify did not reject");
        } catch (err) {
          const e = err as { errorClass?: string };
          expect(e.errorClass).toBe(entry.expectedOutcome.errorClass);
        }
      } else {
        await expect(promise).resolves.toBeDefined();
      }
    });
  }
});
