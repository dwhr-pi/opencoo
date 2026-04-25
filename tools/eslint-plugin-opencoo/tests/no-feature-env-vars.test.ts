import { RuleTester } from "@typescript-eslint/rule-tester";
import * as tseslintParser from "@typescript-eslint/parser";

import { noFeatureEnvVars } from "../src/rules/no-feature-env-vars.js";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslintParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
});

ruleTester.run("no-feature-env-vars", noFeatureEnvVars, {
  valid: [
    {
      name: "DATABASE_URL is in the default allow-list",
      code: `const url = process.env.DATABASE_URL;`,
    },
    {
      name: "ENCRYPTION_KEY_FILE is in the default allow-list",
      code: `const p = process.env.ENCRYPTION_KEY_FILE;`,
    },
    {
      name: "NODE_ENV is always allowed",
      code: `if (process.env.NODE_ENV === 'production') {}`,
    },
    {
      name: "computed string access to an allow-listed key is fine",
      code: `const v = process.env['DATABASE_URL'];`,
    },
    {
      name: "unrelated member access is untouched",
      code: `const p = process.pid;`,
    },
    {
      name: "custom allowList extends the defaults",
      code: `const g = process.env.GITEA_URL;`,
      options: [{ allowList: ["GITEA_URL", "DATABASE_URL", "NODE_ENV"] }],
    },
    {
      name: "destructured allow-listed key is fine",
      code: `const { DATABASE_URL } = process.env;`,
    },
    {
      name: "destructured allow-listed keys with alias is fine",
      code: `const { DATABASE_URL: dbUrl, ENCRYPTION_KEY: key } = process.env;`,
    },
    {
      name: "destructuring from an unrelated object is untouched",
      code: `const source = { LLM_TIER: 'x' }; const { LLM_TIER } = source;`,
    },
    {
      name: "LOG_LEVEL member access is in the default allow-list",
      code: `const l = process.env.LOG_LEVEL;`,
    },
    {
      name: "destructured LOG_LEVEL is in the default allow-list",
      code: `const { LOG_LEVEL } = process.env;`,
    },
    {
      name: "REDIS_URL is in the default allow-list (engine-ingestion BullMQ)",
      code: `const url = process.env.REDIS_URL;`,
    },
    {
      name: "REDIS_URL_FILE is in the default allow-list (Docker secrets convention)",
      code: `const p = process.env.REDIS_URL_FILE;`,
    },
    {
      name: "GITEA_URL is in the default allow-list (engine-ingestion + provisioning)",
      code: `const url = process.env.GITEA_URL;`,
    },
    {
      name: "GITEA_URL_FILE is in the default allow-list (Docker secrets convention)",
      code: `const p = process.env.GITEA_URL_FILE;`,
    },
  ],
  invalid: [
    {
      name: "LLM_TIER is not allow-listed",
      code: `const tier = process.env.LLM_TIER;`,
      errors: [{ messageId: "featureEnvVar", data: { name: "LLM_TIER" } }],
    },
    {
      name: "two forbidden keys in one statement produce two errors",
      code: `const x = { a: process.env.LLM_TIER, b: process.env.SOMETHING_ELSE };`,
      errors: [
        { messageId: "featureEnvVar", data: { name: "LLM_TIER" } },
        { messageId: "featureEnvVar", data: { name: "SOMETHING_ELSE" } },
      ],
    },
    {
      name: "computed string access to a forbidden key flags too",
      code: `const v = process.env['LLM_TIER'];`,
      errors: [{ messageId: "featureEnvVar", data: { name: "LLM_TIER" } }],
    },
    {
      name: "dynamic (non-literal) access is a separate error",
      code: `const key = 'LLM_TIER'; const v = process.env[key];`,
      errors: [{ messageId: "dynamicAccess" }],
    },
    {
      name: "fixtures-file forbidden keys flag",
      filename:
        "/repo/tests/eslint-fixtures/no-feature-env-vars.fixture.ts",
      code: `const host = process.env.SOMETHING_ELSE; const tier = process.env.LLM_TIER;`,
      errors: [
        { messageId: "featureEnvVar", data: { name: "SOMETHING_ELSE" } },
        { messageId: "featureEnvVar", data: { name: "LLM_TIER" } },
      ],
    },
    {
      name: "destructured non-allow-listed key flags",
      code: `const { SOMETHING_ELSE } = process.env;`,
      errors: [
        { messageId: "featureEnvVar", data: { name: "SOMETHING_ELSE" } },
      ],
    },
    {
      name: "destructuring flags only the disallowed key, not the allow-listed one",
      code: `const { DATABASE_URL, BAD_VAR } = process.env;`,
      errors: [{ messageId: "featureEnvVar", data: { name: "BAD_VAR" } }],
    },
    {
      name: "aliasing disallowed key to a local still flags the source key",
      code: `const { BAD_VAR: renamed } = process.env;`,
      errors: [{ messageId: "featureEnvVar", data: { name: "BAD_VAR" } }],
    },
    {
      name: "rest element in process.env destructure is dynamic access",
      code: `const { DATABASE_URL, ...rest } = process.env;`,
      errors: [{ messageId: "dynamicAccess" }],
    },
    {
      name: "computed property in process.env destructure is dynamic access",
      code: `const key = 'X'; const { [key]: v } = process.env;`,
      errors: [{ messageId: "dynamicAccess" }],
    },
  ],
});
