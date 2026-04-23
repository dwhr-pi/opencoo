# opencoo — Conventions

> Repo-specific overlay on the TDD / spec-driven / TypeScript skills at `.agents/skills/`.
> Those skill files are authoritative for the *discipline*; this document names the *opencoo-specific application*.
>
> Read first: `.agents/skills/test-driven-development/SKILL.md`, `.agents/skills/typescript-advanced-types/SKILL.md`, `.agents/skills/spec-driven-development/SKILL.md`.
>
> Companion docs: `docs/ARCHITECTURE.md`, `docs/decisions-resolved.md`, `PRD.md`, `IMPLEMENTATION-PLAN.md`, `THREAT-MODEL.md`, `CLAUDE.md`.
>
> References to `architecture.md §X` throughout this document point at the internal design-of-record, kept local and gitignored. Contributors read the distilled `docs/ARCHITECTURE.md` (shapes) and `docs/decisions-resolved.md` (decisions + rationale) for the public equivalents.

---

## 1. TDD loop — applied to this repo

The loop is **Red → Verify Red → Green → Verify Green → Refactor**. Always. No production code without a failing test first.

opencoo-specific enforcement:

- **Every `packages/shared/*` change** requires a use-case test that runs in-memory. No Docker, no network. The ports-and-adapters split exists for exactly this (`architecture.md` §14.3). If a use-case test needs Docker, a fixture is missing — add an `InMemory*` implementation next to the interface definition before writing the production code.
- **Every adapter change** requires the shared contract test suite for its port (e.g. `packages/shared/adapter-contract-tests/source-adapter.ts`) to pass. New adapters add their suite entry in the same PR.
- **Every LLM-touching code path** requires a `MockLLMClient` fixture — never hit real providers in CI (`architecture.md` §14.3). Record fixtures via `pnpm record:llm <test>` against a dev key; re-run is offline.
- **Prompt changes** require passing the injection corpus at `packages/shared/prompts/__fixtures__/injection/*` (THREAT-MODEL §4.2). A prompt PR that regresses a fixture is a ship-blocker.
- **When you think "skip TDD just this once":** stop. That's rationalization. The TDD skill's "Common Rationalizations" table covers every variant. Delete the code, start over from a failing test.

### Red → Verify Red discipline in opencoo

The non-obvious failure mode in this repo is tests that fail for the *wrong* reason. Before writing production code, run the new test and confirm:

- It fails (not errors out on import / type / fixture).
- The failure message is the one you expected.
- It fails because the feature is missing — **not** because a fixture is missing, a Zod schema is stricter than you meant, or an ESLint boundary rule blocked the import.

If the test errors, fix the error and re-run until it fails for the right reason. Only then write production code.

### No "maybe-work" merges

A test that passes sometimes doesn't count. If CI is flaky on your PR's new test, fix the flake before merging — even if re-runs are green. "Works in CI after re-run" is a known opencoo anti-pattern when adapter tests race against real external systems. Use service-containers + deterministic fixture data; pin SDK versions.

### TDD helper hygiene

If a new test surfaces the need to extend a shared test helper (e.g. `uniqueColumnNames()` needs to also look at column-level `.unique()` in addition to table-level constraints), land the helper-widening as its own test-only commit **before** the feat commit it enables. Otherwise the feat commit lands with a known-Red assertion that only goes Green in a later commit — `git bisect` on the feat commit then finds a failure in the helper, not in the feature, and reviewers have to reconstruct the ordering from surrounding commits. Match the pattern from PR 02 (`test(shared): defer getTableConfig to per-test calls`) — the helper shape was prepared before the feat commits depended on it.

---

## 2. TypeScript conventions

Strict mode is non-negotiable. `tsconfig.base.json` enables `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`. Consumers extend.

### 2.1 Type discipline

