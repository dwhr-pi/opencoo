// Dedicated vitest config for the prompt-injection corpus.
// Invoked via `pnpm test:injection` from the repo root. Lives
// outside the default `vitest run` selection so the regression
// suite stays fast — `pnpm test` MUST NOT pull these in.
//
// CI runs this as a separate `prompt-injection-corpus` job so
// failures show up as a distinct red line on the PR rather than
// hiding inside the long unit-test run.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["packages/shared/tests/injection/*.injection.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
