import { RuleTester } from "@typescript-eslint/rule-tester";
import * as tseslintParser from "@typescript-eslint/parser";

import { noDirectLlmSdk } from "../src/rules/no-direct-llm-sdk.js";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslintParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
});

ruleTester.run("no-direct-llm-sdk", noDirectLlmSdk, {
  valid: [
    {
      name: "llm-router can import Vercel AI SDK",
      filename: "/repo/packages/shared/llm-router/src/router.ts",
      code: `import { generateText } from 'ai';`,
    },
    {
      name: "llm-router can import provider plugin",
      filename: "/repo/packages/shared/llm-router/src/providers/openai.ts",
      code: `import { openai } from '@ai-sdk/openai';`,
    },
    {
      name: "llm-router can import Anthropic SDK",
      filename: "/repo/packages/shared/llm-router/src/providers/anthropic.ts",
      code: `import Anthropic from '@anthropic-ai/sdk';`,
    },
    {
      name: "non-LLM import outside router is fine",
      filename: "/repo/packages/engine-ingestion/src/index.ts",
      code: `import { logger } from '@opencoo/shared-logger';`,
    },
  ],
  invalid: [
    {
      name: "ingestion importing 'ai' directly",
      filename: "/repo/packages/engine-ingestion/src/pipelines/compile.ts",
      code: `import { generateText } from 'ai';`,
      errors: [{ messageId: "directLlmSdk" }],
    },
    {
      name: "ingestion importing @ai-sdk/openai",
      filename: "/repo/packages/engine-ingestion/src/pipelines/compile.ts",
      code: `import { openai } from '@ai-sdk/openai';`,
      errors: [{ messageId: "directLlmSdk" }],
    },
    {
      name: "ingestion importing @ai-sdk/anthropic (scoped subpath style)",
      filename: "/repo/packages/engine-ingestion/src/pipelines/compile.ts",
      code: `import { anthropic } from '@ai-sdk/anthropic';`,
      errors: [{ messageId: "directLlmSdk" }],
    },
    {
      name: "agent importing @anthropic-ai/sdk",
      filename: "/repo/packages/engine-self-operating/src/agents/heartbeat.ts",
      code: `import Anthropic from '@anthropic-ai/sdk';`,
      errors: [{ messageId: "directLlmSdk" }],
    },
    {
      name: "agent importing openai SDK",
      filename: "/repo/packages/engine-self-operating/src/agents/heartbeat.ts",
      code: `import OpenAI from 'openai';`,
      errors: [{ messageId: "directLlmSdk" }],
    },
    {
      name: "adapter importing google generative AI",
      filename: "/repo/packages/adapters/source-drive/src/index.ts",
      code: `import { GoogleGenerativeAI } from '@google/generative-ai';`,
      errors: [{ messageId: "directLlmSdk" }],
    },
    {
      name: "fixtures-file importing ai SDK flagged",
      filename: "/repo/tests/eslint-fixtures/no-direct-llm-sdk.fixture.ts",
      code: `import { generateText } from 'ai';`,
      errors: [{ messageId: "directLlmSdk" }],
    },
    {
      name: "re-export of ai SDK counts",
      filename: "/repo/packages/engine-ingestion/src/re-export.ts",
      code: `export { generateText } from 'ai';`,
      errors: [{ messageId: "directLlmSdk" }],
    },
  ],
});
