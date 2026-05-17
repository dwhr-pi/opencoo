// Flat ESLint config (ESM) — opencoo §0 pre-coding gate.
// Wires typescript-eslint recommended rules + the four custom boundary
// rules defined by @opencoo/eslint-plugin over the active opencoo scope
// (packages/engine-*/, packages/shared/**, packages/adapters/**,
// packages/cli/**, packages/ui/**). packages/gitea-wiki-mcp-server/** is
// deliberately excluded — it ships as an independent npm package and
// keeps its own tsconfig/lint discipline.

import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import opencoo from "@opencoo/eslint-plugin";
// Local UI-package rule (PR-C4, wave-16): pin Instrument Serif
// references to Display.tsx. Plain-JS plugin — no build step needed;
// scoped to packages/ui/src/** by the rule's own filename check.
import uiLocal from "./packages/ui/eslint.local.js";

const opencooScope = [
  "packages/engine-ingestion/**/*.{ts,tsx}",
  "packages/engine-self-operating/**/*.{ts,tsx}",
  "packages/shared/**/*.{ts,tsx}",
  "packages/adapters/**/*.{ts,tsx}",
  "packages/cli/**/*.{ts,tsx}",
  "packages/ui/**/*.{ts,tsx}",
];

const fixturesScope = ["tests/eslint-fixtures/**/*.{ts,tsx}"];

const tsLanguageOptions = {
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
};

// Boundary rules shared by the main opencoo scope and the fixture scope.
// Fixtures override no-cross-engine-import with appliesTo:"ingestion"
// because the fixture path is NOT under packages/engine-*/ so the
// auto-detect would miss it (see §4 below).
const boundaryRules = {
  "opencoo/no-cross-engine-import": "error",
  "opencoo/no-direct-gitea-write": "error",
  "opencoo/no-direct-llm-sdk": "error",
  "opencoo/no-feature-env-vars": "error",
  "opencoo/no-update-append-only": "error",
};

