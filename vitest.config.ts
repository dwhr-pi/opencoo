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
      // Phase-a e2e ship-gate runs through its own vitest
      // config (`vitest.e2e.config.ts`) on release tags via
      // `release.yml`. The default `pnpm test` MUST NOT pull
      // it in — bringing up Docker compose on every PR run
      // would 10× the CI time. (PR 32 / plan #149.)
      "tests/e2e/**",
    ],
    environment: "node",
    testTimeout: 10_000,
    // Per-file pool override so the THREAT-MODEL §5 pre-flight test
    // (which spawns a long-running bash subprocess via spawnSync —
    // ~30s for `pnpm lint` + `pnpm test:injection` on a cold cache)
    // runs in its OWN forks pool with singleFork: true. This isolates
    // its worker from the main thread-pool's IPC heartbeat so the
    // suite doesn't surface the "Timeout calling onTaskUpdate"
    // unhandled error vitest emits when a busy worker can't reach
    // the orchestrator within the IPC window. (PR-P1 / phase-a
    // appendix #8 round-2 finding S4.)
    //
    // poolMatchGlobs is deprecated in favour of `projects` in
    // vitest >=3, but it's still supported and emits a single
    // deprecation warning at boot. Migration to `projects` is a
    // v0.2 follow-up — the projects API requires restructuring
    // every existing test config and isn't worth the churn for
    // one file's pool override.
    poolMatchGlobs: [["tests/threat-model-preflight.test.ts", "forks"]],
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
