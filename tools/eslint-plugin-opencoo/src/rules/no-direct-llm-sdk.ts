import { createRule } from "../utils/create-rule.js";
import { importSourceVisitor } from "../utils/import-source-visitor.js";
import { pathMatchesAny } from "../utils/path-matcher.js";

export interface NoDirectLlmSdkOptions {
  allowedPaths?: string[];
}

type MessageIds = "directLlmSdk";

const DEFAULT_ALLOWED_PATHS = ["packages/shared/llm-router/**"];

// Exact package names that are forbidden outside the router.
const FORBIDDEN_EXACT = new Set([
  "ai",
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai",
]);

// Scoped-package prefixes that are forbidden (any subpath under them).
const FORBIDDEN_SCOPE_PREFIXES = ["@ai-sdk/", "@openai/"];

function isForbiddenSource(source: string): boolean {
  if (FORBIDDEN_EXACT.has(source)) return true;
  for (const exact of FORBIDDEN_EXACT) {
    if (source.startsWith(`${exact}/`)) return true;
  }
  return FORBIDDEN_SCOPE_PREFIXES.some((p) => source.startsWith(p));
}

export const noDirectLlmSdk = createRule<
  [NoDirectLlmSdkOptions],
  MessageIds
>({
  name: "no-direct-llm-sdk",
  meta: {
    type: "problem",
    docs: {
      description:
        "Vercel AI SDK and provider SDKs may only be imported inside packages/shared/llm-router (THREAT-MODEL.md §2 invariant 5).",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          allowedPaths: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    ],
    messages: {
      directLlmSdk:
        "Import '{{source}}' is an LLM SDK; route all LLM calls through packages/shared/llm-router.",
    },
  },
  defaultOptions: [{ allowedPaths: DEFAULT_ALLOWED_PATHS }],
  create(context, [options]) {
    const allowedPaths = options.allowedPaths ?? DEFAULT_ALLOWED_PATHS;
    if (pathMatchesAny(context.filename, allowedPaths)) {
      return {};
    }

    return importSourceVisitor((node, source) => {
      if (isForbiddenSource(source)) {
        context.report({
          node,
          messageId: "directLlmSdk",
          data: { source },
        });
      }
    });
  },
});
