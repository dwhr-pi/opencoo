import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/eslint-fixtures/**",
      "packages/gitea-wiki-mcp-server/**",
    ],
    environment: "node",
    testTimeout: 10_000,
  },
});
