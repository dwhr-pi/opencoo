// Global coverage gate. Walks every (prompt, locale, category)
// cell in `_skips.ts` that is NOT skipped, and asserts a fixture
// file exists + parses + agrees with its filed location. Failure
// here means a fixture got renamed / deleted / mis-filed without
// updating the skip rationale.

import { describe, it, expect } from "vitest";

import {
  assertCorpusCoverageComplete,
  listOnDiskFixturePaths,
} from "../../src/prompts/__fixtures__/injection/_loader.js";
import {
  INJECTION_CATEGORIES,
  INJECTION_LOCALES,
} from "../../src/prompts/__fixtures__/injection/_categories.js";
import {
  INJECTION_SKIPS,
} from "../../src/prompts/__fixtures__/injection/_skips.js";
import { PROMPT_NAMES } from "../../src/prompts/loader.js";

describe("injection corpus — coverage gate", () => {
  it("every covered (prompt, locale, category) cell has a parseable fixture", async () => {
    await assertCorpusCoverageComplete();
  });

  it("on-disk fixtures count == covered-cells count (no orphans)", async () => {
    let coveredCount = 0;
    for (const prompt of PROMPT_NAMES) {
      const skipped = new Set<string>(
        INJECTION_SKIPS[prompt].map((s) => s.category),
      );
      const perLocaleCovered = INJECTION_CATEGORIES.filter(
        (c) => !skipped.has(c),
      ).length;
      coveredCount += perLocaleCovered * INJECTION_LOCALES.length;
    }
    const onDisk = await listOnDiskFixturePaths();
    expect(
      onDisk.length,
      `coverage drift: ${onDisk.length} fixtures on disk vs. ${coveredCount} covered cells. Run pnpm fixtures:regen to bring them in sync.`,
    ).toBe(coveredCount);
  });
});
