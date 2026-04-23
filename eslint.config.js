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

  // 4. Fixtures block — parametrises no-cross-engine-import so it fires on
  //    the fixture path (which is NOT under packages/engine-*/ so the
  //    auto-detect would miss).
  {
    files: fixturesScope,
    plugins: { opencoo },
    languageOptions: tsLanguageOptions,
    rules: {
      ...boundaryRules,
      "opencoo/no-cross-engine-import": ["error", { appliesTo: "ingestion" }],
    },
  },
);
