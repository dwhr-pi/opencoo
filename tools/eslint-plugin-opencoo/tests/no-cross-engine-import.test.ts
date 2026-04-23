import { RuleTester } from "@typescript-eslint/rule-tester";
import * as tseslintParser from "@typescript-eslint/parser";

import { noCrossEngineImport } from "../src/rules/no-cross-engine-import.js";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslintParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
});

ruleTester.run("no-cross-engine-import", noCrossEngineImport, {
  valid: [
    // ingestion-land importing shared is fine
    {
      name: "ingestion → shared is allowed",
      filename: "/repo/packages/engine-ingestion/src/index.ts",
      code: `import { foo } from '@opencoo/shared-logger';`,
    },
    // self-op importing shared is fine
    {
      name: "self-operating → shared is allowed",
      filename: "/repo/packages/engine-self-operating/src/index.ts",
      code: `import { bar } from '@opencoo/shared-errors';`,
    },
    // cross-engine import but from a file NOT inside an engine — no constraint
    {
      name: "unrelated file importing engine-self-operating is allowed",
      filename: "/repo/packages/cli/src/index.ts",
      code: `import { x } from '@opencoo/engine-self-operating';`,
    },
    // ingestion importing ingestion-internal is fine
    {
      name: "intra-engine relative import",
      filename: "/repo/packages/engine-ingestion/src/pipelines/scanner.ts",
      code: `import { x } from './helpers.js';`,
    },
  ],
  invalid: [
    // the negative fixture shape: file under engine-ingestion importing engine-self-operating
    {
      name: "ingestion importing @opencoo/engine-self-operating package",
      filename: "/repo/packages/engine-ingestion/src/pipelines/heartbeat.ts",
      code: `import { foo } from '@opencoo/engine-self-operating';`,
      errors: [{ messageId: "crossEngineImport" }],
    },
    // path-based import (e.g. relative between packages)
    {
      name: "ingestion importing via packages/engine-self-operating path",
      filename: "/repo/packages/engine-ingestion/src/pipelines/heartbeat.ts",
      code: `import { foo } from '../../engine-self-operating/src/harness.js';`,
      errors: [{ messageId: "crossEngineImport" }],
    },
    // reverse direction — self-op importing ingestion
    {
      name: "self-operating importing @opencoo/engine-ingestion",
      filename: "/repo/packages/engine-self-operating/src/agents/heartbeat.ts",
      code: `import { foo } from '@opencoo/engine-ingestion';`,
      errors: [{ messageId: "crossEngineImport" }],
    },
    // scoped subpath should also match
    {
      name: "ingestion importing a subpath of engine-self-operating",
      filename: "/repo/packages/engine-ingestion/src/index.ts",
      code: `import { x } from '@opencoo/engine-self-operating/harness';`,
      errors: [{ messageId: "crossEngineImport" }],
    },
    // fixtures-mode: appliesTo override — the file is NOT under an engine dir,
    // but the rule is told to treat it as ingestion, so a self-op import fires.
    {
      name: "appliesTo override forces ingestion framing",
      filename: "/repo/tests/eslint-fixtures/no-cross-engine-import.fixture.ts",
      code: `import { foo } from '@opencoo/engine-self-operating/harness';`,
      options: [{ appliesTo: "ingestion" }],
      errors: [{ messageId: "crossEngineImport" }],
    },
    // export { x } from … should also count
    {
      name: "re-export across engines is flagged",
      filename: "/repo/packages/engine-ingestion/src/re-export.ts",
      code: `export { foo } from '@opencoo/engine-self-operating';`,
      errors: [{ messageId: "crossEngineImport" }],
    },
  ],
});