- **`unknown` over `any`.** If you can't name the type yet, use `unknown` and narrow with a type guard or Zod parse. The skill's "Use unknown over any" rule is the one we care about most here; `any` defeats the reason we picked TypeScript (`architecture.md` §17 Resolved "DB migrations": "type-safe schema acts as compile-time audit for Claude-generated queries").
- **Zod at every external boundary.** HTTP request bodies, webhook payloads, LLM structured outputs, adapter `credentialSchema` inputs, env-var parsing. Never trust a boundary; re-validate. Use `z.infer` to derive the TS type from the schema — one source of truth.
- **Branded types for domain identifiers.** `DomainSlug`, `AgentRunId`, `SourceBindingId`, `CredentialId` — all `type DomainSlug = string & { readonly __brand: 'DomainSlug' }`. Construction goes through a validator. Prevents mixing string arguments at call sites.
- **Discriminated unions for state machines.** `AutomationCandidate.status`, `AgentRun.status`, `CatalogCandidate.status`. The TS skill's "Pattern 6" applies directly. Use `switch` on the discriminant; compile fails if a case is missed.
- **`readonly` by default** on data objects. Mutation is opt-in, not opt-out. Deep-readonly (TS skill "Pattern 4") on config trees.
- **No type assertions** (`as X`) across a package boundary. Within a file, sparingly, with a comment pointing at the invariant that makes it safe. Prefer type guards (`value is X`) or `satisfies`.
- **`satisfies` over type annotation** when you want inference + conformance. `const routes = { ... } satisfies Record<string, Route>` keeps literal types.
- **No `enum`.** Use `as const` object + `keyof typeof` or string literal unions. Enums have well-known ergonomic and runtime-footprint issues; we don't need them.

### 2.2 Generics

- Use generics when a function / type genuinely varies with its input; don't sprinkle them to look clever. "Three similar lines is better than a premature abstraction" (CLAUDE.md).
- Constrain generic parameters explicitly (`<T extends HasLength>`); unconstrained `<T>` is often a sign the function should be non-generic.
- Prefer inference over manual instantiation at call sites. `identity(42)` beats `identity<number>(42)`.

### 2.3 Module shape

- **One exported concept per module** where feasible. Barrel files (`index.ts`) are fine for package-public APIs; avoid them for internal folders (they obscure cycles).
- **Adapter packages** export `{ adapter, credentialSchema }` and nothing else package-public. The shared contract test suite imports the adapter; production imports go through the adapter registry in `engine-*`.
- **No circular imports.** Detected by ESLint. A circular import almost always means a type belongs in `shared/` not in the cycle endpoints.

### 2.4 Error types

Three-class `ErrorClass` taxonomy (`architecture.md` §6.5): `Transient` / `UpstreamQuota` / `Validation`. Every thrown error from a pipeline or adapter carries the class. Downstream retry logic keys on it:

```ts
export type ErrorClass = 'transient' | 'upstream-quota' | 'validation';

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly class_: ErrorClass,
    readonly cause?: unknown,
  ) { super(message); }
}
```

`ValidationError` → immediate DLQ, no retry. `UpstreamQuota` → exponential backoff. `Transient` → linear backoff with max attempts. Don't invent new classes without updating §6.5.

---

## 3. Testing conventions

Three tiers (`architecture.md` §14.3). Each tier has a dedicated CI job; name your test files so they land in the right one.

| Tier | File naming | Runtime | CI cadence | What lives here |
|---|---|---|---|---|
| **Use-case** | `*.test.ts` | In-memory; no Docker, no net | Every commit | Shared-package logic, engine orchestration, agent harness |
| **Adapter contract** | `*.contract.test.ts` | Real external system (service-containers or mocked at protocol level) | Every commit (CI secrets required) | Every `packages/adapters/*` module |
| **e2e** | `*.e2e.test.ts` | Full `docker-compose up` | Release tags only | Golden-path flows from PRD §6 |

Rules:

- **Use-case tests must not know** that Postgres / Redis / Gitea exist. They talk to `InMemoryRepository` / `InMemoryWikiAdapter` / `MockLLMClient` instances.
- **Adapter contract tests** are the same test suite for every adapter of a given port (e.g. `sourceAdapterContract(drive)`, `sourceAdapterContract(asana)`). If a new adapter adds its own test outside the shared suite, that's a smell — either the suite needs an expansion, or the adapter is doing something off-contract.
- **e2e tests** are slow; keep them small (~6 total across the whole repo, one per PRD §5 criterion). Don't reach for e2e to test what a use-case test would cover.
- **LLM assertions:** never assert exact prose. Assert structure (Zod parse succeeds), presence of required fields, cost/tokens > 0, and (for safety-sensitive outputs) negative assertions (e.g. "output does not contain `HR wiki`").

