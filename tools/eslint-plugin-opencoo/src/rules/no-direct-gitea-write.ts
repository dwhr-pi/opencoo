import { createRule } from "../utils/create-rule.js";
import { importSourceVisitor } from "../utils/import-source-visitor.js";
import { pathMatchesAny } from "../utils/path-matcher.js";

export interface NoDirectGiteaWriteOptions {
  allowedPaths?: string[];
}

type MessageIds = "directGiteaWrite";

const DEFAULT_ALLOWED_PATHS = [
  "packages/shared/src/wiki-write/**",
  "packages/cli/src/provision/**",
];

// Forbidden package names — direct Gitea clients.
const FORBIDDEN_PACKAGES = new Set([
  "@opencoo/gitea-client",
  "gitea-js",
  "@opencoo/wiki-gitea",
]);

// Forbidden path fragments — importing wiki-gitea adapter source directly.
const FORBIDDEN_PATH_FRAGMENTS = [
  "packages/adapters/wiki-gitea/",
  "/adapters/wiki-gitea/",
];

function isForbiddenSource(source: string): boolean {
  if (FORBIDDEN_PACKAGES.has(source)) return true;
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (source.startsWith(`${pkg}/`)) return true;
  }
  return FORBIDDEN_PATH_FRAGMENTS.some((f) => source.includes(f));
}

export const noDirectGiteaWrite = createRule<
  [NoDirectGiteaWriteOptions],
  MessageIds
>({
  name: "no-direct-gitea-write",
  meta: {
    type: "problem",
    docs: {
      description:
        "Gitea API clients must not be imported outside packages/shared/wiki-write (THREAT-MODEL.md §2 invariant 2).",
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
      directGiteaWrite:
        "Import Gitea clients only inside packages/shared/wiki-write; route writes through that module instead of '{{source}}'.",
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
          messageId: "directGiteaWrite",
          data: { source },
        });
      }
    });
  },
});
