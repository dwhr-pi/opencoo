import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Prompt-injection corpus runs through the root-level
    // `vitest.injection.config.ts` invoked via
    // `pnpm test:injection`. Excluded here so a plain
    // `pnpm --filter @opencoo/shared test` stays fast and the
    // injection regression remains a distinct CI line.
    exclude: ["**/node_modules/**", "**/*.injection.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
