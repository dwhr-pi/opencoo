import { noCrossEngineImport } from "./rules/no-cross-engine-import.js";
import { noDirectGiteaWrite } from "./rules/no-direct-gitea-write.js";
import { noDirectLlmSdk } from "./rules/no-direct-llm-sdk.js";
import { noFeatureEnvVars } from "./rules/no-feature-env-vars.js";
import { noUpdateAppendOnly } from "./rules/no-update-append-only.js";

export const meta = {
  name: "@opencoo/eslint-plugin",
  version: "0.0.0",
} as const;

export const rules = {
  "no-cross-engine-import": noCrossEngineImport,
  "no-direct-gitea-write": noDirectGiteaWrite,
  "no-direct-llm-sdk": noDirectLlmSdk,
  "no-feature-env-vars": noFeatureEnvVars,
  "no-update-append-only": noUpdateAppendOnly,
} as const;

const plugin = { meta, rules } as const;

export default plugin;