### 3.1 Fixtures

- `__fixtures__/` folder alongside interface definitions.
- `InMemory*` implementations for every port.
- `MockLLMClient` replays recorded Vercel AI SDK responses; recording script at `packages/shared/testing/record-llm.ts`.
- Injection fixtures at `packages/shared/prompts/__fixtures__/injection/{locale}/{agent}/*.yaml`. Fixture YAML schema: `{input: string, expected: 'reject' | 'pass', rationale: string}`. `'reject'` means the prompt / classifier / harness must refuse the input (silent DLQ for Classifier per THREAT-MODEL §3.4; typed error for agents); `'pass'` means the input is benign and must round-trip without spurious flagging. Review-routing is a separate concern configured via `GuardAdapter` `fail_mode: 'review'` and is not a fixture outcome.

### 3.2 Coverage expectations

No hard coverage gate in v0.1 — gate is PRD §5 criteria, not a line-count metric. But:

- **Every exported function** in `packages/shared/*` has at least one use-case test.
- **Every error path** in the three-class `ErrorClass` taxonomy is covered — `ValidationError` on a classifier reject, `UpstreamQuota` on an LLM 429, `Transient` on a Gitea 5xx.
- **Every gate in the Surfacer → Builder → activation loop** (`architecture.md` §7.2.4) is covered by a test that verifies the gate cannot be bypassed. Gate 3 specifically: no code path in the repo calls the `activate` endpoint.

---

## 4. Folder + naming conventions

### 4.1 Monorepo layout

Source of truth: `architecture.md` §14.1. Deviations require a `DECISIONS.md` entry.

- `packages/shared/` — DB schema (single-ownership per §14.4), logger, errors, LLM router, cost tracker, credential store, wiki-write, text-normalize, prompts, adapter contract suites.
- `packages/engine-ingestion/` — Fastify boot + eight BullMQ pipelines. Never imports from `engine-self-operating/` (ESLint-enforced).
- `packages/engine-self-operating/` — Fastify boot + agent harness + five first-party agents + Review Dashboard + UI host. Never imports from `engine-ingestion/`.
- `packages/ui/` — React app, bundled as static files into `engine-self-operating`.
- `packages/adapters/<kind>-<slug>/` — one package per adapter. `source-drive`, `output-asana`, `automation-n8n-mcp`, etc.
- `packages/cli/` — `opencoo` binary.
- `packages/gitea-wiki-mcp-server/` — already present, Apache-2.0, separately publishable to npm.

### 4.2 Naming

- **Files:** `kebab-case.ts`.
- **Types and classes:** `PascalCase`.
- **Functions and variables:** `camelCase`.
- **Constants that are truly constant** (compile-time literals only): `SCREAMING_SNAKE_CASE`.
- **Test files:** `<unit-under-test>.test.ts`, `<adapter>.contract.test.ts`, `<flow>.e2e.test.ts`.
- **Fixtures:** `__fixtures__/<kind>.ts`.
- **Prompts:** `packages/shared/prompts/{locale}/{agent}/{purpose}.md`. File tag `{agent}/{locale}/vX.Y.Z` embedded in YAML front-matter; `llm-router` reads it for `prompt_version` metadata.
- **Commit messages for wiki writes:** prefixed with `[compiler]` / `[lint]` / `[builder]` / `[review-applied]` / `[schema-edit]` / `[catalog-rename]` / `[catalog-unarchive]` / `[skill-supersede]`. Downstream audit depends on the prefix (THREAT-MODEL §3.5).

### 4.3 ESLint boundary rules

Configured in `eslint.config.js` at repo root:

