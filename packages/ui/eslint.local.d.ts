// Type declaration for the plain-JS local ESLint plugin (PR-C4,
// wave-16). TypeScript needs an explicit `.d.ts` because the
// implementation is ESM JavaScript without a co-located type file;
// the runtime shape is the ESLint flat-config plugin contract.
import type { ESLint, Linter } from "eslint";

declare const plugin: ESLint.Plugin & {
  readonly rules: Readonly<Record<string, Linter.RuleModule>>;
};

export default plugin;
