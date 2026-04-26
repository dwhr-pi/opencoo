import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: [
      "tests/**/*.test.ts",
      "tools/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "packages/adapters/*/tests/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/eslint-fixtures/**",
      "packages/gitea-wiki-mcp-server/**",
      // packages/ui has its own vitest config (jsdom +
      // testing-library setup). Run via `pnpm --filter
      // @opencoo/ui test`; the root node-env vitest can't load
      // jsdom-dependent specs.
      "packages/ui/**",
      // Prompt-injection corpus runs through its own vitest
      // config (`vitest.injection.config.ts`) so the
      // `pnpm test` regression suite stays fast and the
      // `prompt-injection-corpus` CI job stays a distinct line
      // on the PR. (PR 31 / plan #145.)
      "**/*.injection.test.ts",
    ],
    environment: "node",
    testTimeout: 10_000,
  },
});