- `no-cross-engine-import` — `packages/engine-ingestion/*` cannot import from `packages/engine-self-operating/*` and vice versa. Coordination is via Postgres / BullMQ / Gitea (`architecture.md` §2.5).
- `no-direct-gitea-write` — non-provisioning code cannot import the Gitea API client directly. Must go through `packages/shared/wiki-write` (THREAT-MODEL §2 invariant 2).
- `no-direct-llm-sdk` — adapter and engine code cannot import `@ai-sdk/*` or the Vercel AI SDK entrypoint directly. Must go through `packages/shared/llm-router` (THREAT-MODEL §2 invariant 5).
- `no-feature-env-vars` — any new `process.env.*` outside the allowed list (`DATABASE_URL`, `ENCRYPTION_KEY`, `PORT`, `ADMIN_BOOTSTRAP_TOKEN`, each with `_FILE` variant, plus `NODE_ENV`, `LLM_DEBUG_LOG`, `LOG_LEVEL`, `TELEMETRY_ENDPOINT`) fails lint (THREAT-MODEL §2 invariant 9).
- `import/no-cycle` — no circular imports.

A PR that disables one of these rules is a `DECISIONS.md` item, not a local decision.

---

## 5. Prompts

Prompts are code. Versioned, reviewed, tested.

- Files live at `packages/shared/prompts/{en,pl}/{agent}/*.md`.
- YAML front-matter: `{ tag: "{agent}/{locale}/vX.Y.Z", tier: "thinker" | "worker" | "light", required_input_keys: [...] }`.
- Bumping `tag` is a breaking change for anything that pins a version. Follow SemVer per the file path.
- **Every prompt change runs the injection corpus** (THREAT-MODEL §4.2). A regressed fixture blocks merge.
- **Front-load critical context.** Critical rules in the first ~100 lines (`architecture.md` §3.4). LLM attention is U-shaped; late rules are regularly ignored.
- **Localize, don't translate.** `pl` prompts are written natively, not run through machine translation. Pilot's production-iterated Polish prompts seed `pl/` (CLAUDE.md). Machine-translated `pl/` files are not acceptable.

---

## 6. PR discipline

Every PR:

1. **Written test first.** If `git log` on your branch shows production code before its test, the reviewer will ask for a rebase. Squash-and-merge doesn't hide this — CI shows first-commit state.
2. **Runs the THREAT-MODEL §5 checklist.** Not optional. If an invariant is touched, §7 residual risk entry or reviewer ack.
3. **Updates documentation in the same PR.** `architecture.md`, `THREAT-MODEL.md` §3, `DECISIONS.md`, `PRD.md`, this plan — whichever the change affects.
4. **Stays inside its phase.** Phase-b PRs don't sneak into phase-a by "just adding this one thing." Plan owns phase membership; deviations need a `DECISIONS.md` entry.
5. **Commits follow the prefix convention.** `[compiler]` / `[lint]` / etc. for wiki writes; `feat:` / `fix:` / `test:` / `docs:` / `refactor:` / `chore:` for code commits.
6. **Small.** Per the TDD skill's task template, aim for ≤ ~5 files per PR. The implementation plan's "Files est." column is the budget; 2× overruns merit a reviewer heads-up.

### 6.1 When the reviewer says no

- If the reviewer says "this should use X pattern instead," and you've already implemented Y — delete Y, re-do with X. Keeping Y "as reference" is the sunk-cost fallacy (TDD skill's "Common Rationalizations" table). Don't adapt; re-implement.
- If the reviewer says "where's the test for this?" — the answer is never "I'll add it after merge." Add it, verify Red, then re-request review.

### 6.2 Amend vs follow-up commit

Pre-push tool-glitch recovery that involves adding forgotten files SHOULD land as a follow-up `chore(...)` commit rather than an amend. Amend is reserved for the rare case of correcting commit message text on the most-recent commit. Preserving `git bisect` granularity — one commit per logical change — consistently beats preserving atomicity. A repeat of this pattern across multiple PRs would be elevated to a blocker.

---

## 7. Quick-reference pointers

- **What** we're building: `PRD.md` §3.
- **When** we build each piece: `IMPLEMENTATION-PLAN.md` §1–3.
- **How** architecturally: `architecture.md` (design-of-record; §17 Resolved is the canonical decision list).
- **What not to regress** (security): `THREAT-MODEL.md` §2 (invariants), §3 (per-subsystem), §5 (PR checklist).
- **What's still open**: `DECISIONS.md` + `architecture.md` §17 Open questions.
- **Product glossary**: `architecture.md` §18.
- **TDD / TS / Spec skills**: `.agents/skills/`.

---

*Update this document in the same PR as the rule change. Silent drift between CONVENTIONS.md and `.agents/skills/` is the failure mode this doc exists to prevent.*