export default tseslint.config(
  // 1. Global ignores — subpackage, build artefacts, dependency tree.
  {
    ignores: [
      "packages/gitea-wiki-mcp-server/**",
      "tools/eslint-plugin-opencoo/dist/**",
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      ".turbo/**",
      // Claude Code agent worktrees mirror the repo on disk. ESLint
      // walks them recursively otherwise, surfacing duplicate parses
      // of every file at a deeper path the opencoo-scope globs do
      // not match. Out-of-tree to lint.
      ".claude/worktrees/**",
    ],
  },

  // 2. typescript-eslint recommended for the opencoo scope.
  {
    files: opencooScope,
    extends: [...tseslint.configs.recommended],
    languageOptions: tsLanguageOptions,
  },

  // 3. Custom boundary rules over opencoo scope + import-x cycle guard.
  {
    files: opencooScope,
    plugins: { opencoo, "import-x": importX },
    rules: {
      ...boundaryRules,
      "import-x/no-cycle": ["error", { maxDepth: 10, ignoreExternal: true }],
    },
  },

  // 3b. UI-local rule (PR-C4, wave-16): pin Instrument Serif italic
  //     references to Display.tsx. The rule itself filters down to
  //     packages/ui/src/** at runtime by checking `context.filename`;
  //     the files glob below keeps the plugin attached only to UI
  //     source so other packages' lints don't pay the visitor cost.
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    plugins: { "ui-local": uiLocal },
    rules: {
      "ui-local/instrument-serif-scoped-to-display": "error",
    },
  },

  // 4. Fixtures block — parametrises no-cross-engine-import so it fires on
  //    the fixture path (which is NOT under packages/engine-*/ so the
  //    auto-detect would miss). Default to ingestion-direction; the
  //    self-op-direction fixture overrides via block 4b below.
  {
    files: fixturesScope,
    ignores: [
      "tests/eslint-fixtures/no-cross-engine-import-selfop.fixture.ts",
    ],
    plugins: { opencoo },
    languageOptions: tsLanguageOptions,
    rules: {
      ...boundaryRules,
      "opencoo/no-cross-engine-import": ["error", { appliesTo: "ingestion" }],
    },
  },

  // 4b. Self-op-direction fixture for no-cross-engine-import (PR 18 /
  //     plan #82 Q12). Same shape as block 4 but with
  //     appliesTo:'self-operating' so the rule fires on a hypothetical
  //     engine-self-operating file reaching INTO @opencoo/engine-ingestion.
  {
    files: ["tests/eslint-fixtures/no-cross-engine-import-selfop.fixture.ts"],
    plugins: { opencoo },
    languageOptions: tsLanguageOptions,
    rules: {
      ...boundaryRules,
      "opencoo/no-cross-engine-import": [
        "error",
        { appliesTo: "self-operating" },
      ],
    },
  },

  // 5. Adapter contract-test files legitimately read their OWN sidecar
  //    URL from process.env to gate the real-service tier (e.g.
  //    `DOCLING_URL` for converter-docling, `PANDOC_URL` for a future
  //    converter-pandoc). These URLs are NOT opencoo feature config —
  //    production code receives them at construction time from the
  //    routing layer; they only appear in tests. Scoped narrowly so
  //    adapter *production* code (packages/adapters/*/src/**) is still
  //    subject to the full allow-list.
  {
    files: ["packages/adapters/*/tests/**/*.{ts,tsx}"],
    rules: {
      "opencoo/no-feature-env-vars": "off",
    },
  },

  // 6. Classifier injection-corpus driver legitimately reads the
  //    `RUN_REAL_LLM` / `OPENROUTER_API_KEY` / `RUN_REAL_LLM_MODEL`
  //    env vars to gate the optional real-LLM tier of the corpus
  //    sweep — same shape as rule 5 for adapter sidecar URLs. The
  //    flags are CI/dev-only; no production code path reads them.
  //    Scoped narrowly to the single corpus driver so other tests
  //    in engine-ingestion remain subject to the allow-list.
  {
    files: ["packages/engine-ingestion/tests/classifier/injection.test.ts"],
    rules: {
      "opencoo/no-feature-env-vars": "off",
    },
  },

  // 7. Real-LLM integration test files (`*.real-llm.test.ts`) read
  //    `RUN_REAL_LLM` (gate flag — `=== '1'` skips the test in CI)
  //    and `OPENROUTER_API_KEY` (provider credential). These are
  //    CI/dev-only; no production code path touches them. The
  //    `*.real-llm.test.ts` pattern is the canonical gating
  //    convention: describe.skipIf(!RUN_REAL_LLM) wraps the suite,
  //    so CI never calls the real provider. First use: PR-F
  //    (source-asana Light-summary); future real-LLM tests follow
  //    the same file-naming pattern and are covered here
  //    automatically. See DECISIONS.md for the rationale entry.
  {
    files: ["**/*.real-llm.test.ts"],
    rules: {
      "opencoo/no-feature-env-vars": "off",
    },
  },

  // 8. Real-MCP smoke tests (`*.real-mcp.test.ts`) read
  //    `RUN_REAL_MCP` (gate flag), `MCP_TEST_URL` (operator-supplied
  //    server URL) and `MCP_TEST_BEARER` (operator-supplied static
  //    bearer for the test server). All three are CI/dev-only; the
  //    same `describe.skipIf(...)` gating pattern as the real-LLM
  //    tests applies — production code paths never read these.
  //    Added in PR-N3 (phase-a appendix #6) when the
  //    HttpMcpToolClient landed; the operator-self-verification
  //    smoke test against a live gitea-wiki-mcp-server lives at
  //    `packages/engine-self-operating/tests/mcp-tool-client/http.real-mcp.test.ts`.
  {
    files: ["**/*.real-mcp.test.ts"],
    rules: {
      "opencoo/no-feature-env-vars": "off",
    },
  },

  // 9. Real-n8n-mcp smoke tests (`*.real-n8n-mcp.test.ts`) read
  //    `RUN_REAL_N8N_MCP` (gate flag), `N8N_MCP_TEST_URL`
  //    (operator-supplied n8n-mcp server URL) and
  //    `N8N_MCP_TEST_BEARER` (operator-supplied bearer). All three
  //    are CI/dev-only; same `describe.skipIf(...)` gating pattern
  //    as the real-llm / real-mcp tests — production code paths
  //    never touch them. Added in PR-O3 (phase-a appendix #7) for
  //    operator-self-verification of the listAvailableTemplateSlugs
  //    boot-time call against a live n8n-mcp server. The smoke test
  //    lives at
  //    `packages/adapters/automation-n8n-mcp/tests/list-templates.real-n8n-mcp.test.ts`.
  {
    files: ["**/*.real-n8n-mcp.test.ts"],
    rules: {
      "opencoo/no-feature-env-vars": "off",
    },
  },
);
