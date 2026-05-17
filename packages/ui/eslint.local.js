// Local UI-package ESLint rule — PR-C4 (wave-16, phase-a appendix
// #16). Pins the design-system contract that the Instrument Serif
// italic family is reachable from the UI ONLY through the
// `<Display>` component.
//
// The rule fails on any file under `packages/ui/src/**` that:
//
//   - References `var(--font-serif)` as a string literal, OR
//   - References the `t-display` / `t-lede` typescale classes, OR
//   - Mentions the literal string "Instrument Serif"
//
// outside of the allowed paths:
//
//   - `packages/ui/src/components/Display.tsx` — the single legal
//     consumer (lints and consumes the family directly).
//   - `packages/ui/src/styles/colors_and_type.css` — the canonical
//     stylesheet that defines `--font-serif`, `t-display`, and
//     `t-lede`. (ESLint normally does not parse CSS but the path is
//     allow-listed for symmetry / future-proofing.)
//   - `packages/ui/eslint.local.js` — this file. Otherwise the rule
//     would reject itself.
//
// The rule is plugin-class so it composes with the root flat config
// at `eslint.config.js` (which already loads `@opencoo/eslint-plugin`
// and `eslint-plugin-import-x`).
//
// Implementation: visit string-literal and template-literal nodes
// and report when a forbidden substring appears in a non-allow-listed
// file.

import path from "node:path";

const FORBIDDEN_SUBSTRINGS = [
  // The CSS variable name. Substring `--font-serif` is unique enough
  // that no false positive is plausible in source code.
  "--font-serif",
  // The two typescale class names. Each is unique to the editorial
  // family per `colors_and_type.css`.
  "t-display",
  "t-lede",
  // The Instrument Serif font family literal. The `colors_and_type.css`
  // @import is the only legitimate appearance.
  "Instrument Serif",
];

// Repo-root-relative allow list, slash-normalised. The check trims
// the absolute file path back to `packages/ui/...` so that test
// invocations (which sometimes report under `/repo/...`) match.
const ALLOWED_PATHS = [
  "packages/ui/src/components/Display.tsx",
  "packages/ui/src/styles/colors_and_type.css",
  "packages/ui/eslint.local.js",
];

const SCOPE_PREFIX = "packages/ui/src/";

function normaliseRelPath(filename) {
  const normalised = filename.split(path.sep).join("/");
  const idx = normalised.lastIndexOf("packages/ui/");
  if (idx === -1) return normalised;
  return normalised.slice(idx);
}

function inAllowedPath(relPath) {
  for (const allowed of ALLOWED_PATHS) {
    if (relPath === allowed) return true;
    if (relPath.endsWith(`/${allowed}`)) return true;
  }
  return false;
}

function isInScope(relPath) {
  return (
    relPath.startsWith(SCOPE_PREFIX) ||
    relPath.includes(`/${SCOPE_PREFIX}`)
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const instrumentSerifScopedToDisplay = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Instrument Serif italic family (var(--font-serif), t-display, t-lede) may only be referenced from packages/ui/src/components/Display.tsx (the only legal call site). Defined in colors_and_type.css.",
    },
    schema: [],
    messages: {
      forbiddenReference:
        "{{ token }} may only be referenced from Display.tsx (PR-C4). Wrap your editorial copy in `<Display level=…>` instead of inlining the serif family.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    const relPath = normaliseRelPath(filename);
    if (!isInScope(relPath)) return {};
    if (inAllowedPath(relPath)) return {};

    function check(node, value) {
      if (typeof value !== "string") return;
      for (const token of FORBIDDEN_SUBSTRINGS) {
        if (value.includes(token)) {
          context.report({
            node,
            messageId: "forbiddenReference",
            data: { token },
          });
          return;
        }
      }
    }

    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value?.cooked ?? node.value?.raw ?? "");
      },
    };
  },
};

export default {
  rules: {
    "instrument-serif-scoped-to-display": instrumentSerifScopedToDisplay,
  },
};
