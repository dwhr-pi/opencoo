import { ESLintUtils } from "@typescript-eslint/utils";

/**
 * Builds the canonical documentation URL for an opencoo ESLint rule.
 * URL stability is the contract — the doc page doesn't need to exist yet;
 * the pre-coding gate only requires the rule ID and consistent pointer.
 */
export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/czlonkowski/opencoo/blob/main/tools/eslint-plugin-opencoo/docs/rules/${name}.md`,
);
