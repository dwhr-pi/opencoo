// Per-prompt test-driver factory. The 9 prompt-specific spec
// files (`<promptName>.injection.test.ts`) each call
// `runInjectionSuiteFor("<promptName>")` and that's the entire
// file body. Keeping the per-prompt files thin lets vitest's
// per-file output read like a coverage map: one prompt's full
// matrix per failing/passing line.

import { describe, it } from "vitest";

import {
  loadFixturesForPrompt,
} from "../../src/prompts/__fixtures__/injection/_loader.js";
import {
  runUniversalInvariants,
} from "../../src/prompts/__fixtures__/injection/_runner.js";
import {
  runCategoryCheck,
} from "../../src/prompts/__fixtures__/injection/_category-checks.js";
import {
  INJECTION_SKIPS,
} from "../../src/prompts/__fixtures__/injection/_skips.js";
import type { PromptName } from "../../src/prompts/loader.js";

/** Wire vitest tests for one prompt. Walks the (locale, category)
 *  matrix; covered cells get a real `it()`, skipped cells get an
 *  `it.skip()` whose name carries the skip rationale so it stays
 *  visible in CI output. */
export async function runInjectionSuiteFor(prompt: PromptName): Promise<void> {
  // Top-level fixture load happens BEFORE describe() so each
  // covered cell gets its own per-fixture `it()` and vitest's
  // reporter shows per-(locale, category) pass/fail rows. A
  // missing fixture for a covered cell throws here, failing the
  // suite at file-load time with the actionable loader message.
  const fixtures = await loadFixturesForPrompt(prompt);

  describe(`injection corpus — ${prompt}`, () => {
    for (const skip of INJECTION_SKIPS[prompt]) {
      it.skip(`[${skip.category}] SKIPPED: ${skip.rationale}`, () => {
        // intentionally empty — the rationale IS the test
      });
    }

    for (const fixture of fixtures) {
      it(`[${fixture.locale}/${fixture.category}] ${fixture.adversaryGoal.slice(0, 80)}`, () => {
        runUniversalInvariants(fixture);
        runCategoryCheck(fixture);
      });
    }
  });
}
