import { RuleTester } from "@typescript-eslint/rule-tester";
import * as tseslintParser from "@typescript-eslint/parser";

import { noDirectGiteaWrite } from "../src/rules/no-direct-gitea-write.js";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslintParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
});

ruleTester.run("no-direct-gitea-write", noDirectGiteaWrite, {
  valid: [
    {
      name: "default allowed path: packages/shared/wiki-write can import gitea client",
      filename: "/repo/packages/shared/wiki-write/src/client.ts",
      code: `import { createClient } from '@opencoo/gitea-client';`,
    },
    {
      name: "provision CLI can import gitea client",
      filename: "/repo/packages/cli/src/provision/bootstrap.ts",
      code: `import { createClient } from 'gitea-js';`,
    },
    {
      name: "unrelated import from a normal package is fine",
      filename: "/repo/packages/engine-ingestion/src/index.ts",
      code: `import { logger } from '@opencoo/shared-logger';`,
    },
    {
      name: "custom allowedPaths override",
      filename: "/repo/packages/custom-adapter/src/index.ts",
      code: `import { createClient } from '@opencoo/gitea-client';`,
      options: [{ allowedPaths: ["packages/custom-adapter/**"] }],
    },
  ],
  invalid: [
    {
      name: "engine-ingestion importing @opencoo/gitea-client directly",
      filename: "/repo/packages/engine-ingestion/src/pipelines/compile.ts",
      code: `import { createClient } from '@opencoo/gitea-client';`,
      errors: [{ messageId: "directGiteaWrite" }],
    },
    {
      name: "agent importing gitea-js directly",
      filename: "/repo/packages/engine-self-operating/src/agents/lint.ts",
      code: `import { giteaApi } from 'gitea-js';`,
      errors: [{ messageId: "directGiteaWrite" }],
    },
    {
      name: "arbitrary adapter importing wiki-gitea adapter",
      filename: "/repo/packages/adapters/output-asana/src/index.ts",
      code: `import { writePage } from '@opencoo/wiki-gitea';`,
      errors: [{ messageId: "directGiteaWrite" }],
    },
    {
      name: "package-path import of wiki-gitea adapter source",
      filename: "/repo/packages/engine-ingestion/src/foo.ts",
      code: `import { x } from '../../adapters/wiki-gitea/src/index.js';`,
      errors: [{ messageId: "directGiteaWrite" }],
    },
    {
      name: "re-export of gitea client counts",
      filename: "/repo/packages/engine-ingestion/src/re-export.ts",
      code: `export { createClient } from 'gitea-js';`,
      errors: [{ messageId: "directGiteaWrite" }],
    },
    {
      name: "fixtures-mode: custom allowedPaths scoping keeps fixtures flagged",
      filename:
        "/repo/tests/eslint-fixtures/no-direct-gitea-write.fixture.ts",
      code: `import { createClient } from '@opencoo/gitea-client';`,
      errors: [{ messageId: "directGiteaWrite" }],
    },
  ],
});
