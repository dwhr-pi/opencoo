# Changes — v0.1

Release notes for the first tagged opencoo release. v0.1 ships in three internal
phases (`0.1.0-a.N`, `0.1.0-b.N`, `0.1.0-c.N`) rolling up to `0.1.0` once phase c
is stable in at least one partner deployment. Phase definitions live in
`CLAUDE.md` ("v0.1 ship sequence") and `IMPLEMENTATION-PLAN.md`.

## Unreleased (pre-0.1.0-a.1)

### Added

- **Repository scaffolding (`IMPLEMENTATION-PLAN.md` §0 pre-coding gate).**
  - pnpm workspace + Turborepo monorepo shell.
  - Strict root `tsconfig.base.json` (NodeNext, `verbatimModuleSyntax`,
    `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
  - Flat ESLint config (`eslint.config.js`) wiring `typescript-eslint` +
    custom plugin `@opencoo/eslint-plugin`.
  - `@opencoo/eslint-plugin` with four boundary rules, each backed by
    `RuleTester` tests (test-first TDD, per `CONVENTIONS.md` §3):
    - `opencoo/no-cross-engine-import` — `engine-ingestion` ↔
      `engine-self-operating` import boundary
      (`architecture.md` §2.5; `THREAT-MODEL.md` §2 invariant 10).
    - `opencoo/no-direct-gitea-write` — Gitea writes must go through
      `packages/shared/wiki-write` (`THREAT-MODEL.md` §2 invariant 2).
    - `opencoo/no-direct-llm-sdk` — Vercel AI SDK / provider SDKs only inside
      `packages/shared/llm-router` (`THREAT-MODEL.md` §2 invariant 5).
    - `opencoo/no-feature-env-vars` — `process.env.*` restricted to the
      documented allow-list (`THREAT-MODEL.md` §2 invariant 9).
  - Negative-case fixtures at `tests/eslint-fixtures/` demonstrating each rule
    fires on realistic violating code; CI inverts the exit code and greps for
    all four rule IDs.
  - Vitest root harness with a single passing sanity test.
  - GitHub Actions CI job (`.github/workflows/ci.yml`): install → build plugin
    → lint → typecheck → test → fixtures-must-fail.
  - `.env.example` documenting the allow-list referenced by the
    `no-feature-env-vars` rule.
- `packageManager: pnpm@9.15.4` pinned at the repo root; legacy
  `packages/gitea-wiki-mcp-server/package-lock.json` removed in favour of the
  workspace lockfile.

- **Prompt-injection corpus (`IMPLEMENTATION-PLAN.md` §1.2.8 PR 31, phase-a
  ship-blocker).** Per-prompt fixture matrix at
  `packages/shared/src/prompts/__fixtures__/injection/{locale}/{prompt}/{category}.json`
  — 86 generated fixtures spanning the 9 v0.1 prompts × 2 locales × 6 attack
  categories from `THREAT-MODEL.md` §4.2 (direct-injection,
  indirect-via-quoted-content, cross-domain-write, path-traversal,
  unicode-homoglyph, data-exfiltration), minus 11 documented inapplicable cells
  whose `_skips.ts` rationale is rendered as the test name. The deterministic
  tier (CI default) verifies prompt-version drift, single-envelope structure,
  spotlight escape efficacy, directive-leak guard, refusal-language presence,
  and a per-category attack-shape assertion — no LLM provider is contacted.
  `pnpm fixtures:regen` rebuilds the matrix byte-deterministically;
  `pnpm fixtures:check` is the CI drift guard. Real-LLM tier moved to a
  separate manual workflow (`.github/workflows/injection-real-llm.yml`,
  `RUN_REAL_LLM=1` + `OPENROUTER_API_KEY` secret); v0.1 default cadence is
  operator-on-demand to keep the OpenRouter spend cap intact.

### Deferred

- `eslint-plugin-import-x/no-cycle` is enabled against `packages/**` but relies
  on the default resolver; a TypeScript-path-aware resolver lands alongside the
  first real `packages/shared/*` content (Phase a PR 01) where
  `tsconfig.json` paths actually exist. Current status: no cycles because
  no `packages/**` source yet — the rule is wired, not exercised.

### Not yet started

- All Phase a deliverables (`packages/shared/*`, engines, adapters, UI).
  See `IMPLEMENTATION-PLAN.md` §1.
