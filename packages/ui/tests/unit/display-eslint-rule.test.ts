/**
 * ESLint local rule test — PR-C4 (wave-16, phase-a appendix #16).
 *
 * Pins the `instrument-serif-scoped-to-display` rule defined in
 * `packages/ui/eslint.local.js`. The rule is the design-system
 * fence that keeps the Instrument Serif italic family reachable
 * ONLY through the `<Display>` component.
 *
 * Strategy: drive ESLint's `Linter` directly with synthetic source
 * strings + a synthetic `filename`. Avoids the typescript-eslint
 * RuleTester setup hook this package's vitest config does not load
 * (the plugin tests at `tools/eslint-plugin-opencoo/tests/` have
 * their own setup; this rule lives under the UI package
 * intentionally, per the wave-16 brief).
 */
import { describe, expect, it } from "vitest";
import { Linter } from "eslint";

import localPlugin from "../../eslint.local.js";

const RULE = "ui-local/instrument-serif-scoped-to-display";

function lint(code: string, filename: string): Linter.LintMessage[] {
  // Flat-config mode + an explicit `files` glob: without `files`,
  // ESLint reports "No matching configuration found" for the
  // synthetic filename. A liberal `**/*.{ts,tsx,js,jsx}` glob is
  // sufficient — the rule's own in-scope check (packages/ui/src/**)
  // does the real allow-list work.
  const linter = new Linter({ configType: "flat" });
  return linter.verify(
    code,
    [
      {
        files: ["**/*.{ts,tsx,js,jsx}"],
        plugins: {
          "ui-local": localPlugin as never,
        },
        rules: {
          [RULE]: "error",
        },
        languageOptions: {
          ecmaVersion: 2022,
          sourceType: "module",
          parserOptions: {
            ecmaFeatures: { jsx: true },
          },
        },
      },
    ],
    { filename },
  );
}

// Vitest runs from `packages/ui/`. The flat-config `files` glob is
// relative to the linter cwd; pin filenames to that cwd so the glob
// matches and the rule's own `packages/ui/src/...` substring check
// classifies them correctly.
function uiPath(rel: string): string {
  return `${process.cwd()}/${rel}`;
}

describe("ESLint rule: instrument-serif-scoped-to-display", () => {
  it("Display.tsx itself may reference var(--font-serif)", () => {
    const messages = lint(
      `const style = { fontFamily: "var(--font-serif)", fontStyle: "italic" };`,
      uiPath("src/components/Display.tsx"),
    );
    expect(messages.filter((m) => m.ruleId === RULE)).toHaveLength(0);
  });

  it("Display.tsx may reference t-display + t-lede class names", () => {
    const messages = lint(
      `const cls = level === 1 ? "t-display" : "t-lede";`,
      uiPath("src/components/Display.tsx"),
    );
    expect(messages.filter((m) => m.ruleId === RULE)).toHaveLength(0);
  });

  it("a non-allow-listed UI source file is rejected for var(--font-serif)", () => {
    const messages = lint(
      `const style = { fontFamily: "var(--font-serif)" };`,
      uiPath("src/routes/Reports.tsx"),
    );
    const hits = messages.filter((m) => m.ruleId === RULE);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.message ?? "").toMatch(/--font-serif/);
  });

  it("a non-allow-listed UI source file is rejected for the t-lede class name", () => {
    const messages = lint(
      `const cls = "t-lede";`,
      uiPath("src/routes/Prompts.tsx"),
    );
    expect(messages.filter((m) => m.ruleId === RULE).length).toBeGreaterThanOrEqual(1);
  });

  it("a non-allow-listed UI source file is rejected for the t-display class name", () => {
    const messages = lint(
      `const cls = "t-display";`,
      uiPath("src/routes/Activity.tsx"),
    );
    expect(messages.filter((m) => m.ruleId === RULE).length).toBeGreaterThanOrEqual(1);
  });

  it('a non-allow-listed UI source file is rejected for "Instrument Serif" string', () => {
    const messages = lint(
      `const f = "Instrument Serif, serif";`,
      uiPath("src/components/Btn.tsx"),
    );
    expect(messages.filter((m) => m.ruleId === RULE).length).toBeGreaterThanOrEqual(1);
  });

  it("files outside packages/ui/src/ are ignored (e.g. tests, sibling packages)", () => {
    const messages = lint(
      `const style = { fontFamily: "var(--font-serif)" };`,
      uiPath("tests/unit/some.test.tsx"),
    );
    expect(messages.filter((m) => m.ruleId === RULE)).toHaveLength(0);
  });

  it("unrelated literals do not trigger the rule", () => {
    const messages = lint(
      `const style = { fontFamily: "var(--font-sans)", color: "var(--ink)" };`,
      uiPath("src/routes/Reports.tsx"),
    );
    expect(messages.filter((m) => m.ruleId === RULE)).toHaveLength(0);
  });

  it("template literals are flagged the same as plain strings", () => {
    const messages = lint(
      "const f = `var(--font-serif)`;",
      uiPath("src/routes/Reports.tsx"),
    );
    expect(messages.filter((m) => m.ruleId === RULE).length).toBeGreaterThanOrEqual(1);
  });
});
