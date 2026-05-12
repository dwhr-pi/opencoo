# CHANGES-v0.1.md

> Operator-facing changelog for the `0.1.0-a` (phase-a) tag of `opencoo`.
> Phase-a is **34 merged PRs** (32 numbered rows + the §0 pre-coding gate + 2 appendix PRs) on `main` between repo init and commit `a780a99`.
> Format follows [Keep a Changelog](https://keepachangelog.com) loosely. PR numbers link to GitHub.
>
> This file is intended to be read alongside `IMPLEMENTATION-PLAN.md` (the architectural narrative + per-PR table) and `THREAT-MODEL.md` (the security-invariant reference). Where a row says "see plan §1.2.X", that's the canonical place for the deeper rationale.

---

## [0.1.0-a] - 2026-04-27 (planned)

Phase-a delivers **pilot-cutover parity + `catalog-workflows`**: `packages/shared/` foundations, the two engines (`engine-ingestion` + `engine-self-operating`), the seven first-party adapters, the five first-party agents (Heartbeat, Lint, Chat, Surfacer, Builder), the Review Dashboard server-side admin-API, the Vite + React 19 Management UI, the `@opencoo/cli` with seven verbs (six in PR 30 + the bare boot verb in #36), the prompt-injection corpus ship-blocker, and the e2e ship gate against compose-spun Gitea + Postgres + Redis.

Phase-a is the cutover surface for the design partner. **Phase-b** (`catalog-skills` + SkillMiner) and **phase-c** (partner Builder-skill overlay + marketplace live-fetch polish) are explicitly deferred to later tags per `IMPLEMENTATION-PLAN.md` §2 and §3.

### Added

#### Engines

- `@opencoo/engine-ingestion` — Fastify boot + BullMQ wiring + probe endpoints (`/health` is unconditional process-liveness 200; `/ready` runs Postgres + Redis + Gitea probes and returns 503 until all are healthy); intake + four-level dedupe + webhook receiver; classifier with XML spotlighting; compiler with atomic per-run `wikiWrite` + `page_citations` + `Worldview-Impact` git trailer; five scheduled pipelines (Scanner, Compilation Worker, Index Rebuilder, Review Dispatcher, Cleanup) (#15, #16, #17, #18, #19, #20).
- `@opencoo/engine-self-operating` — Fastify boot + bundled UI static host (one process, one port, one container); agent harness with `agent_runs` + memory-poisoning protection + destructive-MCP-tool deny-list; Heartbeat + Lint + Chat reader agents; Surfacer + Builder writer agents with the four-layer Gate-3 enforcement (type / schema / runtime / cross-package source-grep); worldview compilation pipeline with sovereignty spy + 24KB cap retry + debounce policy (#20, #21, #22, #23, #24, #25).

#### Shared packages (`packages/shared/`)

- `db` — Drizzle schemas owning every `pgTable`; the schema-ownership rule (`architecture.md` §14.4) is ESLint-enforced (#2, #3, #4).
- `logger` — JSON-per-line emitter with `ts`/`level`/`module`/`run_id`; never multi-line; raw prompts forbidden at `info` level (THREAT-MODEL §2 invariant 11) (#5).
- `errors` — `OpencooError` taxonomy with `errorClass: 'transient' | 'upstream-quota' | 'validation'` driving retry policy (#5).
- `text-normalize` — NFC + control-strip + fence-aware whitespace collapse; idempotent (#6).
- `credential-store` — AES-256-GCM, AAD-bound to credential ID, KMS-swappable behind a `CredentialStore` interface; `_FILE` Docker-secrets convention; `encryption_version` dispatcher reads old rows, writes always current (#7).
- `llm-router` — sole sanctioned LLM-call path; per-domain `llm_policy` enforcement; `local_only` sovereignty pin throws `LlmPolicyViolationError` before the call; `cost-tracker` with hard monthly spend cap that pauses the domain's BullMQ queues + throws `LlmBudgetExceededError`. **Closes the THREAT-MODEL §7 residual "no hard LLM spend cap"** (#8).
- `wiki-write` — sole sanctioned Gitea-write path; modes `'replace' | 'append' | 'delete'`; one call = one atomic Gitea commit; per-domain queue `concurrency: 1`; delete-mode daily cap (default 10) fails closed; commit-message tag enum (`[compiler]` / `[lint]` / `[index-rebuild]` / `[provision]` / etc.); cross-domain path defense-in-depth (#9).
- `prompts` — production prompts seeded from the design-partner PoC under `packages/shared/src/prompts/{en,pl}/`; `version-manifest.ts` const map enforces type-level pairing of new prompts with semver bumps (#19, #32, #34).
- `adapter-contract-tests` — three reusable contract suites: `sourceAdapterContract`, `outputAdapterContract`, `guardAdapterContract`. New adapters pass these or fail to merge (#11, #14, #26, #27).
- `adapter-registry` — `AdapterRegistry` / `SourceAdapterFactory` / `buildAdapterRegistry` contract in shared so the CLI bin and both engines build their own registries without circular dependency (#33).

#### MCP server

- `gitea-wiki-mcp-server` — REPOS configuration update + new `worldview://{domain}` and `worldview://company` resources; PAT-scope enforcement at the API layer; out-of-scope reads return uniform "not accessible" (THREAT-MODEL §3.14) (#10).

#### Adapters

- `@opencoo/converter-docling` — first `DocumentConverterAdapter`; sidecar process; `network_mode: none` recommended; fails closed on malformed input via `ConversionError`; emits `extraction_degraded` when known-tabular input produces zero GFM pipes (#11).
- `@opencoo/wiki-gitea` — Gitea-backed `WikiAdapter`; service-account git author on machine commits; `Co-authored-by:` on human-approved; queue-per-domain respected; 13-assertion shared contract suite (#13).
- `@opencoo/guard-redaction-regex` — first `GuardAdapter` with `role: 'redaction'`; 14 v1 patterns (Polish-PII-biased per the partner PoC) with checksum validators on PESEL / NIP / REGON / IBAN / Luhn; `redaction_events` rows store metadata only (THREAT-MODEL §3.3) (#14).
- `@opencoo/source-drive` — reference `SourceAdapter`; passes nine polling assertions + three webhook stubs in the shared contract suite (#26).
- `@opencoo/source-asana` — webhook-mode `SourceAdapter` (#27).
- `@opencoo/output-asana` — first `OutputAdapter`; nine-assertion `outputAdapterContract` (#27).
- `@opencoo/automation-n8n-mcp` — `AutomationAdapter` for n8n with all four Gate-3 layers (type-level on the engine port AND on the local `N8nLikeApi` surface; Zod schema rejects `active: true`; runtime hardcodes `active: false`; cross-package source-grep with token-aware comment stripping); vendored `n8n-skills` baseline at `vendor/n8n-skills/` (placeholder bundles in phase-a; live-fetch deferred to phase-c PR 43) (#28).
- `@opencoo/source-n8n` — REST scanner adapter; `content_kind: 'n8n-workflow'` bypasses `DocumentConverter`; `catalog-workflow` Compiler template is frontmatter-merge only with no LLM call; 1 MiB workflow ceiling; lossless round-trip across three fixture shapes (simple linear, branched-with-IF, loop-with-SplitInBatches) (#29).
- `@opencoo/source-fireflies` — webhook-mode `SourceAdapter` (HMAC + replay-stable `eventId` + non-empty title + collision guard + verbatim original-body `contentBytes` + meeting-title allowlist filter); `review_mode: 'approve'` default on transcription bindings (#30).

#### Agents (first-party, all five shipping in phase-a)

- **Heartbeat** — proactive daily report; max 5 alerts; reads worldview + own domain only; per-instance output-channel binding (CEO heartbeat cannot write to ops channel) (#22).
- **Lint** — weekly contradictions / stale pages / orphans / `allowed_paths: ["**"]` bindings / prompt-version drift / automation drift (#22).
- **Chat** — caller-PAT-scoped; cross-tenant SQL-leak fix (scope-domain SQL filter) (#23).
- **Surfacer** — read-only proposer; writes `automation_candidates` with `status: 'proposed'` (Gate 1, hardcoded — no caller can override) (#24).
- **Builder** — picks up only `status: 'approved'` candidates (Gate 2 — `requireApproved` throws); deploys workflows DISABLED (Gate 3 non-configurable, four layers); records `skills_used: {slug, version, sha, source}` per run (#24).
- Worldview compilation pipeline — per-domain `worldview.md` ≤ 6000 tokens; `Worldview-Impact` trailer triggers refresh with debounce (15m / 3h / 24h / never-solo); company worldview compiles from per-domain worldviews respecting source-domain LLM policy; synthetic high-impact events from Lint contradictions (#25).

#### Review Dashboard + Management UI

- Server-side admin-API plugin (#31): PAT-based auth via Gitea team membership; double-submit-cookie CSRF + `SameSite=Strict`; append-only `admin_audit_log` (`AUDIT_LOG_ACTIONS` closed Zod enum; writer rejects unknown verbs); stateless HMAC sovereignty-diff token with 5-min TTL bound to `(domainId, proposed)` payload; state-machine guards via atomic conditional UPDATE (409 on illegal transition); admin routes split between **read-only** GETs (`lint-findings`, `audit-log-read`) and **state-changing** POST/decision endpoints (`source-bindings`, `automation-candidates`, `marketplace-updates`, `logout`).
- `@opencoo/ui` package (#32): Vite + React 19 SPA bundled and served by `engine-self-operating` via `@fastify/static`; four admin tabs (Domains / Sources / LlmPolicy / Prompts); five design-system-bound components (`PatEntryModal`, `DiffPreviewDialog`, `DebugBanner`, `CredentialForm`, `PromptsDiffBanner`); `lib/{api,csrf,i18n,pat-store}.ts` with `fetchAdmin` as the sole admin-API entry point with auto-retry-once on 403 csrf_invalid; `i18next` + `react-i18next` setup with JSON locale resources under `packages/ui/src/locales/` (`en.json` populated, `pl.json` placeholder).
- LLM-policy editor (#32): server-canonical sovereignty diff; UI displays 5-min countdown; Apply disabled when expired or empty; replay protection tested.
- Admin audit-log read endpoint (#31, #32) records `audit_log.read` so operator-pulling-history is visible to the next reviewer.

#### CLI (`@opencoo/cli`)

`commander` (zero runtime deps) for parsing only — engines are not auto-migrated at boot (`--skip-migrate` is a v0.1 NO-OP for symmetry; the operator runbook is `setup → migrate → doctor`).

| Verb                      | Purpose                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencoo` (no subcommand) | Long-running engine boot verb; orchestrates `start({env})` from `engine-self-operating`; SIGTERM/SIGINT graceful shutdown; idempotent close (#36)                                                                                                                                                             |
| `opencoo migrate`         | Apply Drizzle migrations from `packages/shared/drizzle/` (#33)                                                                                                                                                                                                                                                |
| `opencoo setup`           | Generate `.env` (mode 0600, atomic write) (#33)                                                                                                                                                                                                                                                               |
| `opencoo doctor`          | Diagnostics dump: required env vars present (values never print), DB reachable, migrations applied, optional Gitea-team-check via `--admin-pat <pat>` or `OPENCOO_ADMIN_PAT[_FILE]`, internet-facing-surface enumeration (THREAT-MODEL §3.15); `--json` for CI; errors exit 1, warnings exit 0 + stderr (#33) |
| `opencoo source test`     | Validate adapter construction from a binding config (no live API calls in v0.1) (#33)                                                                                                                                                                                                                         |
| `opencoo source forget`   | GDPR-erasure: intake purge + `erasure_log` rows + `sources_bindings.enabled = false` in single transaction; non-interactive without `--dry-run` exits 1; interactive prompts `Type "<domain>/<adapter>" to confirm:` (#33)                                                                                    |
| `opencoo recompile`       | Per-page (`domain:page-path`) or `--all-in-domain <slug>` (mutually exclusive) (#33)                                                                                                                                                                                                                          |

#### Prompt-injection corpus + phase-a e2e

- 86 generated fixtures (9 prompts × 2 locales × 6 categories with 22 documented inapplicables in `_skips.ts`); 5 universal invariants per fixture + 1 per-category check; byte-deterministic generator (`pnpm fixtures:regen` / `pnpm fixtures:check`); CI ship-blocker job `prompt-injection-corpus` on the default tier; manual `workflow_dispatch` real-LLM workflow (`injection-real-llm.yml`) refuses without `OPENROUTER_API_KEY` (#34).
- Phase-a e2e ship gate (#35): four e2e specs (`ingest-to-wiki`, `heartbeat`, `forget`, `domain-and-binding-create`) against compose-spun fixture Gitea (`gitea/gitea:1.22.6` hard-pinned) + Postgres 16 + Redis 7; in-memory `SourceAdapter` fixture; deterministic seed; `compose.e2e.yml` + `compose-controller`; separate `vitest.e2e.config.ts` lane; `.github/workflows/release.yml` runs `pnpm test:e2e` on `v*` and `0.1.0-*` tags + manual `workflow_dispatch`; under the 10-minute wall-clock budget (actual: ~17 seconds in-band).
- Domain + source-binding create flow (#37) — appendix #2 closing the regression PR 29 introduced (architecture.md §13 promised "Sources — list + add" but PR 29 shipped only `+ list`). New `+ New domain` and `+ New binding` modals on the Management UI; `POST /api/admin/domains` with Gitea repo provisioning under `${GITEA_PROVISION_ORG}` (default `opencoo`); `POST /api/admin/source-bindings` encrypting `auth` + `webhook_secret` halves separately for webhook adapters; `GET /api/admin/adapters` so the UI picker derives slugs from registry, not hardcoded list; `defaultReviewModeFor(adapter_slug, domain.class)` shared lookup per `architecture.md` §307 + §364; fail-closed transactional provisioning (any provisioning error rolls back the `domains` INSERT; orphan Gitea repos are operator-deletable); regression-locked by `pnpm test:e2e -- domain-and-binding-create`.

### Changed

This is the first tagged release; all surface is greenfield. There are no pre-existing externally-consumed APIs to break. Two reviewer-flagged adjustments worth surfacing for the design partner reading the cutover diff:

- **Wiki page frontmatter contract.** PRD §5 #2 wording lists `compiled_by_run_id` in wiki frontmatter, but the v0.1 Compiler emits that field on the `page_citations` row instead. Documented inline in `tests/e2e/ingest-to-wiki.test.ts`. Reconciliation flagged for a v0.1 patch (#35).
- **Agent-run cost columns.** `tokens_in` / `tokens_out` / `cost_usd` / `latency_ms` on `agent_runs` exist and are non-null per the schema, but the v0.1 harness writes zeros regardless of router metadata (per inline `harness.ts` comment). The heartbeat e2e asserts non-null + numeric, NOT non-zero — same forward-compat softening (#35).

### Schema

Eight Drizzle migrations under `packages/shared/drizzle/`. Run in order via `opencoo migrate`. Every table that joins the append-only invariant set is ESLint-pinned by `no-update-append-only` (THREAT-MODEL §2 invariant 8).

| File                                                      | Adds                                                                                                                                                                                                                               | Notes                                                                                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_init.sql`                                           | `domains`, `sources_bindings`, `users`, `credentials` + four enums (`domain_class`, `governance_cadence`, `review_mode`, `user_role`)                                                                                              | `domains.class ∈ {'knowledge', 'catalog-workflows', 'catalog-skills'}`; nullable `llm_budget_monthly_cap_usd numeric(10,2)`; slug regex constraint; locale allow-list (#2)                     |
| `0001_ingestion_tables.sql`                               | `catalog_candidate`, `erasure_log`, `ingestion_intake`, `llm_usage`, `miner_runs`, `miner_suppressions`, `page_citations`, `redaction_events`, `webhook_events` + 9 enums                                                          | Append-only invariant encoded; `ingestion_intake` UNIQUE on `(binding_id, source_doc_id, source_revision)` is the four-level idempotency key (#3)                                              |
| `0002_agent_runs_fk_backfill.sql`                         | `agent_definitions`, `agent_instances`, `agent_runs`, `automation_candidates`, `automation_deployments`, `marketplace_updates` + 5 enums; adds FK constraints `llm_usage.run_id` → `agent_runs.id` and `page_citations.compiled_by_run_id` → `agent_runs.id` (no UPDATE/backfill — both columns were already defined as nullable in 0001/0000) | `agent_runs.skills_used jsonb default '[]'::jsonb` carries `{slug, version, sha, source}` per Builder run (#4)                                                                                 |
| `0003_llm_usage_debug_and_domain_id.sql`                  | `llm_usage_debug` table (gated by `LLM_DEBUG_LOG=1`; `ON DELETE CASCADE` from `llm_usage`); `llm_usage.domain_id uuid` (nullable, ON DELETE SET NULL)                                                                              | Append-only; Cleanup pipeline TTL-prunes via `created_at` index (#8)                                                                                                                           |
| `0004_sources_bindings_last_scan_cursor.sql`              | `sources_bindings.last_scan_cursor text`                                                                                                                                                                                           | Polling cursor for Scanner pipeline (#19)                                                                                                                                                      |
| `0005_domains_is_aggregator.sql`                          | `domains.is_aggregator boolean default false` + partial UNIQUE INDEX `WHERE is_aggregator = true`                                                                                                                                  | At most one aggregator domain (compiles `company.md` from per-domain `worldview.md`); the partial unique index enforces it at the DB layer (#25)                                               |
| `0006_admin_audit_log_users_gitea_teams.sql`              | `admin_audit_log` table (append-only); `users.gitea_teams jsonb default '[]'`; `users.gitea_teams_refreshed_at timestamptz`                                                                                                        | `admin_audit_log` joined the `INVARIANT_8_TABLES` ESLint allow-list. Persisted CACHE of last-reconciled team list — `verifyAdmin`'s runtime source of truth is `giteaClient.whoami(pat)` (#31) |
| `0007_sources_bindings_webhook_secret_credentials_id.sql` | `sources_bindings.webhook_secret_credentials_id uuid` (nullable, FK to `credentials`)                                                                                                                                              | Webhook adapters store TWO encrypted credential rows: `credentials_id` (auth) AND `webhook_secret_credentials_id` (HMAC verifier) (#37)                                                        |

### Configuration

The UI-first-configuration invariant (CLAUDE.md "UI-first configuration"; THREAT-MODEL §2 invariant 9) is **non-negotiable**: `.env` carries only the operator secrets and bind-time toggles below. Every other knob lives in Postgres and is edited via the Management UI. The ESLint rule `no-feature-env-vars` enforces this against `process.env.*` reads outside the allow-list.

Allow-listed env vars as of `0.1.0-a` (every `_FILE` variant follows the same Docker-secrets convention — read once at boot, value must be readable by the engine UID):

**Core (PR 1, plus 5 in subsequent PRs)**

- `DATABASE_URL` / `DATABASE_URL_FILE` (#1)
- `ENCRYPTION_KEY` / `ENCRYPTION_KEY_FILE` — 32-byte strict; rejects 31 / 33 / 48-byte common hex-vs-base64 mistake (#1, enforced #7)
- `PORT` / `PORT_FILE` (#1)
- `ADMIN_BOOTSTRAP_TOKEN` / `ADMIN_BOOTSTRAP_TOKEN_FILE` (#1)
- `NODE_ENV` (#1)
- `LOG_LEVEL` (#5)
- `LLM_DEBUG_LOG` — `=1` enables `llm_usage_debug` writes AND a `_llmDebugLogActive: true` banner injected into admin-API JSON responses scoped to `/api/admin*` (#8, #31)
- `TELEMETRY_ENDPOINT` (#1)
- `CI` — set by every CI provider; consumed by Playwright's `forbidOnly` and vitest's reporter selection (#32)

**Engine-ingestion bootstrap (#15)**

- `REDIS_URL` / `REDIS_URL_FILE` — BullMQ
- `GITEA_URL` / `GITEA_URL_FILE` — wiki transport

**Engine-self-operating bootstrap (#20)**

- `UI_DIST_PATH` / `UI_DIST_PATH_FILE` — points at the bundled SPA dist directory at boot

**Admin-API auth + sovereignty-diff signing (#31, #33)**

- `ADMIN_TEAM_SLUG` / `ADMIN_TEAM_SLUG_FILE` — Gitea team whose members are admins
- `SESSION_HMAC_KEY` / `SESSION_HMAC_KEY_FILE` — base64-decoded; the composition root validates the decode at boot
- `GITEA_BASE_URL` / `GITEA_BASE_URL_FILE` — fetch-based `GiteaClient` target

**CLI doctor team-check (#33)**

- `OPENCOO_ADMIN_PAT` / `OPENCOO_ADMIN_PAT_FILE` — operator PAT for the optional `doctor` team-check; only the CLI consumes it; engine procs never read it. `--admin-pat <pat>` flag wins over both env paths

**Domain provisioning (#37, appendix #2)**

- `GITEA_PROVISION_ORG` / `GITEA_PROVISION_ORG_FILE` — Gitea organisation under which `POST /api/admin/domains` provisions repos. Defaults to `opencoo` when unset

Anything not on this list is a **rule failure**. The rule's error message (`process.env.<name> is not in the allow-list ...`) names the right next step: move the knob to Postgres, or add to `.env.example` + rule allow-list with THREAT-MODEL §2 sign-off.

#### Internet-facing surfaces

`opencoo doctor` enumerates these so the operator can gate them via reverse proxy. Source: `packages/cli/src/commands/doctor.ts` `INTERNET_FACING_PATHS`.

- `/health`
- `/ready`
- `/api/admin/_csrf`
- `/api/admin/adapters` (#37)
- `/api/admin/source-bindings`
- `/api/admin/automation-candidates`
- `/api/admin/marketplace-updates`
- `/api/admin/audit-log`
- `/api/admin/domains`
- `/api/admin/lint-findings`
- `/api/admin/prompts`
- `/api/admin/logout`
- `/api/admin/domains/:id/llm-policy/preview`
- `/api/admin/domains/:id/llm-policy/apply`
- `/webhooks/asana`
- `/webhooks/fireflies`
- `/webhooks/gitea`

### Security

Phase-a enforces the THREAT-MODEL §2 non-negotiable invariants at the type / lint / runtime levels. Every PR ran the §5 PR-checklist before request-for-review.

#### ESLint boundary rules (five, all gating CI)

Source: `tools/eslint-plugin-opencoo/src/rules/`.

- **`no-cross-engine-import`** — `packages/engine-ingestion/**` cannot import from `packages/engine-self-operating/**` and vice versa. Enforces `architecture.md` §2.5 / THREAT-MODEL §2 invariant 10 (#1).
- **`no-direct-gitea-write`** — non-provisioning code cannot import the Gitea API client directly; must go through `packages/shared/wiki-write`. Enforces THREAT-MODEL §2 invariant 2. The provisioning helper added in #37 was added to a single allow-list entry; the rule now enforces "wiki-write OR the named provisioning file, nothing else" (#1, tightened #37).
- **`no-direct-llm-sdk`** — `@ai-sdk/*` / Vercel AI SDK imports forbidden outside `packages/shared/src/llm-router/providers/**`. Enforces THREAT-MODEL §2 invariant 5 / `architecture.md` §4.1 / §12.1 (anti-LiteLLM-supply-chain rationale) (#1, scope narrowed #8).
- **`no-feature-env-vars`** — `process.env.*` outside the documented allow-list is a lint error. Forbids object-rest (`const { ...rest } = process.env`) AND dynamic computed access (`process.env[varName]`). Enforces THREAT-MODEL §2 invariant 9 (#1).
- **`no-update-append-only`** — `db.update()` and `db.delete()` against any table in `INVARIANT_8_TABLES` is a lint error. Allow-list as of `0.1.0-a`: `agentRuns` (with terminalisation carve-out), `pageCitations`, `redactionEvents`, `erasureLog`, `minerSuppressions`, `adminAuditLog`. Enforces THREAT-MODEL §2 invariant 8 (#4, extended #31).

#### THREAT-MODEL §2 invariants enforced in phase-a

| #   | Invariant                                                 | Layer enforced                                                                                                                |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Adapters are leaves; no engine knowledge                  | Type / package-boundary                                                                                                       |
| 2   | `wikiWrite` is the sole sanctioned write path             | ESLint `no-direct-gitea-write` (with named-helper exception in #37)                                                           |
| 3   | Per-domain queue concurrency = 1                          | Runtime; `wiki-write` queue config                                                                                            |
| 4   | One classifier run = one Compiler call = one wiki commit  | Compiler atomicity test (#18)                                                                                                 |
| 5   | LLM calls go through `llm-router`; never direct SDK       | ESLint `no-direct-llm-sdk`                                                                                                    |
| 6   | All untrusted text wrapped in `<source_content>` envelope | Classifier + per-prompt fixture corpus (#34)                                                                                  |
| 7   | Builder NEVER calls activate / enable / toggle            | Four-layer Gate-3: type / schema / runtime / cross-package source-grep with token-aware comment stripping (#24, extended #28) |
| 8   | Append-only tables never UPDATE or DELETE                 | ESLint `no-update-append-only` (with `agent_runs` terminalisation carve-out)                                                  |
| 9   | No feature env vars                                       | ESLint `no-feature-env-vars`                                                                                                  |
| 10  | Engine processes don't import from each other             | ESLint `no-cross-engine-import`                                                                                               |
| 11  | Credentials resolved by ID, never inlined                 | `(credentialStore, credentialId)` factory shape; `@ts-expect-error` test pins on every adapter                                |

#### Closed THREAT-MODEL §7 residual risks

- **"No hard LLM spend cap"** — `cost-tracker.computeMonthToDateCost` + per-domain `llm_budget_monthly_cap_usd` + `LlmBudgetExceededError` + `QueuePauser` port. Re-enable requires admin action through the Management UI (#8).

#### Defense-in-depth (worth calling out)

- **`credential-store` byte-scan test** — runs the full lifecycle (write → read → rotate → read → delete) against both `InMemoryCredentialStore` AND `DrizzleCredentialStore` (via pglite) with two distinct sentinels; raw + base64 + JSON-reserialize scan across all captured log lines + forbidden-keys deny-list (`plaintext`, `secret`, `password`, `value`); liveness guard against an accidentally-silenced logger; `level: debug` to catch debug-only emission (#7).
- **`GiteaClient` PAT scrub** — `stripPat()` replaces all PAT occurrences with `<REDACTED>` in propagated error messages. Load-bearing grep test seeds `secret-pat-do-not-leak-1234567890abcdef`; asserts it doesn't surface in any thrown `Error` across 4xx / network drop / malformed JSON / missing-login response (#33).
- **`doctor` never prints credential VALUES** — load-bearing test seeds `ENC-KEY-do-not-leak-1234` + `hmac-secret`; asserts neither appears in stdout/stderr across human + JSON output (#33).
- **Sovereignty-diff token replay protection** — payload hash binds `(domainId, proposed)`; cross-payload + cross-domain replays rejected; tampered HMAC, expired TTL, malformed token (extra dots / missing parts / non-numeric expiresAt) all rejected (#31).
- **Pglite over pg-mem for crypto tests** — pg-mem corrupts `bytea` via UTF-8 re-encoding (`0xde 0xad 0xbe 0xef` → `0xef 0xbf 0xbd ...`), fatal for AES ciphertext. Phase-a tests use `@electric-sql/pglite` for byte-identical binary round-trip (#7).

### Deprecated

None in the first tagged release.

### Known Issues

Residual advisories from PR bodies (all flagged non-blocking; tracked for v0.2 hardening or follow-up PRs unless stated). The maintainer should triage these against pilot feedback before tagging `0.1.0`.

#### Cross-cutting

- **`commander` `--version`/`--help` double-print** — `packages/cli/src/bin.ts` catch block treats commander's `--help` / `--version` exit codes as parse failures, causing a double-print and exit 1 (cosmetic; pre-existing, not introduced in #36; flagged in #36).
- **`Sources` tab list-side query filters** — pre-existing gap from PR 29; the new `+ New binding` flow is regression-locked but list-side filtering is still v0.1 minimum. Operator UX hardening flagged for v0.2 (#37).
- **Orphan credential rows on partial binding-INSERT failure** — `encryptBindingCredentials` writes credentials before the `sources_bindings` INSERT; if the INSERT fails between the two, credential rows commit alone. No plaintext leak (the rows are AES-256-GCM encrypted with AAD-bound credential IDs); cleanup is a manual SQL one-liner. Recommend wrapping `encryptBindingCredentials` + binding INSERT in one `db.transaction` block as a follow-up PR (#37).
- **Provisioning fail-closed: orphan Gitea repos** — when `POST /api/admin/domains` rolls back after Gitea provisioning succeeded, the orphan repo requires manual operator cleanup (a click in their Gitea UI). Acceptable trade-off: operators run Gitea anyway (#37).
- **`setup --bootstrap-domain` deferred** — the Management UI flow (#37) covers domain bootstrap; a CLI scripted-deploy convenience verb is the planned phase-a appendix #3 if pilot feedback demands it.

#### `llm-router` / cost-tracker

- `LlmProviderError.errorClass === 'validation'` should split into transient-vs-validation when adapter-layer retry lands (#8, advisory #3).
- API-key provenance — document `createProvider(name, { apiKey })` as the sanctioned path; env-var fallback is dev-only (#8, advisory #4).
- TDD-hygiene lesson: sequence ESLint rule updates BEFORE the code that needs them (#8, advisory #5).
- Budget-cap concurrent race — two concurrent `generateText()` against a near-cap domain can overshoot by `~N * pre_estimate`. v0.2 hardening via `SELECT FOR UPDATE` on the domain row (#8, advisory #6).
- `debugResponseText: ""` on provider error — consider recording the error message instead, or skipping the debug insert entirely (#8, advisory #7).
- No `LLM_DEBUG_LOG=1` boot banner in router constructor (the main banner lands at engine bootstrap; the admin-API onSend hook covers the request-level banner) (#8, advisory #8).
- `numeric(10,6)` `cost_usd` overflow ceiling — add CHECK constraint `cost_usd >= 0 AND cost_usd < 10000` if NaN/Infinity smuggling surfaces (#8, advisory #9).

#### `credential-store`

- `timingSafeEqual` at AAD compare — defense-in-depth; AAD is non-secret metadata. v0.2 hardening (#7).
- Forbidden-keys scan — consider positive allow-list (`credential_id`, `schema_ref`, `reason`) instead of deny-list (#7).
- `CredentialStoreDb` generic narrowing — tighten to `PgDatabase<...,{credentials: typeof credentials}>` so mis-wired DB handles fail at compile, not runtime (#7).
- Rate-limiting on `read()` — v0.2; UUIDv4 IDs mitigate enumeration for v0.1 (#7).
- `rawRowFor` / `rawIvFor` test-only helpers on `InMemoryCredentialStore` — documented smell; consider `createTestHarness(store)` extraction if a third store impl lands (#7).

#### Source / output adapters

- `source-asana` `reviewMode` enum gap — v0.1 ships incomplete `'auto'|'review'`; full `'auto'|'approve'|'review'` matches `source-fireflies`. Reconciliation is a v0.2 advisory (#30).
- `source-fireflies` partner-traffic alignment — webhook signature header + envelope are forward-looking; PoC ground truth is currently Drive-routed. A small follow-up PR will adjust if Fireflies' actual API differs once partner traffic enables direct webhook (#30).

#### Admin-API

- Audit-log filters (`since`, `actorUserId`, `resourceType`) deferred to v0.2; operators paginate via `limit/offset` for v0.1 (#31).
- Lint-findings `?domainSlug=` filter deferred to v0.2 (#31).
- `admin_audit_log` simplified schema — typed `AuditMetadata` discriminated union constrains shapes; rich rigid columns (`resource_type`/`resource_id`/`before`/`after`) deferred to v0.2 if ops need direct SQL queries by resource (#31).
- PAT-based auth for v0.1; Gitea OAuth deferred to v0.2 (#31).
- PAT storage XSS trade-off — `sessionStorage.opencoo_pat` clears on tab close; v0.2 explores HttpOnly OAuth session cookies. Documented in `packages/ui/README.md` (#32).

#### Phase-a e2e

- `--stub-llm` flag and `opencoo heartbeat run --once` CLI verb were planner-sized but NOT shipped. The engines do not yet have a runnable bin entry or BullMQ-worker bootstrap; building those alongside the e2e harness would balloon PR 32 past budget. The same security invariants are exercised at the function-call layer (`MockLlmClient`, `MockOutputChannelAdapter`); P2 follow-ups for v0.2 alongside the engine bin entry (#35).

#### CLI

- `--skip-migrate` is a v0.1 NO-OP — engines don't auto-migrate at boot; operator runbook is `setup → migrate → doctor` (#33).
- `source test` validates adapter construction only in v0.1; live API smoke deferred to engine-harness re-use (#33).
- `source forget` does NOT rewrite Gitea wiki history — operator notice + Lint catches orphan citations (#33).

---

## Appendix #4 (PR-A through PR-J) — Observability + adapters track

Ten PRs merged after the post-32 fix-up cycle, covering the observable-enough-to-ship gap and the Asana/webhook adapter track. Full scoping in `docs/plan-appendix/phase-a-4-observability.md`. Main closes at `d4ec0c6`.

### Added

#### Schema (2 new migrations)

| File | Adds |
|---|---|
| `0008_ingestion_intake_error_text.sql` | `ingestion_intake.error_text text` — last error message for the Sources table 3-state status probe (PR-A / #42) |
| `0010_output_deliveries.sql` | `output_deliveries` audit table — one row per outbound delivery attempt from `output-webhook`; tracks `status`, `http_status`, `duration_ms`, `attempt` (PR-J / #51; was 0009 in scoping — PR-I's CLI migration landed 0009 transitively after rebase) |

#### New packages

- `@opencoo/source-webhook` — generic webhook `SourceAdapter`: HMAC via `x-signature` canonical header; replay-stable `event_id`; `contentKindMap` jsonpath routing; `reviewMode: 'review'` default; CLI registers slug (PR-I / #50).
- `@opencoo/output-webhook` — generic webhook `OutputAdapter`: signed POST to operator-configured `target_url`; HMAC + delivery-id idempotency; retry with jitter; `output_deliveries` audit per attempt; `onDlq` callback ready for PR-B.1 SSE wiring (PR-J / #51).

#### New UI components

- **`StatusPill`** — design-system-bound status indicator using glyph trio + tone color cascade; consumed by Activity, Review, and Reports tabs (PR-E / #43).
- **Activity tab** — 5th admin tab: agent-run list, run-detail drawer, Pipelines sub-view; first SSE route (`/api/admin/events`) with token-streaming gated by `LLM_DEBUG_LOG=1` (PR-B / #45).
- **Review tab** — 3 of 5 item sub-views: source-binding review, Lint findings, Surfacer candidates; skill candidates + marketplace updates ship in phase-b/c (PR-C / #48).
- **Reports tab** — 2 sub-views: Heartbeat reader (reads `agent_runs.output` without LLM re-call) and redaction-events surface (metadata only — content-cannot-reconstruct verified by 4-test security suite; THREAT-MODEL §3.3) (PR-D / #47).

#### New internet-facing surfaces

The following paths are now registered and enumerable via `opencoo doctor`:

- `/api/admin/events` — SSE bus (agent-run lifecycle + token stream, gated `LLM_DEBUG_LOG=1`)
- `/api/admin/agent-runs` + `/api/admin/agent-runs/:id` — agent-run list + detail
- `/api/admin/pipelines` — BullMQ pipeline status
- `/api/admin/heartbeat` — last Heartbeat run output (Reports tab reader)
- `/api/admin/redaction-events` — redaction metadata (no matched text)
- `/api/admin/source-bindings/:id/review-mode` — POST; transitions binding review mode
- `/api/admin/lint-findings/:runId/acknowledge` — POST; marks a Lint finding acknowledged
- Source-webhook inbound receiver path (registered per-slug at CLI setup)
- Output-webhook outbound (operator-configured `target_url` per binding)

#### Asana state-ingestion track

- `source-asana` v2 (PR-F / #44): `X-Hook-Secret` handshake branch; `deriveEventType` 6-enum filter; monitored-project filter; `summarizeAsanaEvent` Light helper (XML-spotlit per §3.4); `lightSummaryEnabled: false` default (opt-in).
- `AsanaClient` + snapshot enrichment (PR-G / #46): `snapshotMode: 'on-event'|'periodic'|'off'`; emits second `SourceEvent` with `content_kind: 'asana-project'`; fail-open on transient 5xx (logs warn + skips snapshot, raw event still pushed).
- `asana-project` Compiler template (PR-H / #49): Polish merge prompt; `spotlight()` wraps BOTH snapshot AND existing-page content; YAML-safe frontmatter; registers `'asana-project'` in `CONTENT_KINDS`.

### Residual advisories (non-blocking, tracked for follow-up)

- **PR-B.1 token streaming + SSE bus producer wiring** — Heartbeat / Lint / Chat schedulers (PRs 21+) do not yet emit per-token events onto the SSE bus; the consumer-side UI + route exist but producers are no-op until a follow-up PR wires `llm-router` stream callbacks.
- **UI filter controls for redaction-events deferred to v0.2** — Reports tab shows all events; `since` / `domainSlug` / `category` query filters are advisory for v0.2 (same pattern as audit-log filters from PR #31).
- **Light-summary v2** (real-LLM verification pending) — `summarizeAsanaEvent` was validated against the MockLLMClient; maintainer-side run against OpenRouter test key is the outstanding verification step before the feature is considered production-verified.

---

## Appendix #5 (PR-M1, PR-M2, PR-M3) — Production scheduling + worker boot + pilot runbook

Three PRs landed AFTER `0.1.0-a` shipped (2026-05-01) to close the "make it run on its own" gap appendix #4 surfaced — operators could *see* runs unfold via the Activity feed but the engine was inert from `pnpm opencoo` until manual BullMQ pushes. Appendix #5 unblocks pilot real-data smoke; it does not block the `0.1.0-a` tag (already cut).

### Added

#### Boot path

- **PR-M1** (`bc23026` / #53) — co-boot `engine-ingestion` from `pnpm opencoo` in `mode: 'workers'`. New `buildEngineWorker` helper sibling to `buildEngineQueue`. New `composeProductionFromEnv` composition root in `packages/cli/src/provision/production-composition.ts` constructs a real `WorkerContext` (WikiAdapter via Gitea REST; LlmRouter with lazy-imported per-provider `@ai-sdk/*` modules; GuardAdapter via the regex catalog; SourceAdapterRegistry built from live `sources_bindings` rows). Boot-tolerant: composition failure (missing `GITEA_PAT` / `ENCRYPTION_KEY`) falls back to `mode: 'probes-only'` — management UI stays up; webhook receiver unavailable until next restart. SSE bus forwarded so per-job lifecycle events (compile / scanner / index-rebuild / cleanup) publish onto the same bus the `/api/admin/events` stream serves. SIGTERM drains both engines in parallel within ~30s.
- **PR-M2** (`2838fdf` / #54) — production scheduler. BullMQ recurring jobs dispatch `agent_instances` rows on each row's `schedule_cron`; `nextFireAt` computed via `cron-parser`. New `opencoo agents seed` CLI verb inserts default `agent_instances` rows (one per scheduled-class agent: Heartbeat, Lint, Surfacer; Chat + Builder are on-demand and intentionally excluded), idempotent on the `(definition_slug, name)` unique. `defaultScheduleCron` populated on the three scheduled-class agent definitions. New `/api/admin/scheduler` admin-API route returns the registered schedule snapshot with `lastFireAt` from the most recent `agent_runs.started_at`. AgentDispatcher infrastructure boots with an empty `AgentRunnerRegistry` — production agent runners require `HttpMcpToolClient` (PR 23+, phase b); the rows are seeded and the route enumerates them so phase-b wiring is a registry-population PR rather than a cross-cutting refactor.
- **PR-M3** (this PR) — `docs/pilot-runbook.md` (operator-facing runbook walking pre-flight → first boot → bind a real Asana source → real-data smoke → rollback → §5 PR-checklist verification → sign-off checklist) and `scripts/smoke-real-data.ts` (operator probe — provisions transient test domain + generic-webhook binding via raw SQL, posts an HMAC-signed fixture event, polls for the `webhook_events` and `ingestion_intake` rows landing within bounded timeouts, tears down its scaffolding before exit). Registered as `pnpm smoke:real-data`. No engine code; no schema changes; no new env vars. The runbook explicitly enumerates the `AgentRunnerRegistry` gap and other v0.1 deferrals (DLQ retry workers, per-domain LLM-policy aware scheduling, cron timezone awareness, scheduler UI, smoke `--boot` mode) so operators don't bisect non-issues.

### Schema

None. Appendix #5 is pure Boot orchestration + docs.

### Configuration

No new env vars. Appendix #5 reads only from the existing allow-list. The runbook's required-env enumeration in §1 mirrors `production-composition.ts`'s `requireWithFile` set; `tests/smoke-real-data.test.ts` pins the same set so a future drift surfaces in CI.

### Residual advisories (non-blocking, tracked for the appendix #5 follow-up issue)

- **`AgentRunnerRegistry` empty at boot.** Heartbeat / Lint / Surfacer scheduled rows seed correctly and the dispatcher registers their cron triggers, but no runner is wired to actually invoke the agents. Production runners need `HttpMcpToolClient`; landing in phase b alongside PR 23+. Until then, `/api/admin/scheduler` enumerates seeded schedules with `nextFireAt` populated and `lastFireAt: null`.
- **No manual-trigger CLI for scheduled agents.** `opencoo agents seed` writes the rows; there's no `opencoo agents fire <slug>` verb. Operators trigger ad-hoc runs via `psql` (insert into `agent_runs` directly) or by awaiting the next cron tick. Tracked as a phase-b convenience.
- **`pnpm smoke:real-data --boot` is not implemented.** The operator runs `pnpm opencoo` in another terminal first; the smoke script asserts `--boot` is passed and exits 1 with a clear message otherwise. Self-boot is a phase-c convenience.
- **Smoke verifies the webhook-receiver layer only, not the full pipeline.** `pnpm smoke:real-data` provisions a transient generic-webhook binding and confirms the `webhook_events` row lands; it does NOT verify the full webhook → intake → compile → wiki chain because `source-webhook.scan()` is a no-op by design (the Scanner never produces an `ingestion_intake` row from a webhook event for this adapter). The full chain is verified by the runbook §4 manual walk against a real Asana / Drive binding. (Round-3 fix #3 narrowed the smoke's scope; round-2's earlier "writes a plaintext credential" framing is obsolete — the smoke now uses `DrizzleCredentialStore.write` per round-2 fix #1, so production crypto is exercised end-to-end.) **(Closed by appendix #6 PR-N2 — smoke now re-enables `awaitIntakeRow` polling because the receiver does direct-intake for webhook-native adapters.)**

---

## Appendix #6 (PR-N1, PR-N2, PR-N3) — Pilot autonomy + observability gates

Three PRs landed AFTER appendix #5 to close the deferred items the post-merge readiness review surfaced as blocking real-data pilot use. Appendix #6 ships the production webhook-receiver mount, the direct webhook → `ingestion_intake` fast path, and the production `HttpMcpToolClient` + populated `AgentRunnerRegistry` so scheduled Heartbeat / Lint actually fire on cron. None of these block the `0.1.0-a` tag (already cut), but together they unblock the pilot real-data smoke against the production composition.

### Added

#### Webhook receiver mount + signature-rejection observability (PR-N1, `de02fd7` / #56)

- **`buildWebhookReceiver` is mounted in production.** Pre-PR-N1 the receiver was exported but never instantiated by the production boot path; webhook deliveries had no path to `webhook_events`. Now `engine-ingestion.start({mode:'workers'})` extracts `registerWebhookRoute(app, options)` from the receiver factory and binds it to the engine's primary Fastify app before `app.listen()`. `WorkerContext` extends with four new required-in-`workers`-mode fields (`credentialStore`, `webhookVerifier`, `webhookScannerQueue`, `webhookDlqQueue`); boot-validates each before mounting. Composition root in `composeProductionWorkerContext` constructs the two new BullMQ queues + `HmacSha256Verifier` and threads them through.
- **`webhook_receiver.signature_invalid` debug log emitted on rejection.** Closes the documented runbook §5 gap: structured payload (`bindingId`, `provider`, `eventId`, `signatureHeaderName: "x-signature"`, `errorReason`) at debug level, before DLQ enqueue. Defensive `scrubPat(verifyResult.reason).slice(0, 200)` on the reason field — the `WebhookVerifier` type contract permits free-form strings, so a future custom verifier that leaks header/body bytes is automatically redacted.
- **`BuildServerOptions.bodyLimit` extended** to thread the 5 MB ingestion-side cap through the shared engine-scaffold.

#### Production `HttpMcpToolClient` + `AgentRunnerRegistry` activation (PR-N3, `aa64e10` / #57)

- **`HttpMcpToolClient`** — production HTTP MCP client implementing the existing `McpToolClient` interface byte-for-byte. Hand-rolled JSON-RPC 2.0 over `fetch` against gitea-wiki-mcp-server's `/mcp` endpoint with bearer auth (`Authorization: Bearer ${MCP_BEARER_TOKEN}`). `clearTimeout`-disciplined `AbortController` (default 30 s). Typed errors: `McpResourceNotFoundError` for canonical "resource not accessible" / JSON-RPC `-32602` shape, `McpHttpError` for transport / network failures. `safe()` helper applies `scrubPat(...).slice(0, 200)` to every error log path.
- **`AgentRunnerRegistry` populated.** New `createProductionAgentRunners` composition root + `tryComposeAgentRunnersBundleFromEnv` boot helper thread the registry into `engine-self-operating.start({ agentRunners, agentRouter })`. With `MCP_BEARER_TOKEN` set, scheduled Heartbeat + Lint fire on cron via the existing `AgentDispatcher` (PR-M2). Surfacer is INTENTIONALLY omitted when `availableTemplateSlugs.length === 0` (v0.1 has no template-catalog wiring); the orchestrator emits `surfacer.template_catalog_empty` warn at boot, and scheduled Surfacer instances land on the dispatcher's runner-missing path (BullMQ retry → DLQ) instead of running silently against an empty catalog.
- **Per-dispatch domain-slug resolution** from `agent_instances.scope_domain_ids[0]`. Per-dispatch SQL is cheap at v0.1 cron cadence; v0.2 hoists into `AgentRunContext`.
- **Boot tolerance.** Missing `MCP_BEARER_TOKEN` → engine boots with empty registry, `mcp_http.unavailable` warn line, management UI + webhook → wiki path stay alive.
- **`composeStartedEngineWithBundle`** wraps `start()` in try/catch so a boot rejection drains the bundle's pg.Pool before re-throwing — no leaked connections on a half-failed boot.
- **`MCP_BEARER_TOKEN(_FILE)` + `MCP_BASE_URL(_FILE)`** allow-listed in `tools/eslint-plugin-opencoo/src/rules/no-feature-env-vars.ts` (infrastructure-config rationale inline; same shape as `GITEA_PAT`).
- **3 new `*.real-llm.test.ts` files** (Heartbeat / Lint / Surfacer), gated `RUN_REAL_LLM=1`. Total cost under \$0.20 against OpenRouter `moonshotai/kimi-k2.6` for one run of all three.

#### Direct webhook → `ingestion_intake` fast path (PR-N2, `5790bb9` / #58)

- **Receiver direct-intake branch.** When the bound adapter exposes `webhook.enrichEvents` AND the orchestrator wired `scannerClassifyQueue`, the receiver inserts `ingestion_intake` rows itself via the shared `upsertIntake` helper + enqueues full `ScannerClassifyJob` payloads on `ingestion.scanner.classify` inline. Pre-PR-N2 the receiver enqueued to a dead `intake.scanner` queue whose consumer didn't exist; webhook-native bindings (asana, generic webhook) wrote `webhook_events` rows but `ingestion_intake` rows materialized only via the periodic Scanner cron — and `scan()` is a no-op for these adapters by design, so deliveries stalled indefinitely. The new path closes the loop in milliseconds.
- **`upsertIntake` extracted** from `pipelines/scanner.ts` to `intake/upsert-intake.ts` so receiver + scanner share one `INSERT ... ON CONFLICT DO NOTHING` path. Scanner re-exports under the historical name for sibling-package compat.
- **`enrichEvents` impl in source-webhook** resolves `metadata.contentKind` via the `contentKindMap` jsonpath rules (idempotent re-resolution; defense-in-depth for hand-built events from outside `parseEvents`). source-asana already had `enrichEvents` (snapshot-fetch path) and benefits from direct-intake too.
- **Boot-time validation symmetric with PR-N1.** `start({mode:'workers'})` throws if `ctx.enqueue` is missing — composition-root bugs surface at boot, not on first webhook delivery.
- **`direct_intake_failed` logs at `error` (not `warn`).** Signature was valid, `webhook_events` written, upstream got 200 (no retry), document lost — that's a data-loss event, not a warning. Operator alerting catches it.
- **Smoke restoration.** `pnpm smoke:real-data` re-adds `awaitIntakeRow` polling — the receiver-only scope from PR-M3 round-3 is no longer needed because the direct path means intake rows land within the smoke's timeout window.

### Schema

None. Appendix #6 is mount-wiring + new infrastructure code + docs.

### Configuration

Two new infrastructure env vars (`MCP_BEARER_TOKEN`, `MCP_BASE_URL`), allow-listed in the `no-feature-env-vars` ESLint rule with rationale comment. Both follow the `GITEA_PAT` shape (operator-level secrets needed for engine outbound auth) and accept the `_FILE` precedence variant for Docker-secrets deployments. The runbook's required-env enumeration in §1 lists both. No new feature env vars.

### Residual advisories (non-blocking, tracked for the appendix #6 follow-up issue)

- **Surfacer is omitted from the production runner registry** until the template catalog is sourced (v0.2 — likely from `catalog-workflows` once the consumer wiring lands). Operators see `surfacer.template_catalog_empty` warn at boot; scheduled Surfacer instances land in the dispatcher's runner-missing DLQ path. Workaround: `UPDATE agent_instances SET enabled = false WHERE definition_slug = 'surfacer'` to silence the BullMQ retry storm until v0.2.
- **Duplicate `pg.Pool` + `LlmRouter` per process.** The agent-runner bundle and the ingestion composition each open their own; both close paths are wired so neither leaks on SIGTERM, but it's wasteful. Refactor to shared instances is a follow-up — production works correctly today.
- **gitea-wiki-mcp-server response surface for `wiki://` URIs.** The HTTP client carries `readResource(wiki://...)` and `listResources({uriPrefix:"wiki://..."})` calls correctly to the JSON-RPC `resources/read` / `resources/list` endpoints, but whether the server (today) responds to `wiki://` URIs as registered MCP resources is a separate, server-side concern — only `worldview://{slug}` is registered today per the gitea-wiki-mcp-server README. Operators should verify against their deployment's MCP server before relying on the runbook's "Heartbeat reads wiki pages" framing. **(Closed by appendix #7 PR-O1 — `wiki://{slug}/{path}` registered alongside `worldview://{slug}`.)**

---

## Appendix #7 (PR-O1, PR-O2, PR-O3) — Scheduled agents actually do their jobs

Three PRs landed AFTER appendix #6 to close the deferred items the post-merge readiness review surfaced as blocking the partner-cutover demo. Appendix #6 turned the scheduler ON; appendix #7 makes what the scheduler dispatches produce real output. None of these block the `0.1.0-a` tag (already cut), but together they unblock the partner real-data demo where Heartbeat fires manually via CLI and produces a real wiki-derived report.

### Added

#### `wiki://` MCP resources in `gitea-wiki-mcp-server` (PR-O1, `ec3efb2` / #59)

- **Closes the runner-stalling gap from appendix #6.** Pre-PR-O1 the server only registered `worldview://{slug}`; the appendix-#6 Heartbeat / Lint runners called `readResource(wiki://{slug}/{path})` and `listResources({uriPrefix: "wiki://{slug}/"})` and got `McpResourceNotFoundError` on every dispatch — DLQ'd, then retried, then DLQ'd again. New `src/resources/wiki.ts` mirrors `worldview.ts` byte-for-byte: same uniform-deny model (`McpError(InvalidRequest, "resource not accessible")` for every deny path — prevents existence-fingerprinting), same per-request `GiteaScopeChecker.check()` with 60s LRU cache, same static-bypass, same operator-log shape.
- **Reader DELEGATES** to the existing `wiki-utils.readParsedPage()` and `path-safety.safeResolve()` rather than reinventing.
- **Lister** returns sorted URIs across all visible repos, filtered to `.md` files only, capped at 500 entries (v0.1 ceiling; pagination defers until a deployment has > 500 pages per domain). Out-of-scope repos are silently omitted so neither path nor count leaks the principal's scope.
- **MCP-SDK gotchas worked around** (each documented in source): `{+path}` (RFC 6570 reserved expansion) for slash-tolerant URI template variable; `resources/list` has no server-side prefix filter so PR-N3's `HttpMcpToolClient.listResources()` does client-side prefix matching; WHATWG URL normalization happens before the handler sees the URI (path-traversal test uses `Object.defineProperty` to bypass and exercise `safeResolve()` directly).

#### `opencoo agents fire <slug>` manual-trigger CLI (PR-O2, `26126f1` / #61)

- **Pre-cutover smoke verb for the partner.** Operators no longer wait for the next 8am cron tick to verify Heartbeat / Lint work — `opencoo agents fire heartbeat --dry-run` reports the resolved instance + runner status; `opencoo agents fire heartbeat` produces an `agent_runs` row within ~30s.
- **Resolves slug → `agent_instances` row** via `loadInstanceById` (`--instance-id <uuid>`) or by-slug-name query (default; errors with the matching ids when 2+ enabled instances exist for a slug). RFC-4122 UUID-format pre-check on `--instance-id` so typos give a clear `invalid uuid: <value>` instead of a Postgres cast error.
- **Calls `invokeAgent({trigger: 'http', inputs: {firedBy: 'cli'}})` directly via the agent harness, bypassing BullMQ.** No `sseBus` injection — CLI is operator-side; no UI is listening (asymmetry by design; the run is recorded in `agent_runs` for audit). The `agent_trigger` Postgres enum has no `'manual'` value in v0.1; `'http'` is the established convention for non-cron operator dispatches per existing harness/recorder/chat tests; the `inputs.firedBy` field is the precise audit discriminator.
- **Per-slug runner-missing hint**: `slug === 'surfacer'` keeps the appendix-#6 hint with `N8N_MCP_*` env-vars guidance; other slugs get a generic `"check spelling; valid scheduled slugs: heartbeat, lint, surfacer"`.
- **Boot-tolerance stderr** broadened to name all three failure-mode checks: `DATABASE_URL` + Postgres reachability, `MCP_BEARER_TOKEN` (or `N8N_MCP_BEARER_TOKEN`), compose-time logs above for the specific reason. Runbook §1 cross-referenced.
- **Exit-code split honored**: typed `AgentInstanceNotFoundError` → exit 1; runtime errors (DB connection, generic throw) → exit 2.

#### Surfacer activation via n8n-mcp `search_templates` (PR-O3, `951aae7` / #60)

- **`McpToolClient` extended with optional `callTool(name, args?)` method** (HttpMcpToolClient + InMemoryMcpToolClient implement it; gitea-wiki-mcp client doesn't need it — backward-compatible).
- **Second `HttpMcpToolClient` constructed for n8n-mcp** at boot via new `N8N_MCP_BASE_URL` + `N8N_MCP_BEARER_TOKEN` env vars (and `_FILE` variants). Allow-listed in the `no-feature-env-vars` ESLint rule with rationale matching `MCP_BEARER_TOKEN`. Same `clearTimeout`-disciplined `AbortController`, same `safe()` / `scrubPat` discipline, same `McpHttpError` typing. **Bearer never appears in any log payload** — verified by negative-assertion tests in both `http.test.ts` and `list-templates.test.ts`.
- **`listAvailableTemplateSlugs()` in `automation-n8n-mcp`** calls `search_templates({searchMode: 'patterns'})` to source Surfacer's catalog. Live verification of n8n-mcp shows the `patterns` mode returns AGGREGATED CATEGORIES (~10 stable identifiers like `ai_automation`, `webhook_processing`), NOT per-template slugs — defensive parser also accepts speculative `items[].slug` / `slugs[]` shapes for forward-compatibility.
- **Behavior change vs PR-N3 default**: Surfacer is now REGISTERED by default. Pre-PR-O3 it was OMITTED whenever `availableTemplateSlugs` was empty. Post-PR-O3, vendored `builderSkills` (~3 slugs: `dispatch-task` / `heartbeat-digest` / `lint-pages`) is the floor — Surfacer registers regardless of whether n8n-mcp is reachable, so operators see the runner active even on a clean local stack. The "explicit empty array → omit" path still works for tests.
- **Boot-tolerance matrix** (4 named warns, all asserted by tests): `n8n_mcp.unavailable` (env vars unset), `surfacer.template_catalog_n8n_mcp_unreachable` (n8n-mcp throws), `surfacer.template_catalog_n8n_mcp_empty` (returns 0), `surfacer.template_catalog_empty` (vendored AND override empty — corner case → Surfacer omitted).
- **`tryComposeAgentRunnersFromEnv` is now async** (cascading through `tryComposeAgentRunnersBundleFromEnv` → `composeStartedEngineWithBundle`; PR-N3 round-2's `composeStartedEngineWithBundle` already awaited the bundle).

### Schema

None. Appendix #7 is MCP-resource-registration + new CLI verb + boot-time env-derivation + docs.

### Configuration

Two new infrastructure env vars (`N8N_MCP_BASE_URL`, `N8N_MCP_BEARER_TOKEN`), allow-listed in the `no-feature-env-vars` ESLint rule with rationale comment matching `MCP_BEARER_TOKEN`'s shape (operator-level secret + URL for engine outbound auth; same as `GITEA_PAT`). Both accept the `_FILE` precedence variant for Docker-secrets deployments. Runbook §1 documents them as "if absent, Surfacer uses the vendored ~3-template baseline; absent does NOT break Heartbeat / Lint." No new feature env vars.

### Residual advisories (non-blocking, tracked for the appendix #7 follow-up issue)

- **Surfacer's category-level slugs are a soft semantic regression vs the per-template ideal.** n8n-mcp's `patterns` mode returns ~10 categories rather than the 2,700 individual templates. Surfacer proposes per-category candidates (e.g. `template_slug: "ai_automation"`); Builder rounds-trips them as workflow display labels (`opencoo-${templateSlug}`). Operator-facing semantics: less specific than the per-template ideal. v0.2 follow-up: cut over to a per-template `keyword` or `slugs` mode if/when n8n-mcp ships one; the defensive `items[].slug` / `slugs[]` parsing in `parseSlugs` is forward-compatible.
- **Duplicate `pg.Pool` + `LlmRouter` per process.** Carried over from appendix #6 — the agent-runner bundle and the ingestion composition each open their own. Both close paths are wired so neither leaks on SIGTERM, but it's wasteful. Refactor to shared instances is a follow-up.
- **Post-merge regression caught at appendix #7 close**: PR-O2 was branched before PR-O3 made `tryComposeAgentRunnersBundleFromEnv` async; the missing `await` only surfaced on `main` after both merged in sequence. One-line fix at `agents-fire.ts:191` (commit `153a198`); typecheck + 2192 root tests now pass. CI gap noted: per-PR builds pass when only one branch changes a function signature; the conflict surfaces only on the merge commit. Follow-up worth considering: a post-merge build hook (mentioned in the appendix #6 close) that runs `pnpm install && pnpm build` automatically. **(Closed by appendix #8 PR-P2 — Husky-driven post-merge install+build hook now runs automatically; bypass via `HUSKY=0` or `GIT_NO_VERIFY=1`.)**

---

## Appendix #8 (PR-P1, PR-P2, PR-P3) — Tag-readiness sweep

Three PRs landed AFTER appendix #7 to close the maintainer-side `0.1.0-a` exit-gate item AND eliminate two recurring footguns. None of these add new product surface; all are low-risk during partner cutover testing. After appendix #8: engineering-side work for `0.1.0-a` is complete.

### Added

#### THREAT-MODEL §5 pre-flight sign-off doc + helper script (PR-P1, `11dbda4` / #64)

- **Closes one of two open `0.1.0-a` exit-gate items.** Maintainer's tag-time §5 review drops from a half-day re-read to ~10 min — review + sign the pre-filled doc.
- New `scripts/threat-model-preflight.sh` runs the 5 automatable §5 checks (lint output, `pnpm test:injection` corpus per §4.2, `process.env.X` grep against production code, new `credentialSchema` exports since base, new internet-facing routes since base). Emits paste-ready markdown fragment. Registered as `pnpm threat-model:preflight`. New `--shape-only` flag for the test seam (28ms vs ~35s without).
- New `docs/threat-model-signoff-0.1.0-a.md` is the versioned per-tag sign-off artifact. Header (closing commit + timestamp + maintainer placeholder) → 12-item §5 checklist (status / evidence / sign-off line per item) → §7 residual-risk delta section → closure block (GO / STOP / MORE-WORK). Pre-filled with helper-script output + `path:line` cites for the 8 maintainer-judgment items (items 2, 3, 4, 5, 6, 7, 8, 11 — the 4 that don't need maintainer eyes are 1, 9, 10, 12).
- **§7 promotion decision documented**: appendix-#7 advisories (Surfacer category-as-slug regression, duplicate `pg.Pool`+`LlmRouter`) stay in `CHANGES-v0.1.md` Residual — flagged as not-security residuals (product semantics + operational efficiency, no unmitigated threat).
- **Stale §7 entry #11 flagged for tag-time deletion**: "No hard LLM spend cap" was closed by PR 07's `llm_budget_monthly_cap_usd` with fail-closed enforcement.
- Round-3 hardening: outer markdown fence switched to 4-backticks (CommonMark §4.5: opening fence sets delimiter length; inner 3-backtick fences in captured output now render as literal text); "four judgment items" copy aligned to "8" across 4 cross-references.

#### Post-merge install + build hook via Husky (PR-P2, `3cc4d5d` / #62)

- **Eliminates the merge-order regression class** hit twice in #6/#7 close. After `git pull` / `git merge` / `git checkout <branch>`, runs `pnpm install` if lockfile / `package.json` changed and ALWAYS runs `pnpm build` afterward.
- Adds Husky as dev dep + `.husky/{post-merge,post-checkout}` driven by shared `_postmerge-impl.sh`. Detection via `git diff $ORIG_HEAD HEAD -- pnpm-lock.yaml '*/package.json' package.json`. Bypass via `HUSKY=0` or `GIT_NO_VERIFY=1`.
- `docs/contributing.md` documents the hook + when it fires + bypass + scope (macOS / Linux / WSL supported; Windows native untested).
- CI unchanged (`actions/checkout@v4` doesn't trigger `prepare`; CI's `pnpm install --frozen-lockfile` + `pnpm build` happen as separate steps already).
- 12 use-case tests cover bypass envs, missing `ORIG_HEAD`, change detection, install + build failure paths, post-checkout file-mode short-circuit. Hermetic — uses fake-pnpm shim via per-test temp dir; no Docker, no real `pnpm` cache touched.
- Round-2 fixes: ESM-canonical `__dirname` pattern (was Vitest-polyfilled-only); dropped unused `mkdirSync` import; corrected stale env-override comment.

#### `safeErrorMessage` consolidation at `@opencoo/shared/scrub` (PR-P3, `56a5131` / #63)

- **Single source of truth for the scrub-and-cap pattern** reviewers flagged across PR-N3 + PR-O2 + PR-O3. Pure refactor; no behavior change.
- New `safeErrorMessage(err: unknown)` + `ERROR_MESSAGE_MAX_LENGTH = 200` exported from `@opencoo/shared/scrub`. Doc-comment names the contract precisely (cap value, scrub-then-cap order, Error/string/POJO coercion, the alternative cap-then-scrub failure mode + concrete 5-char-remnant example).
- **Plan said 3 sites; investigation found 9** — 5 explicit `function safeError`, 1 local `safe(s: string)` with 7 call sites, 3 inline `scrubPat(...).slice(0, 200)`. All 9 had byte-identical semantics; all 9 migrated to satisfy the acceptance criterion that grep returns only the new shared helper.
- Round-2 hardening (Copilot): `try/catch` around `String(err)` because hostile `toString()` / `[Symbol.toPrimitive]` can throw — fallback marker `[unstringifiable error value]` so failure-handling path stays alive (preserves the "never throws" contract). 2 new tests (`toString` throw + `Symbol.toPrimitive` throw paths).
- Net production change: −73 LoC plus the new ~55-line helper and ~150-line / 15-test unit suite. The straddling-boundary test (a 36-char base64url credential STARTING at byte 195) locks in the order contract for future maintainers.

### Schema

None. Appendix #8 is tooling + docs + a pure refactor.

### Configuration

No new env vars. Husky reads `HUSKY` / `GIT_NO_VERIFY` (its own well-known bypass envs) plus `OPENCOO_PNPM_BIN` / `OPENCOO_POSTMERGE_TEST_CHANGED_FILES` / `OPENCOO_POSTMERGE_BUILD_LOG` (shell-script test seams; never read from TypeScript so the `no-feature-env-vars` ESLint rule doesn't apply).

### Residual advisories (non-blocking, tracked for the appendix #8 follow-up issue)

- **`vitest.config.ts` `poolMatchGlobs` workaround for the threat-model-preflight test** is now redundant after PR-P1's `--shape-only` flag (test runs in 28ms; no IPC congestion possible). Kept as defense-in-depth at zero cost; documented in the config comment. v0.2 cleanup: remove when migrating to vitest's `projects` config.
- **Husky `core.hooksPath` writes to shared `.git/config`**, which in a worktree affects every worktree of the repo simultaneously. This matches the standard Husky pattern and was the existing setup before PR-P2; documented in `docs/contributing.md`. Not an issue today; flagged for the case where opencoo contributors with multiple long-running worktrees might want isolated hooks.
- **Merge-order conflict pattern**: PR-P2 + PR-P1 both added scripts to root `package.json` at the same anchor; the merge surfaced as a conflict on PR-P1. Resolved by keeping both scripts (purely additive). Validates the scenario the PR-P2 hook is designed to catch in the post-merge direction; the pre-merge conflict surface is a different (smaller) class.

---

### Phase-a EXIT GATE STATUS

`IMPLEMENTATION-PLAN.md` §1.3 enumerates the criteria. Status as of `d4ec0c6` (all 10 appendix-4 PRs merged):

- [x] PRD §5 criteria 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 — green in CI (Criteria 11 / 12 are phase-b and phase-c gates respectively).
- [ ] **Pilot cuts over on phase-a code.** At least one pipeline runs on opencoo in parallel with the n8n equivalent; opencoo output quality ≥ n8n baseline on reviewer sign-off. **OPEN — partner cutover is the single most important exit criterion and the gate to tagging.**
- [ ] THREAT-MODEL §5 PR-checklist run on the phase-merge commit — every box ticked or residual risk added to §7. **OPEN — to be run pre-tag.**
- [x] Fresh `docker compose up -d` → operator can create one domain + one binding through the Management UI without psql, exercised by `pnpm test:e2e -- domain-and-binding-create` (appendix #2).
- [x] `CHANGES-v0.1.md` drafted with breaking-change list from pre-release to `a.N`. **RE-EDITED at appendix-4 close** to cover all 10 PRs (PR-A through PR-J). Maintainer edit before tagging; flagged residual advisories above.

Two of five exit-gate boxes remain open; both require human action (partner sign-off + maintainer-run THREAT-MODEL checklist). No additional code work is required to tag `0.1.0-a`.

---

## Phase-a — by-section recap

This section mirrors `IMPLEMENTATION-PLAN.md` §1.2.1 through §1.2.10 for readers who want the architectural narrative rather than the operator-facing one above.

### §1.2.1 Shared foundations (PRs 01–07)

Schema first per `architecture.md` §14.4 (single ownership: `packages/shared/db/schema/*` is the only place `pgTable` lives), then logger / errors / normalize, then the load-bearing shared services. Every later PR depends on this set.

PRs: #1 (§0 pre-coding gate — pnpm/turbo workspace + 4 ESLint boundary rules), #2 (Drizzle core schema), #3 (ingestion-side schema, 9 tables), #4 (self-op schema + the 5th ESLint rule `no-update-append-only`), #5 (logger + errors + `LOG_LEVEL`), #6 (text-normalize), #7 (credential-store with the pg-mem → pglite pivot mid-PR), #8 (llm-router + cost-tracker + budget-cap, **closing the THREAT-MODEL §7 residual**).

After PR 7 the foundation checkpoint held: `pnpm test` at repo root passes with every use-case test in-memory, no Docker, no network. The `MockLLMClient` recording workflow shipped as part of PR 7 keeps the no-network invariant testable.

### §1.2.2 `wikiWrite` and Gitea MCP updates (PRs 08–09)

PR #9 (`wiki-write` — sole sanctioned write path; modes / atomic commits / queue concurrency / delete-cap / cross-domain defense). PR #10 (`gitea-wiki-mcp-server` REPOS config + `worldview://` resources + PAT-scope enforcement at the API layer).

### §1.2.3 Document conversion + guards (PRs 10–12)

PR #11 (`converter-docling`, the first adapter package + `DocumentConverterAdapter` contract suite). PR #13 (`wiki-gitea` adapter + 13-assertion shared contract). PR #14 (`guard-redaction-regex` adapter — first `GuardAdapter` + 14 v1 patterns + 12-assertion contract suite + the metadata-only sentinel test that's the THREAT-MODEL §3.3 lynchpin).

### §1.2.4 Ingestion engine (PRs 13–17)

PR #15 (engine-ingestion scaffold — Fastify boot + BullMQ + readiness probes). PR #16 (intake + dedupe + webhook receiver + sticky `signature_ok` OR-stickify). PR #17 (classifier + XML spotlighting + the foundational injection corpus — sentinel→amp→xmlbody order). PR #18 (compiler — atomic per-run `wikiWrite` + `page_citations` + `Worldview-Impact` git trailer; one classifier run = one wiki commit, ever). PR #19 (5 ingestion pipelines: Scanner / Compilation Worker / Index Rebuilder / Review Dispatcher / Cleanup; `WikiAdapter.listMarkdown` extension; `SourceAdapter` port).

### §1.2.5 Self-Op engine + first-party agents (PRs 18–22)

PR #20 (engine-self-operating scaffold + UI static host + scaffold promotion to shared). PR #21 (agent harness + spotlight promotion + invariant-8 carve-out for `agent_runs` terminalisation). PR #22 (Heartbeat + Lint reader agents + `OutputChannel` / MCP ports + writer-shape ledger probe). PR #23 (Chat agent + automation-drift detector + `callerPat` propagation + scope-domain SQL filter — the cross-tenant leak fix). PR #24 (Surfacer + Builder + the four-layer Gate-3 enforcement — type / schema / runtime / source-grep). PR #25 (worldview compilation pipeline + sovereignty spy + 24KB cap retry + debounce policy).

### §1.2.6 SourceAdapters + `catalog-workflows` (PRs 23–27)

PR #26 (`source-drive` reference SourceAdapter + 9-polling + 3-webhook stubs in the shared contract). PR #27 (`source-asana` webhook-mode + `output-asana` first OutputAdapter + 9-assertion `outputAdapterContract` + webhook stubs → real assertions). PR #28 (`automation-n8n-mcp` AutomationAdapter + vendored `n8n-skills` baseline + cross-package Gate-3 source-grep with token-aware comment stripping). PR #29 (`source-n8n` REST scanner + `catalog-workflow` Compiler template + guard wiring + shared `CONTENT_KINDS` const + lossless round-trip across 3 fixture shapes). PR #30 (`source-fireflies` webhook SourceAdapter — final §1.2.6 PR).

### §1.2.7 Review Dashboard + Management UI + CLI (PRs 28–30)

PR #31 (Review Dashboard server-side admin-API plugin — auth + CSRF + audit-log + sovereignty-token primitives + state-machine guards). PR #32 (Management UI — Vite + React 19 SPA + 4 admin tabs + 5 design-system components + LLM-policy editor + 4 new admin endpoints + version-manifest compile-time guard). PR #33 (`@opencoo/cli` 6 verbs + production composition root — `productionServerFactory` registers admin-API BEFORE static-UI, vanilla-fetch `GiteaClient` with 5s timeout + typed errors + PAT scrub, `SESSION_HMAC_KEY` base64-decode validate, `OPENCOO_ADMIN_PAT_FILE` Docker-secrets, adapter-registry contract in shared).

### §1.2.8 Prompt-injection corpus + phase-a e2e (PRs 31–32)

PR #34 (prompt-injection corpus — 5 universal invariants + 6 per-category checks across 86 fixtures × 9 prompts × 2 locales; generator with byte-determinism; orphan detection; CI ship-blocker `prompt-injection-corpus` deterministic tier; manual-trigger real-LLM workflow). PR #35 (phase-a e2e ship gate — 3 e2e specs (`ingest-to-wiki`, `heartbeat`, `forget`) against compose-spun fixture Gitea + Postgres + Redis covering PRD §5 criteria 2 / 3 / 9; in-memory `SourceAdapter` fixture; deterministic seed; `compose.e2e.yml` + `compose-controller`; separate `vitest.e2e.config.ts` lane; `.github/workflows/release.yml` runs `pnpm test:e2e` on release tags under the 10-minute wall-clock budget; output-side enforcement exercised via the PR 31 attacker-output fixtures (cross-domain-write / path-traversal / unicode-homoglyph)).

### §1.2.9 Phase-a appendix — bootable-locally `opencoo` verb (post-32)

Appendix #1 (#36): bare `opencoo` boot verb + local-dev `compose.yml`. Architecture.md §14.5 specifies bare `opencoo` (no subcommand) as the long-running boot verb; PR 30 shipped six other verbs but not the boot path. This appendix closes the gap so a partner (or maintainer) can `git clone → docker compose up -d → pnpm opencoo` against the merged phase-a code. `runServe` is pure orchestration — dynamic-imports `start({env})` from `engine-self-operating`, registers SIGTERM/SIGINT, memoises shutdown. Local-dev `compose.yml` brings up Postgres + Redis + Gitea on standard host ports (5432 / 6379 / 3000); container names (`opencoo-*`) and ports are deliberately distinct from `compose.e2e.yml` (`opencoo-e2e-*`, 55432 / 56379 / 53000) so both stacks coexist. Partner-deploy compose with `_FILE` Docker-secrets is a phase-c PR.

### §1.2.10 Phase-a appendix #2 — domain + source-binding create flow (post-36)

Appendix #2 (#37) closes the regression PR 29 introduced: architecture.md §13 promised "Sources — list + add" but PR 29 shipped only `+ list`, leaving an operator unable to bind a source through the UI without psql. PRD §5 #1 ("a default domain without manual DB edits") was failing in pilot today as a result. The PR adds the missing `+ add` flow on both Domains and Sources tabs, plus the matching admin-API endpoints (`POST /api/admin/domains` with Gitea repo provisioning, `POST /api/admin/source-bindings` with two-credential webhook split, `GET /api/admin/adapters`), the `defaultReviewModeFor` shared lookup, the `webhook_secret_credentials_id` migration (0007), fail-closed transactional provisioning (orphan Gitea repos are operator-deletable; partial DB rows are not), and the e2e regression test (`domain-and-binding-create.test.ts`) that prevents this from re-breaking. THREAT-MODEL §3.5 was updated in the same commit to document the wikiWrite-bypass exception, and the `no-direct-gitea-write` rule was tightened to allow-list exactly the new helper file. Appendix #3 — `setup --bootstrap-domain` CLI verb — is deferred until pilot feedback demands a scripted-deploy shortcut.

---

## What's NOT in `0.1.0-a` (deferred by design)

Per `IMPLEMENTATION-PLAN.md` §2 and §3:

### Phase-b (tags as `0.1.0-b.N`) — `catalog-skills` + SkillMiner

- `catalog-skills` class + Compiler template
- `source-skill-bundle` adapter
- SkillMiner Pass 1 (Worker Detector) + Pass 2 (Thinker Synthesizer + pre-summarization)
- Review Dashboard 5th item type (skill candidates) with slug-collision Supersede flow
- Miner UI tab + suppressions management
- `redaction_events` audit table + Execution Log integration

The `miner_runs`, `miner_suppressions`, `catalog_candidate`, and `redaction_events` tables ARE present in phase-a (migrations 0001 / 0003) — phase-a sets up the storage; phase-b implements the pipeline.

**Phase-b entry gate** is two consecutive weeks of phase-a stable in pilot production without a severity-1 incident — the two-week soak is the adoption contract.

### Phase-c (tags as `0.1.0-c.N`) — Overlay + marketplace live-fetch polish

- Partner Builder-skill overlay loader + Management UI Create-in-Gitea / Use-existing-URL flow
- Marketplace live-fetch loop against `czlonkowski/n8n-skills` Releases API (weekly polling, SHA verification, `marketplace_updates` row with diff, never auto-activates a new skill version)
- Review Dashboard 4th item type — Marketplace Updates entries with diff + accept/skip

The vendored `n8n-skills` baseline IS present in phase-a (`packages/adapters/automation-n8n-mcp/vendor/n8n-skills/` with placeholder bundles + `n8n-skills.lock.json` recording `{tag, sha, fetchedAt}`) — phase-a establishes the offline-bundle loader; phase-c adds the live-fetch loop and partner overlay.

`0.1.0` rolls up `a` + `b` + `c` once stable at ≥ 1 partner.

---

## Appendix #9 (Q0 through Q14, plus Q10b follow-up) — Live-test gaps: close the operator loop

Fifteen main PRs (Q0–Q14) + one fix-up follow-up (Q10b) landed AFTER appendix #8 to close every gap surfaced by the 2026-05-08 live Chrome session against the management UI. None of these add new product surface; all reduce the gap between "engine boots clean" and "operator drives a real binding through to a wiki write without psql." Two scope additions (Q13 schema-aware LLM-policy editor, Q14 live-pilot nightly e2e) were folded in per the planning Q&A. After appendix #9: an operator following `pilot-runbook.md §1–§4` can reach `agent_runs.status='success'` on a fresh `compose down -v` without a single shell out to psql.

### Added (operator-facing)

- **Schema-aware LLM-policy editor** (Q13). Three-tier (Thinker / Worker / Light) form with provider dropdown + model dropdown driven by a static `MODEL_CATALOG` (openai / anthropic / google / openrouter / ollama). Custom-input fallback for openrouter + ollama; advanced raw-JSON view collapsible. New `GET /api/admin/llm-models` route. UI strings under `t("llmPolicy.editor.*")` in en + pl.
- **Source-binding wizard config step** (Q9). Each adapter's `bindingConfigSchema` now flows from `GET /api/admin/adapters` into a third wizard step that renders required + optional config fields (with schema defaults). The admin POST validates the new `config` field and persists it into `sources_bindings.config` jsonb.
- **Source-binding row drill-down** (Q10). Click a row → modal with the webhook URL (JetBrains Mono + copy button), last error full text, sigFailCount24h. Disable / Delete actions wired to new admin PATCH/DELETE routes; FK violations on Delete surface as a 409 `fk_restricted` instead of a 500. Q10b follow-up adds TOCTOU close (RETURNING id inside tx + `ConcurrentDeleteError` sentinel) and i18n error mapping (`disableFailed` / `enableFailed` / `auth` / `transient`).
- **CredentialForm grouped labels** (Q11). `auth.personal_access_token` renders as "Auth · Personal access token" (section heading + humanised leaf), not the dot-path. A11y: `<h3>` for section headings; interleave reset for non-dotted keys.
- **Activity feed reaches LIVE** (Q1). EventSource → fetch-streaming with Bearer header + reconnect with `Last-Event-ID`. Replaces silent `CONNECTING…` state on every PAT-auth admin user.

### Added (engine-facing)

- **OpenRouter as a first-class provider** (Q4). `provider: 'openrouter'` end-to-end through `LlmRouter`; `OPENROUTER_API_KEY` in the env allow-list; runbook §1 documents.
- **Per-adapter signature + inner-secret extraction** (Q7). New `extractSignature(headers)` and `extractWebhookSecret(plaintextJson)` on the SourceAdapter contract; receiver now signs with the inner secret value (Asana, Fireflies, generic webhook), not the JSON-wrapped credential blob. Symmetric `wrapWebhookSecret(rawSecret)` helper for handshake round-trip.
- **Asana `makeAsanaClient` injection** (Q8). Default `snapshotMode: 'on-event'` now works in production composition (the default factory injects a per-binding asana client closure, mirroring the `drive` and `n8n` make\* patterns).
- **`agents seed --domain <slug>`** (Q8). Memory + scope-domain populated with usable defaults; throws cleanly if zero / multiple domains exist.
- **Single-port engine boot** (Q6). Engine-ingestion's webhook routes mount onto self-op's Fastify via a pre-listen hook; one process / one container / one port (the runbook + CLAUDE.md decision; bug pre-existed).
- **Drizzle-wrapped agent runners** (Q2). `pg.Pool` wrapped once at registry build so `runHeartbeat` / `runLint` / `runSurfacer` get the Drizzle interface they expect.
- **MCP HTTP `Accept: application/json, text/event-stream`** (Q3). Streamable HTTP spec compliance.
- **gitea-wiki-mcp-server per-request transport** (Q12). Concurrent `/mcp` POSTs no longer trip "Already connected to a transport"; lint agent's ≥4 overlapping resource reads succeed.

### Added (test + CI)

- **Migration smoke test** (Q5). `tests/migrations/migrate-applies-clean.test.ts` runs `drizzle.migrate()` on a freshly-spun pglite and asserts idempotent journal completion. Caught migration 0010's missing `USING delivery_id::uuid` in the same PR.
- **Live-pilot end-to-end nightly** (Q14). New `tests/live-pilot.real-pg.test.ts` (618 lines) + `tests/helpers/live-pilot/server.ts` (293 lines) drive every Q1-Q13 fix in one CI run; gated on `RUN_REAL_PILOT=1`. New `.github/workflows/nightly-live-pilot.yml` runs against `main` daily at 06:00 UTC + on `workflow_dispatch`. afterAll `stopCompose` gated on `ENABLED && HAS_DOCKER && !CI` so the workflow's failure-log capture step wins.
- **Husky post-checkout fresh-worktree guard** (Q0). Zero-hash ORIG check skips the post-merge install + build during `git worktree add` — required prerequisite for the agent-team workflow that drove this entire appendix.

### Schema

- No new migrations. (Q5 fixes the authored bug in 0010 in-place; the migrate smoke test catches future-drift.)

### Configuration

- New env var on the allow-list: `OPENROUTER_API_KEY` (Q4). Optional; required only when a domain LLM policy points at `provider: 'openrouter'`.

### Residual advisories (non-blocking, tracked for follow-up)

- **Token-usage shape mismatch from OpenRouter** — UI Runs tab shows `0↑ 0↓` for kimi-k2.6 calls because `@ai-sdk/openai-compatible` returns `result.usage` in a different shape than the cost-tracker expects. Cosmetic for v0.1; defer to a cost-tracker bug-fix appendix.
- **SSE 401 terminal state** — Q1's reconnect loop retried on 401 even though the PAT was durably bad. Tracked as task #47. **Closed by Appendix #11 W3** (`4fec71d` / #94) — terminal `auth_failed` event + Activity-feed inline alert + "Re-paste PAT" wired to PatEntryModal.
- **Locale consistency on Sources columns** — Sources page picks up domain-locale via i18n; rest of UI is browser-locale. Defer to a v0.2 i18n-uniformity sweep.

---

## Appendix #10 (R1 through R7) — Management-UI completeness: the operator-completeness wave

Seven PRs (R1–R7) landed AFTER appendix #9 to make the management UI the only console an operator ever needs for steady-state operations. After appendix #9 the UI covered bootstrap and first-binding-create, but every later edit (rename a domain, rotate credentials, change a schedule, run an agent right now, look up audit history, see what this is costing) fell off the UI into psql or the CLI. None of these PRs add new product surface — every feature already existed in admin-API or schema; wave-10 exposes them in the UI under design-system rules. Closes PRD §5 criterion 9 (forget impact preview) from amber to green via R7.

### Added (operator-facing)

- **Domain edit + soft-delete** (R1, `f3601a6` / #83). New `PATCH /api/admin/domains/:id` accepts `{ display_name?, locale?, is_aggregator? }` (slug + class are immutable; rename is re-create). New `DELETE /api/admin/domains/:id` soft-deletes by setting `disabled_at = now()`; hard-delete (`?hard=1`) refuses with 409 `fk_restricted` listing every FK-bearing table that references the domain. `DomainDetail` modal opens on row click in `Domains.tsx`: editable fields + Disable + Delete (with FK count + Disable suggestion when refused). PATCH writes a real-diff audit row and short-circuits to a 304-equivalent on noOp. New migration: `domains.disabled_at TIMESTAMPTZ NULL` + index `(disabled_at, slug)`.
- **Source-binding edit (config + credential rotation)** (R2, `2991d52` / #84). `PATCH /api/admin/source-bindings/:id` extended from `enabled`-only to a discriminated body (`enabled` | `config` | `credentials`). Config validates against the adapter's `bindingConfigSchema` (Q9's validator reused). Credential rotation goes through `CredentialStore.rotate` in-place; webhook adapters get partial-rotation (auth-only or `webhook_secret`-only) so handshake state survives. `SourceBindingDetail` (Q10) gains an Edit-mode toggle reusing Q9's wizard step + Q11's CredentialForm grouped labels. Audit COUNTS-only invariant holds across all PATCH branches.
- **On-demand agent execution** (R3, `9b17719` / #86). New `POST /api/admin/agents/:slug/dispatch` (CSRF + admin-auth + token-bucket rate-limit 5/hr/agent/user; 429 with `Retry-After` on bucket-empty). Calls the same `agent-runners.ts` registry the scheduler uses — no parallel path. New `AgentsRunNowButton` with idle → "Queued · 12s" → SSE-driven status states; the heartbeat-pulse glyph is the only motion loop, no spinners. Buttons land on Activity > Pipelines, Reports > Heartbeat, Review > Lint findings. New shared SSE subscription factory (one client per page) so multiple Run-now buttons don't open multiple `EventSource`s. 60s safety timeout extended to 120s and clears on unmount.
- **Audit-log viewer at `/Audit`** (R4, `f63df0e` / #85). New 8th sidebar tab consuming the existing `GET /api/admin/audit-log` route (no backend changes). Four filters: action multi-select, actor substring + UUID match, resource cross-key (type or id), ISO date range. Sticky pagination 50/page. Row click → expandable JSON payload (sanitised at write time; PAT/secret values pre-redacted by the audit writer) in JetBrains Mono. `AbortController` + cancelled-flag race close on filter changes; timestamps render as ISO-8601 UTC.
- **Cost analytics dashboard at `/Cost`** (R5, `be40636` / #88). New 9th sidebar tab + `GET /api/admin/cost-summary?period=…&groupBy=…` (CTE over `llm_usage`; SQL `LIMIT 100 DESC`; one Drizzle expression, no new table). Top: this-month total, projected month-end (linear extrapolation), per-domain burn-down with 50% / 80% / 100% threshold colors (`--healthy` → `--advisory` → `--alert`). Below: stacked tier-split bar (Thinker / Worker / Light) using paper-shift composition (no gradients), table by `domain × agent` with cost + runs columns. Empty + loading skeleton states; the heartbeat-pulse glyph is the only motion.
- **Scheduler / cadence editor** (R6, `da32817` / #87). New `PUT /api/admin/scheduler/:agent` (CSRF + cron-parser validation + `db.transaction` wrapping audit + UPDATE + BullMQ `removeRepeatableJob` / `addRepeatableJob` swap). Multi-instance atomicity: a partial failure rolls forward ALL previously-succeeded swaps to keep audit truth aligned with BullMQ state; audit metadata exposes per-instance `old_crons` drift. `SchedulerEditor` inline form on Activity > Pipelines: human-readable cadence picker (every weekday at HH:MM / every Sunday at HH:MM / first-of-month / custom cron) with a "next 5 fires" dry-preview using cron-parser locally. Restart-free.
- **Source forget impact preview** (R7, `612b36e` / #89). New shared planner `packages/shared/src/forget/planner.ts` — pure read-only SQL classifier over `page_citations` returning `{ pagesRecompiled[], pagesDeleted[], citationsRemoved, domainSlug }` (sorted output, single CTE, no N+1). New `POST /api/admin/source-bindings/:id/forget?dryRun={0|1}` (CSRF + admin-auth). Dry-run is read-only (no enqueue, no audit row). Execute path: cap-preflight → cap-reserve → audit COUNTS-only → enqueue. 409 `daily_cap_exceeded` with current `dailyDeleteCapState`. New `ImpactPreviewDialog` UI: counts summary → deleted-paths list (`--wiki` Wiki Teal on path badges — one of the few approved `--wiki` uses) → checkbox-gated `--alert`-accented Confirm. **Closes PRD §5 criterion 9 (amber → green)** — see Appendix #11 W1 for the production-composition wiring fix that flipped this from "structurally green" to "actually green" against the design-partner deployment. Closes architecture.md §6.4 page-citation impact-preview commitment.

### Schema

- New migration: `domains.disabled_at TIMESTAMPTZ NULL` + index `(disabled_at, slug)` (R1).
- No other migrations. R5 reads `llm_usage` (PR 07 schema, unchanged); R6 swaps BullMQ repeatables (no DB change); R7's planner reads `page_citations` (existing).

### Configuration

- No new env vars. (R3's rate-limit is in-memory token-bucket; no new table, no config knob.)

### Threat-model alignment (§5 PR checklist)

- 5 of 7 PRs add new admin-API write surfaces: R1 (PATCH/DELETE domains), R2 (PATCH source-bindings discriminated body), R3 (POST agents/dispatch), R6 (PUT scheduler), R7 (POST source-bindings/forget). All are CSRF-gated + admin-auth-gated + emit an audit row on every successful mutation. R4 and R5 are read-only.
- Audit-row hygiene: R7 enforces COUNTS-only (`pages_recompiled`, `pages_deleted`, `citations_removed`, `cap_used_before`, `cap_used_after`); never writes paths into the audit row. R2 redacts plaintext on credential-rotation. R1 logs real-diff before/after fields; no plaintext credentials touch the diff.
- Daily delete-cap (existing wiki-write invariant) respected: R7 cap-preflight + cap-reserve happen inside the route handler; 409 path doesn't enqueue or audit.

### Residual advisories (non-blocking, tracked for follow-up)

- **Chrome QA wave-end walkthrough** — the integrated flow walkthrough (rename a domain → rotate a binding's creds → run heartbeat now → view audit log → view cost dashboard → change Lint cadence to bi-weekly → forget a source with impact preview) ran on 2026-05-09 and surfaced the five wiring + UX gaps that became Appendix #11 (W1–W5). The post-W1 re-walkthrough against the wired forget path is still outstanding before tag.
- **`OPENROUTER_API_KEY` repo secret for nightly-green** — the appendix-#9 nightly live-pilot workflow requires this secret to be set in repo settings for the lane to flip green; verification step before tag.
- **Copilot-loop stale re-flags** — same pattern observed in appendix #9: after a fix-up commit lands, Copilot re-flags pre-fix lines as stale; verified clean by inspection rather than chasing the loop. Not a code residual; a process note.

---

## Appendix #11 (W1 through W7) — Pilot-cutover hardening: wave-10 closeout fix-ups

Seven PRs (W1–W7) landed AFTER appendix #10 to close every pre-tag operational gap surfaced by the 2026-05-09 wave-10 closeout Chrome QA walkthrough plus the 2026-05-10 post-W6 re-walkthrough. W1–W5 closed the gaps the original walkthrough surfaced directly; W6 closed follow-up task #65 (the W1 consumer-worker deferral) so the forget operation is end-to-end functional in pilot production; W7 closed one further regression that survived all of W1 + W6 — the SPA's `fetchAdmin` wrapper had been sending `content-type: application/json` on body-less POSTs, tripping Fastify's `FST_ERR_CTP_EMPTY_JSON_BODY` (HTTP 400) and breaking the R7 dialog despite the route + worker + composition all being correctly wired. The walkthrough exercised the appendix-#10 integrated flow end-to-end (rename a domain → rotate a binding's credentials → run heartbeat now → view audit log → view cost dashboard → change Lint cadence to bi-weekly → forget a source with impact preview) and surfaced wiring + UX gaps that the per-R-PR before/after pairs had missed: the R7 forget endpoint returned 503 against production composition; the `/Cost` dashboard recorded OpenRouter calls as $0.00; the SSE reconnect loop kept thrashing on durably-stale PATs; the partner-facing pilot-runbook had no coverage of wave-10 operations or post-`git pull` upgrade procedures; and two wave-10 modals overflowed the viewport at 1235×702. The post-W6 re-walkthrough on `19c277a` then surfaced the SPA caller bug closed by W7. Wave 11 is closeout-pattern (no scoping doc on disk; planning agent-driven) — none of these PRs add new product surface; all reduce the gap between "wave-10 ships" and "wave-10 actually works in pilot production."

### Fixed (W1, `782a0ff` / #92) — R7 production-composition wiring

The 2026-05-09 Chrome QA pass surfaced that `POST /api/admin/source-bindings/:id/forget` returned 503 `composition_incomplete` against the design-partner deployment ("Nie udało się załadować wpływu" on dialog open). R7 had wired the route's expectation of injected `deleteCap` + `forgetJobEnqueuer` and the unit-test fixtures supplied both, but `cli/src/provision/production-composition.ts` did not. PR-W1 hoists `InMemoryDeleteCap` construction to the composition root so the SAME instance the compiler workers reserve against also feeds the route's `peek/reserve` (single-process v0.1 shape per architecture §16); adds a shared `createForgetJobEnqueuer` (`packages/shared/src/forget/enqueue.ts`) that fans the planner output into per-page jobs on two new BullMQ queues (`wiki.recompile` + `wiki.delete`); and threads both through `cli/serve.ts` → `engine-self-operating.start({deleteCap, forgetJobEnqueuer})` → `productionServerFactory` → `registerAdminApi`. Engine-ingestion's worker context (`composeProductionWorkerContext`) reads the SAME `deleteCap` instance so compile-side reservations and route-side peek see one counter (no double-spend, no drift). `closeForgetQueues()` drains both new queues on SIGTERM. The CLI verb at `packages/cli/src/commands/forget.ts` is unchanged — it wrote `erasure_log` rows + disabled the binding (audit-only, no enqueue), so PR-W1 introduces minimal new queue slugs + the shared enqueuer factory rather than reusing CLI internals (the brief had pointed at CLI verb reuse; on inspection that path didn't enqueue). 5 new unit tests in `packages/shared/tests/forget-enqueue.test.ts` (queue/job/payload contract + sequential semantics + first-failure-bubbles + empty-plan + path-without-prefix defensive) + 3 composition tests in `packages/cli/tests/production-composition-r7-wiring.test.ts` (boot real `composeProductionFromEnv` against PGlite + stub Redis + spy queues; assert deleteCap identity-shared with `workerContext.wikiDeps.deleteCap`, enqueuer adds with right names + payloads, `closeForgetQueues` idempotent) + 2 orchestrator tests in `packages/cli/tests/serve-preflight-wiring.test.ts`. The new PGlite-backed composition tests pushed the per-package run time past the 25-min CI ceiling on the first three attempts; the toolchain timeout was bumped 25 → 35 min in `.github/workflows/` to accommodate the new lane. **The consumer worker that drains `wiki.recompile` + `wiki.delete` and actually deletes pages in Gitea is explicitly out-of-scope for W1** — v0.1 ships the producer side only; jobs sit on the BullMQ backlog (visible in Activity > Pipelines) until the consumer worker lands as a follow-up (task #65). **PRD §5 criterion 9 is now actually green (was effectively amber post-R7-merge until W1 landed).**

### Fixed (W2, `46251da` / #91) — cost-tracker pricing for every `MODEL_CATALOG` member

R5 (#88)'s `/Cost` dashboard was structurally working but recording every OpenRouter (kimi) call as `$0.00` because `packages/shared/src/cost-tracker/pricing.ts` was missing entries for 13 catalog models — including `moonshotai/kimi-k2.6`, the model the design-partner deployment pins for all three tiers. Every kimi call logged `cost-tracker.unknown_model` and fell to `FALLBACK_PRICING`, but the warning was not the user-visible regression — the dashboard under-reporting was. PR-W2 adds 13 missing pricing entries covering every catalog model previously without a price (the catalog has 19 non-ollama members across openai/anthropic/google/openrouter; 6 already had prices from earlier PRs): the Anthropic 4-series catalog ids (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-3-5-sonnet-20241022`), the missing Google entries (`gemini-2.0-flash-thinking`, `gemini-1.5-flash`), the missing OpenAI `o1`, and the six OpenRouter-prefixed models (`moonshotai/kimi-k2.6`, `anthropic/claude-sonnet-4`, `anthropic/claude-opus-4-7`, `openai/gpt-4o`, `google/gemini-2.0-flash`, `deepseek/deepseek-r1`). A new parameterized test in `tests/cost-tracker.test.ts` iterates `MODEL_CATALOG` and asserts `PRICING[model]` is defined for every non-ollama member — future catalog additions break the test until pricing is added in lockstep, mechanically preventing the same regression. No code-path changes (the `costFor` lookup function, the warning-emission code, and the `llm_usage` write shape are untouched); the data update intentionally changes the OBSERVABLE behavior for catalog models — `cost-tracker.unknown_model` warnings stop firing for them, and computed cost shifts from the `FALLBACK_PRICING` default to the real per-model rate. That observable shift IS the fix. Historical zero-cost rows in `llm_usage` are not backfilled (W2 only fixes forward). OpenRouter's posted prices change occasionally; v0.2 will replace the static OpenRouter block with a daily fetch from `https://openrouter.ai/api/v1/models` (cached, override-safe). Until that lands, `MODEL_CATALOG` additions require a paired `pricing.ts` update — enforced by the catalog-coverage test, not just convention.

### Fixed (W3, `4fec71d` / #94) — SSE 401 → terminal `auth_failed` event

Q1's Activity-feed SSE client (`packages/ui/src/lib/sse.ts`) reconnected on every error class — including 401s from a durably-stale PAT. The result: on a fresh login with an expired PAT, the feed thrashed reconnect attempts indefinitely while `verifyAdmin` repeatedly rejected the bearer token (a soft DoS path against the engine's own admin-auth surface). PR-W3 adds 401 detection in `connect()` that emits a synthetic `auth_failed` event via a new `dispatchAuthFailed()` helper, marks the client closed, and does NOT call `scheduleReconnect()`; 5xx + network paths preserve the exponential-backoff reconnect (transient). `Activity.tsx:FeedView` listens for the new event and renders an inline alert (border + title `--alert`, body `--ink-3`, button-style "Re-paste PAT" CTA) plus flips the status indicator to "AUTH EXPIRED"; the CTA invokes a new `onAuthFailed` prop. `App.tsx`'s `onSseAuthFailed` handler clears the PAT, drops the `authed` flag, and surfaces existing `auth.loginFailed` copy on PatEntryModal. New i18n keys `activity.feed.authExpired` + `activity.feed.authFailed.{title,body,action}` in en + pl. Two new SSE tests pin the new behavior (401 fires exactly ONE `auth_failed` event, makes one fetch attempt, transitions to closed, stays terminal across a 60s clock advance) + a regression guard (503 still backoff-reconnects). Two new Activity-feed tests cover the alert render + the CTA invocation. **Closes pending task #47** from appendix #9.

### Changed (W4, `ec18a49` / #93) — pilot-runbook covers wave-10 day-2 operations + upgrade procedures

Pure docs PR (single file `docs/pilot-runbook.md`, +118/-10). The partner-facing runbook now mirrors the running management UI surface for wave-10. New §7 "Day-2 operations (wave-10 features)" with subsections 7.1–7.7 covering R1 (domain edit) · R2 (binding edit + credential rotation) · R3 (Run-now buttons) · R4 (`/Audit` viewer) · R5 (`/Cost` dashboard, with the W2 OpenRouter pricing context inlined) · R6 (scheduler editor) · R7 (forget impact preview, with the W1 + task-#65 consumer-worker context inlined). Each subsection cross-links back to its `CHANGES-v0.1.md` Appendix #10 entry. Renumbered §7→§8 (invariants), §8→§9 (deferrals), §9→§10 (sign-off) with five internal cross-references updated to stay self-consistent. The appendix #4 deferral note "Scheduler UI in the management console defers to phase-b" is now marked closed by R6. New §11 "Upgrade procedures" with two REQUIRED post-`git pull` blockquoted callouts: 11.1 `opencoo migrate` (with the R1 / Domains-tab-500 failure mode for context) and 11.2 `pnpm build` + restart (with the Chrome QA 2026-05-09 stale-asset symptom). New §12 "Residual advisories" enumerating the three known wave-10 / wave-11 follow-ups: forget consumer worker pending (task #65), OpenRouter cost-tracker pricing (W2 closes), nightly live-pilot CI requires `OPENROUTER_API_KEY` repo secret (task #58). §10 sign-off checklist gained one new bullet covering non-destructive exercise of each R1–R7 surface before sign-off.

### Fixed (W5, `22ef818` / #95) — modal sheet caps to viewport + sticky-bottom action row

The 2026-05-09 Chrome QA pass at 1235×702 caught two wave-10 modals — `SourceBindingDetail` edit mode (~700px tall: config section + credentials section) and `DomainDetail` edit mode — pushing the bottom action row (Cancel / Save / Disable / Delete) below the fold. The operator could not see Save without resizing the window, which broke the edit-flow muscle memory established earlier in the QA pass. PR-W5 fixes the shell, not the consumers' content: `packages/ui/src/components/Modal.tsx` now (1) caps sheet height at `calc(100vh - 64px)` so the dialog never overflows the viewport (32px breathing room top + bottom, matching the existing backdrop padding cue), (2) wraps `props.children` in a scroll region (`flex: 1 1 auto; min-height: 0; overflow-y: auto` — the load-bearing `min-height: 0` is what lets a flex child shrink below its content's intrinsic height), and (3) accepts a new optional `actions` prop that renders sticky-bottom inside the sheet with `var(--paper)` background and `1px solid var(--rule)` top border. The depth cue is the rule line + paper mask, NOT a drop shadow (CLAUDE.md design-system hard-no). The wave-10 single-step modals (`DomainDetail` edit / disable / delete confirms, `SourceBindingDetail` read-only / edit / disable / enable / delete confirms, `ImpactPreviewDialog`, `NewDomainModal`) migrate to the new `actions` prop and lose their inline footer divs. The wizard-style `NewSourceBindingModal` keeps its stepwise inline footers — its action rows live inside child step components, the picker step did not appear in the QA finding, and the new scrollable body alone resolves the viewport-overflow risk for it. New unit tests in `packages/ui/tests/unit/modal.test.tsx` pin the `calc(100vh - 64px)` cap, the body's `overflow-y: auto / flex: 1 1 auto / min-height: 0` triple, the sticky-bottom action row's `position / bottom / background / border-top` set, the no-shadow invariant, and a parameterized "700px body fits at 1024×600 / 1235×702 / 1920×1080" matrix. Existing wave-10 modal-consumer test suites (DomainDetail, SourceBindingDetail, ImpactPreviewDialog, NewDomainModal, NewSourceBindingModal) all stay green without modification — the migration preserves text, callbacks, and DOM order; only the sheet's flex topology changed.

### Fixed (W6, `19c277a` / #97) — forget consumer worker drains `wiki.recompile` + `wiki.delete`

W1 wired the producer side (route + two BullMQ queues + cap-shared composition) but explicitly left the consumer worker out-of-scope; jobs accumulated in Redis with no dequeue path. PR-W6 adds the engine-ingestion-side worker that drains both queues so the forget operation is end-to-end functional. New `packages/engine-ingestion/src/workers/forget-consumer.ts` exports `buildForgetRecompileHandler` + `buildForgetDeleteHandler` (pure, test-friendly) and `startForgetConsumerWorkers` (BullMQ wiring, multi-dot slugs `wiki.recompile` + `wiki.delete` constructed via `new Worker(...)` directly per the convention `compile-worker.ts` uses). The recompile handler reads existing `page_citations` for `(domainSlug, pagePath)`, partitions forgotten vs remaining, no-ops with a warn when zero remaining (companion delete job handles the page) or when the page has no recorded citations at all (race between forget-plan and consume), DELETEs the forgotten binding's citation rows when remaining citations exist, and invokes the injected `recompilePage` hook with the surviving citations as input — v0.1 production wires `defaultRecompilePageStub` (audit-only, mirrors `recompile.ts` CLI's audit-only shape; v0.2 swaps in a real Thinker recompile that re-derives the page body from refetched remaining sources). The delete handler defensively probes `readPage` so a page already gone (concurrent forget, manual delete, retry crash) still prunes orphan citation rows + warns rather than throwing a confusing wiki transport error, prunes `page_citations` for the page (cascade hygiene the planner doesn't itself perform), then issues a single `wikiWrite` with `mode: 'delete'` op + `caller: { kind: 'admin', userId: callerUsername }` so the route's pre-enqueue cap reservation isn't double-counted (W1 enqueue.ts's admin-bypass contract). `startIngestionWorkers` returns the two new workers in its handle and includes them in `closeAll()` + the SSE bridge, so they share the same lifecycle as the original five workers. Two new test files (`forget-consumer-recompile.test.ts` + `forget-consumer-delete.test.ts`, 9 cases total) pin every branch: drop-and-recompile happy path with 3-citation fixture (1 forgotten + 2 remaining), zero-remaining-citations no-op, missing-citations no-op + warn, hook-failure re-throws for BullMQ retry, cross-page isolation regression guard, delete happy-path with cap budget unchanged, wikiWrite failure re-throws, page-already-gone defensive branch, and only-named-page deletion isolation. The existing `workers.test.ts` `startIngestionWorkers` cases extended to cover all 7 workers (5 original + 2 forget consumers) including the `closeAll` close-spy assertion. **Closes follow-up task #65. PRD §5 criterion 9 (forget operation) is now actually functional end-to-end** — the route enqueues (W1), the workers drain (W6), and `wikiWrite` actually deletes from Gitea. The shared `DeleteCap` instance prevents double-spend across compile workers and forget consumers; no new admin-API surface, no new audit row from the worker (the route's `source_binding.forget` row already carried the COUNTS).

### Fixed (W7, `3f7c093` / #98) — `fetchAdmin` only sets `content-type` when body is provided

The wave-end Chrome QA re-walkthrough on `19c277a` (post-W6) showed the R7 forget dialog STILL displaying "Nie udało się załadować wpływu" despite W1 + W6 landing correctly. A direct API probe with proper auth returned 200 with valid impact JSON, isolating the regression to the SPA caller. Root cause: `packages/ui/src/lib/api.ts:fetchAdminInternal` unconditionally set `content-type: application/json` on every request, including body-less POSTs. Fastify's JSON parser then rejected the empty body with `FST_ERR_CTP_EMPTY_JSON_BODY` (HTTP 400) — surfaced in the UI's error mapping as the loadFailed copy. Both `?dryRun=1` (impact preview) and `?dryRun=0` (confirm) hit it, so the dialog was unusable end-to-end for the operator. PR-W7 gates content-type header injection AND `JSON.stringify(body)` body encoding on `opts.body !== undefined`; auth + CSRF headers and the 403/csrf_invalid retry path are unchanged. New regression test in `packages/ui/tests/unit/api.test.ts` ("does NOT set content-type or body when caller omits body (PR-W7)") asserts the body-less POST sends neither content-type nor a request body, while still attaching Bearer + CSRF; the existing "attaches Bearer + CSRF headers on POST" case was tightened to additionally assert content-type IS set when a body is provided (so the conditional is pinned in both directions). Bonus: the same path silently broke `/api/admin/logout` POST in `App.tsx:logout` (best-effort try/catch swallowed the 400); W7 also fixes that. Post-W7 Chrome QA re-verification (engine restarted on the fresh build): dialog now shows real impact (`Wpływ: 0 stron przekompiluje, 0 stron usunie się całkowicie, 0 cytowań usuniętych`) + real cap state (`Dzienny limit usunięć: 0/10 wykorzystane dziś`) + acknowledgement checkbox + Confirm button, all wired correctly. Spot-check on R5 cost dashboard against the same engine: live spend $0.10 / projected month-end $0.30 / Thinker $0.06 / Worker $0.04 (W2 verified — pre-W2 this would have been $0.00 across the board). **PRD §5 criterion 9 (forget operation) is now actually green end-to-end against the running engine — was effectively amber post-W6 until W7 landed.**

### Schema

- No new migrations. (W1's two new BullMQ queues are Redis-side, not Postgres; W2 is a data update to a TS constants file; W3, W4, W5 are UI/docs; W6 reuses the W1 queues + the existing `page_citations` table — schema's APPEND-ONLY-modulo-DELETE comment already permits the erasure-path DELETEs the recompile/delete handlers issue; W7 is a UI-side header gating change with no DB touch.)

### Configuration

- No new env vars. (W1's queue slugs `wiki.recompile` + `wiki.delete` open against the existing `REDIS_URL`; no new credentials touched. W6 only wires the consumer side onto those same queues. W7 changes only the SPA's HTTP header logic.)

### Threat-model alignment (§5 PR checklist)

- **Zero new admin-API write surfaces.** W1 is composition wiring only — the route already existed under R7 and was already CSRF + admin-auth gated; W1 supplies its dependencies. W2 is a read-only data table addition (`pricing.ts`). W3 is read-only SSE plus client-side terminal state. W4 is pure docs. W5 is pure UI shell. W6 is engine-ingestion-side only (BullMQ consumer worker; no new HTTP route, no new admin-API surface). W7 is a SPA-side header-injection conditional change — request shape only, no new endpoint or surface. So the new write-surface count for §5 review is effectively zero across the wave.
- **W1 invariants.** DeleteCap shared instance — same `InMemoryDeleteCap` the compile workers reserve against feeds the route's `peek/reserve` (no double-spend). Audit-COUNTS-only invariant from R7 unchanged — `forgetJobEnqueuer` doesn't write to `admin_audit_log` itself. No plaintext credentials touch any new payload.
- **W3 closes a soft-DoS path** — stale PAT no longer pings `verifyAdmin` repeatedly via reconnect handshakes. Terminal flag is per-session; a fresh PAT re-opens the SSE client.
- **W6 invariants.** No second audit row — the route already wrote `source_binding.forget` with COUNTS at enqueue time; the worker emits per-job logger entries only (the SSE bridge surfaces them in the Activity feed). DeleteCap NOT double-reserved — the worker passes `caller: { kind: 'admin', userId: callerUsername }` to wikiWrite so the cap-bypass path fires (W1 enqueue.ts admin-bypass contract). Job payload is COUNTS + IDs + paths only (per W1 enqueuer); no plaintext source content travels through Redis. Failure to consume = job retries via BullMQ defaults; no data loss. APPEND-ONLY invariant for `page_citations` (THREAT-MODEL §2 invariant 8) is preserved — the schema explicitly carves out DELETEs for the erasure path ("Source forgetting happens via DELETE (retention/erasure), not UPDATE"); the worker's two DELETEs sit on that exception, and there is no UPDATE path.

### Residual advisories (non-blocking, tracked for follow-up)

- **Forget consumer worker pending** (task #65) — ~~W1 wires the producer side (route + `wiki.recompile` / `wiki.delete` queues + cap-shared composition) but no worker drains those queues yet. Forget operations enqueue successfully (audit row written, cap reserved) but the actual page deletion in Gitea waits for the consumer worker. Workaround: monitor queue depth in Activity > Pipelines; do not Confirm a forget if the immediate Gitea-page disappearance is required. Tracked as a follow-up appendix.~~ **Closed by W6** — the consumer workers drain both queues; the delete handler issues a real `wikiWrite` against Gitea + prunes orphan citation rows; the recompile handler drops the forgotten binding's citations + invokes the v0.1 audit-only stub (v0.2 swaps the stub for a real Thinker recompile from remaining citations).
- **`OPENROUTER_API_KEY` repo secret** (task #58) — the appendix-#9 nightly live-pilot workflow requires this secret to be set in repo settings for the lane to flip green. Out-of-band user action; verification step before tag.
- ~~**Chrome QA wave-end re-walkthrough** — wave-11 surfaced via the wave-10 closeout walkthrough; the post-W1 re-walkthrough against the wired forget path (dry-run + execute round-trip end-to-end) is still pending before tag.~~ **Completed 2026-05-10** — the walkthrough started against post-W6 build (`19c277a`) and surfaced one further regression closed by **PR-W7** (`3f7c093` / #98); the engine was rebuilt + restarted on the post-W7 build and the re-verification step confirmed R7 dialog renders real impact + cap state, R5 cost dashboard reports real (non-zero) spend, and the integrated wave-10 flow still passes end-to-end. Activity-feed SSE 401 (W3) and modal sticky-bottom (W5) verified incidentally during the same walkthrough.

## Phase-a follow-up — X1 (auto-migrate on boot)

One PR landed AFTER the wave-11 closeout to close the operator-pain finding the post-W7 Chrome QA walkthrough surfaced incidentally: missed-manual-`opencoo migrate` had broken the Domains tab mid-walkthrough on a fresh clone, because the v0.1 design (PR 30 / plan #135 decision Q4) deferred boot-time auto-migrate to v0.2 and left the operator responsible for running `opencoo migrate` after every `git pull` BEFORE starting the engine. The pilot-runbook §11.1 documented this as a REQUIRED post-pull step, but the failure mode (HTTP 500 on routes that reference new columns) was easy to skip past during demo-day momentum. PR-X1 lifts the deferral so the engine refuses to bind the listener until pending migrations have applied — the manual step becomes optional, the failure mode disappears in the default flow, and operators who prefer the legacy manual flow can opt back into it via `OPENCOO_AUTO_MIGRATE=0`. None of this blocks the `0.1.0-a` tag (already cut); it tightens the "make it run on its own" surface area the pilot real-data smoke depends on.

### Fixed (X1) — engine-self-operating auto-applies pending Drizzle migrations at boot

The pre-X1 boot path constructed a `pg.Pool`, loaded admin-API env, composed the dispatcher, registered Fastify routes, and bound the listener — none of those steps touched the migration journal, so a `git pull` that landed a new migration would let the engine boot to a STATE-INCONSISTENT routing tree (admin-API routes referencing newly-added columns 500'd on first request). PR-X1 adds a single shared helper (`packages/shared/src/db/auto-migrate.ts`) that BOTH the CLI verb (`opencoo migrate`) AND the engine boot path call before any DB-reading code runs. The helper acquires a process-wide `pg_advisory_xact_lock` keyed on `hashtext('opencoo.auto_migrate')::bigint` (deterministic across callers — every engine, every CLI verb, every operator one-shot picks the same bigint key without a hand-picked magic number to drift), opens a transaction, runs drizzle's migrator, COMMITs (which auto-releases the lock), and emits one `migrate.applied` log line on success or `migrate.failed` + re-throw on failure. ROLLBACK on any inner-throw also releases the lock — the failure surface is "transient SQL error" not "stuck advisory lock". Drizzle's existing `__drizzle_migrations` journal makes the helper idempotent: a second engine starting immediately after the first sees zero pending migrations and the run is a fast no-op. The CLI verb at `packages/cli/src/commands/migrate.ts` was refactored to call the same helper instead of an inline `drizzleMigrate` — operators who run `opencoo migrate` while an engine is also booting now serialise safely (one waits at the lock; the other is a no-op once the journal catches up), which the pre-X1 inline call did not. The engine entry point at `packages/engine-self-operating/src/start.ts:355` now calls `applyMigrationsWithLock(...)` BEFORE `tryLoadAdminApiEnv` and BEFORE the `AgentDispatcher` composition; migrate-failure throws → `start()` throws → the engine-scaffold's resource-safety teardown drains pg.Pool / Redis before the supervisor restarts the process. The `StartOptions.skipMigrate` field — pre-X1 a v0.1 NO-OP forward-compat flag (PR 30 / plan #135 decision Q4) — became load-bearing: it's the documented test seam (existing `start.test.ts` cases that inject custom `dbFactory` already opt out via the third `shouldSkipAutoMigrate` gate; new tests that inject a real-shaped pool set `skipMigrate: true` explicitly) and it's the scripted-deploy override hook for orchestrators that want to run migrations through a separate verb.

### Configuration

- **One new operational opt-out env var: `OPENCOO_AUTO_MIGRATE`.** Default = unset / "1": the engine auto-applies pending migrations under the advisory lock before binding the Fastify listener. Setting "0" / "false" / "no" (case-insensitive, leading/trailing whitespace tolerated) reverts to the legacy manual `opencoo migrate` flow. Operators using the legacy flow MUST run `opencoo migrate` after every `git pull` BEFORE starting the engine — the pre-X1 §11.1 invariant. This is operational config, NOT feature config — it doesn't change any product-visible behavior, just whether a migration window is gated by the engine itself or by the operator. Allow-listed in `tools/eslint-plugin-opencoo/src/rules/no-feature-env-vars.ts` and documented in `.env.example`. No `_FILE` Docker-secrets variant — it's a public boolean flag, not a credential. CLAUDE.md "UI-first configuration" rule honored: feature config (LLM policies, schedules, source bindings) still lives in Postgres + UI; this knob is purely operational.

### Schema

- No new migrations. PR-X1 changes WHEN existing migrations apply, not WHAT they do.

### Documentation

- **`docs/pilot-runbook.md` §11** reframed from "Two steps are REQUIRED after every pull of upstream changes — neither is automated in v0.1" to "One step is required... the schema-migration step is now automated by default at engine boot". §11.1 reframed from REQUIRED-blockquote to "Optional. The engine auto-applies migrations at boot. If you set `OPENCOO_AUTO_MIGRATE=0` in `.env` to keep the legacy manual flow, this step is REQUIRED — otherwise it's a safe no-op." The R1 / Domains-tab-500 failure-mode bullet stays load-bearing for operators on the legacy flow. The advisory-lock + idempotency invariants are documented inline so a partner reading the runbook understands why the auto-migrate path is safe to leave on by default.
- **`docs/pilot-runbook.md` §12** gains a fourth bullet ("Migration auto-apply on boot — closed by PR-X1; manual `opencoo migrate` is now optional"); no strikethrough was needed because the §12 list as of 0.1.0-a phase-a appendix #11 did not previously mark migration auto-apply as deferred.

### Tests

- **`packages/shared/tests/db/auto-migrate.test.ts`** — new helper unit tests (5 cases). PGlite-backed pool-shim + a journal-walking PGlite-flavoured migrator (mirroring the pattern in `tests/migrations/migrate-applies-clean.test.ts` because PGlite's prepared-statement path rejects the multi-command chunks `0005_domains_is_aggregator.sql` packs). Covers happy-path SQL sequence (BEGIN / `pg_advisory_xact_lock` / COMMIT, no ROLLBACK), idempotency on a second pass against the same DB (drizzle journal makes pending = 0), and failure propagation (forced-failing migrator throws through the helper, ROLLBACK runs, a subsequent successful invocation against the same pool proceeds normally). The lock-key SQL is pinned at `hashtext('opencoo.auto_migrate')::bigint` to guard against a silent rename that would pick a different bigint key. True concurrent-blocking semantics need a real Postgres process (PGlite's WASM single-process backend reduces `pg_advisory_xact_lock` to a no-op); the test file leaves a TODO for a nightly-live-pilot real-Postgres concurrency case.
- **`packages/engine-self-operating/tests/start-auto-migrate.test.ts`** — new boot-ordering tests (11 cases). `vi.mock`s `@opencoo/shared/db` so the test can spy + control the helper without standing up real Postgres, and stubs the `pg.Pool` constructor so the engine constructs a non-null pool reference (which engages the migrate path) without actually connecting. Covers: default boot (migrate before listen, asserted via shared timeline), `OPENCOO_AUTO_MIGRATE=0` skips (with case + whitespace variants — "false" / "no" / "FALSE" / "No" / " 0 "), `OPENCOO_AUTO_MIGRATE=1` still migrates (default-on round-trip), `options.skipMigrate=true` skips (test-seam path), migrate-failure prevents listen (start() rejects, no `app.listen` invocation), and the stub-pool-only path (caller injects `dbFactory` → `pgPool === null` → migrate not attempted, regardless of env / flag).
- **Existing tests pass unchanged.** `packages/engine-self-operating/tests/start.test.ts` already injects `dbFactory: () => stubPool` in every case, so the third `shouldSkipAutoMigrate` gate fires — none of the pre-PR-X1 cases hit the new migrate path. No edits required to existing test suites.

### Threat-model alignment (§5 PR checklist)

- **Zero new admin-API write surfaces.** PR-X1 adds a helper that takes a `pg.Pool` and runs migrations; nothing in the request-handling path is altered. The engine still rejects unauth'd admin-API calls, still gates on `ADMIN_TEAM_SLUG` membership via `verifyAdmin`, still requires the CSRF round-trip on POSTs.
- **Advisory-lock key is deadlock-safe.** `pg_advisory_xact_lock(bigint)` is transaction-scoped — COMMIT / ROLLBACK auto-releases. There is no leaked-lock failure mode if a connection dies mid-migrate (Postgres releases the lock on backend disconnect). The key is derived in-database from a single natural-language label so different subsystems wanting their own lock pick a different input string; the keyspace is the natural-language label, not a hand-picked magic number.
- **Append-only invariant preserved.** PR-X1 changes WHEN drizzle migrations apply, not WHAT migrations exist. The migrations themselves are unchanged. THREAT-MODEL §2 invariant 8 (append-only logs / page citations / event log) is unaffected — none of those tables receive UPDATE or DELETE traffic from the migrate path.
- **No prompts / responses logged.** The helper logs a `migrate.applied` line with `folder` + `durationMs` on success and a `migrate.failed` line with the underlying error MESSAGE only on failure — routed through `safeErrorMessage` per THREAT-MODEL §3.6 invariant 11 (pg / SASL errors can carry connection-string fragments, auth tokens, or SCRAM material; scrub-then-cap at 200 chars matches the convention `start.ts` round-3 fix #4 already established for engine teardown / dispatcher logs). THREAT-MODEL §2 invariant 11 (prompts/responses go through `llm_usage_debug`, never `logger.info`) is unaffected — the migrate path never invokes an LLM.
- **No new credentials touched.** The helper reads `DATABASE_URL` (already allow-listed), no new secret-handling code paths.
- **No env-var sprawl.** One opt-out flag (`OPENCOO_AUTO_MIGRATE`), allow-listed with a §5-checklist-aligned comment in the rule file. Default-on means partners who never read the runbook still get the safe behavior.

---

## Phase-a follow-up — X2 (GHCR docker image distribution)

A second post-`0.1.0-a` PR pulls the `0.1.0` release-gate item ("Docker images pushed to GHCR + Docker Hub with GPG-signed release tags" — `IMPLEMENTATION-PLAN.md` §3.3) forward to phase-a so the design partner's first cutover pulls a tagged image rather than building from a `git clone`. The `pilot-runbook.md` §2 partner-bootstrap path before X2 was `pnpm install && pnpm build && pnpm opencoo` from a checked-out tree — fine for contributor workflows, wrong for the partner's first production touch. Shipping source first then switching mid-soak doubles the failure surface during the period the partner needs to trust the platform most. PR-X2 closes that gap with two GHCR-published images (engine + gitea-wiki-mcp-server), a buildx-ready release workflow, a hardened partner compose template, and the matching runbook rewrite. Image signing (cosign / GPG) and SBOM publication remain deferred to PR-X4 (renumbered from a previously-planned PR-X3 slot when X3 was reassigned to CI parallelization), tracked below as a `0.1.0`-final gate item; multi-arch arm64 stays a v0.2 goal. Single-arch (`linux/amd64`) only for now.

### Added (X2) — engine + gitea-wiki-mcp-server images on ghcr.io/czlonkowski

- **`Dockerfile` at the repo root** — three-stage build (build → runtime; the deps "stage" collapses into the build stage with a `--mount=type=cache` on pnpm's content-addressable store rather than a separate workspace-skeleton COPY pattern, documented inline; the marginal cache-hit benefit of the skeleton-split is dominated by the GHA `cache-from/-to` BuildKit layer cache the workflow wires). Base: `node:22-slim` (matches the workspace's `engines.node: ">=22"`). Build stage runs `pnpm install --frozen-lockfile` → `pnpm --filter @opencoo/eslint-plugin build` → `pnpm build` → `pnpm --filter @opencoo/cli deploy --prod /tmp/deploy`. The `pnpm deploy` strategy resolves the entire transitive workspace closure of @opencoo/cli (engines + every adapter + shared) into a self-contained bundle with hardlinked node_modules; this works because the CLI's package.json declares every adapter as a `workspace:*` dep so dynamic imports at runtime resolve cleanly. Runtime stage layers on `wget` (HEALTHCHECK probe) + `dumb-init` (PID-1 zombie reaper for BullMQ worker forks), creates a non-root `opencoo` user with fixed UID/GID 10001, and copies just the deploy bundle + the Drizzle migration SQLs (`packages/shared/drizzle/`) + the bundled UI dist (`packages/engine-self-operating/dist/ui/`) — no source trees, no devDependencies, no pnpm CLI, no tsc. `ENV NODE_ENV=production PORT=8080 UI_DIST_PATH=/app/packages/engine-self-operating/dist/ui` make path resolution layout-independent. Healthcheck against the shared engine-scaffold `/health` endpoint (always-200 per `packages/shared/src/engine-scaffold/server.ts:51`); the deeper `/ready` probe is for orchestrator readiness gates, not Docker's HEALTHCHECK. `--start-period=15s` accommodates the auto-migrate-on-boot step (PR-X1) on a fresh Postgres. ENTRYPOINT is `dumb-init --` and CMD invokes `node dist/bin.js` (pnpm-deploy lays the CLI's own package out at WORKDIR root with workspace deps hosted under `node_modules/@opencoo/`, so the CLI bin sits at `/app/dist/bin.js` directly — NOT under `node_modules/@opencoo/cli/`).
- **`.dockerignore` at the repo root** — exclusion-list approach; blocks `.git`, `.github`, `.claude`, `.husky`, every `node_modules` and `dist` and `tests` and `__fixtures__`, every test config, the local-dev compose files, every dotfile-env, the entire `docs/local/` partner-private tree, every internal planning doc (`architecture.md`, `DECISIONS.md`, `THREAT-MODEL.md`, `PRD.md`, `IMPLEMENTATION-PLAN.md`, `CHANGES-v0.1.md`, `CONVENTIONS.md`, `CLAUDE.md`, the design system, the diagrams), and the `deploy/` tree itself (the partner compose isn't part of the engine image). Belt-and-braces against `.gitignore`: `architecture.md` is gitignored from the public repo but still on the maintainer's disk, so it's listed here explicitly to prevent the build context from tar-streaming partner-confidential design docs into the image. `.env.example` is permitted via a `!.env.example` re-include for the runtime-image's `--help` references.
- **`packages/gitea-wiki-mcp-server/Dockerfile` — skill-guided pass.** The package was already containerized; the X2 pass split the original two-stage build into three stages (deps → build → runtime), upgraded the base from `node:20-alpine` → `node:22-alpine` (matches the engine image's Node 22 floor; the package's own `engines.node: ">=18"` accepts this), added `--mount=type=cache,target=/root/.npm` for the install layer, bumped the non-root UID from `adduser -S` random to a fixed UID 10002 (engine uses 10001 — distinct UIDs prevent bind-mount permission collisions when the operator stacks both containers against the same volume layout), and tightened the HEALTHCHECK to a 10s timeout (was 5s). The original two-stage build's correctness was already there; the pass is layer-cache hardening + UID stability. **Lockfile note**: the original Dockerfile referenced `package-lock.json` but that file was removed when the package was integrated into the opencoo pnpm workspace at the repo root (commit `c436d56`). The X2 Dockerfile materialises a lockfile in-build via `npm install --package-lock-only --no-audit --no-fund` against the package.json's caret/tilde ranges, then enforces it for the actual install via `npm ci --no-audit --no-fund`. This makes a single `docker build` invocation internally deterministic (the `npm ci` step refuses to mutate the lockfile, so any drift between the two commands fails closed). Cross-build reproducibility for a given tag is still imperfect — a 6-month-old tagged image rebuilt today materialises today's resolution of those caret/tilde ranges, which may differ from the originally-tagged one. Flagged as a v0.2 follow-up: either commit a per-package lockfile (the cleanest fix) or shift the build context to the repo root and use pnpm with the workspace-pinned lockfile.
- **`.github/workflows/release-image.yml`** — buildx-ready CI that publishes both images to GHCR. Triggers: tags `v*` + `0.1.0-*` (production), push to `main` (edge), `workflow_dispatch` (manual re-run). Two parallel jobs (`engine-image` + `mcp-server-image`); each requests `permissions: { contents: read, packages: write }` at job level (no PR has more permission than it needs). `concurrency.group: release-image-${{ github.ref }}` with `cancel-in-progress: false` (a failed run is easier to diagnose with all in-flight runs preserved than with the noise of partially-overwritten cache entries). `docker/setup-buildx-action@v3` makes adding `linux/arm64` to the `platforms` input a one-line v0.2 change. `docker/login-action@v3` uses the built-in `GITHUB_TOKEN` (no PAT to rotate). `docker/metadata-action@v5` computes the tag set per trigger: `:edge` only on the default branch, `:latest` only on `v*` tags (suppressed on `0.1.0-*` rollups so a phase-a tag never claims `:latest` over a final release), `:0.1.0-a.N` on phase-rollup tags, full semver matrix on `v*` tags. `docker/build-push-action@v6` with `cache-from: type=gha,scope=engine` + `cache-to: type=gha,mode=max,scope=engine` (separate scopes for the two images so one image's cache miss doesn't evict the other). Each job ends with `docker buildx imagetools inspect <first-tag>` as a smoke step — confirms the manifest landed cleanly. Independent of the existing `release.yml` (the phase-a e2e ship-gate); the two run on the same triggers but their failure modes are unrelated.
- **`deploy/compose.partner.yml`** — partner deployment template that pulls both images from `ghcr.io/czlonkowski`. Co-manages Postgres + Redis (volumes `postgres_data` + `redis_data` + `mcp_data` for the MCP clone cache); Gitea is partner-owned per `pilot-runbook.md` §1 ("substrate-is-yours" rule). Override `OPENCOO_TAG` in `.env` to pin a specific release. Two Docker networks: `frontend` (engine + mcp-server reachable; bridge driver, no special flags) and `backend` (`internal: true` — Postgres + Redis cannot reach the public internet; the engine + mcp-server are on BOTH networks so their outbound Gitea/LLM calls take the `frontend` route while their cross-service chatter stays on `backend`). The `internal: true` flag on `backend` is the load-bearing security boundary — without it, a misconfigured Postgres or Redis would have unfettered outbound. Healthchecks on every service (Postgres `pg_isready`, Redis `redis-cli ping`, MCP server `wget /health`, engine inherits the Dockerfile HEALTHCHECK). `deploy.resources.limits` on every service (engine 1 CPU / 1 GB; mcp-server 0.5 CPU / 256 MB; postgres 1 CPU / 512 MB; redis 0.5 CPU / 256 MB) — CI deploys without limits would let a runaway compile consume the whole partner host. `depends_on.<svc>.condition: service_healthy` chains so the engine waits for Postgres + Redis to actually be ready, not just running. Postgres + Redis pinned by tag (`postgres:16-alpine` + `redis:7-alpine`) with a documented procedure for upgrading to digest-pinned references in steady-state production. Engine + MCP-server tags are operator-controlled via `OPENCOO_TAG`, so digest-pinning them is unnecessary (the tag itself is specific enough).
- **`deploy/.env.example`** — partner-facing knob set documenting every var the compose template references. Covers image distribution (`OPENCOO_TAG`, `OPENCOO_PORT`), Postgres bootstrap (`POSTGRES_PASSWORD`), Gitea wiring (`GITEA_URL`, `GITEA_PAT`, `GITEA_BASE_URL`, `GITEA_PROVISION_ORG`), admin-API session (`ENCRYPTION_KEY`, `ADMIN_TEAM_SLUG`, `SESSION_HMAC_KEY`), MCP wiring (`MCP_BEARER_TOKEN`), optional provider keys, and operational knobs (`LOG_LEVEL`, `OPENCOO_AUTO_MIGRATE`). Each variable gets a one-line comment explaining purpose + how to generate it. Repo-root `.env.example` stays the canonical knob set for from-source contributor deployments; the two overlap deliberately (same env-var allow-list per THREAT-MODEL §2 invariant 9, enforced by the `no-feature-env-vars` ESLint rule).

### Configuration

- **No new env vars.** Image-distribution config is operator-controlled via `OPENCOO_TAG` + `OPENCOO_PORT` in the partner compose template's interpolation; neither is read by the engine itself. The engine's env-var allow-list (`tools/eslint-plugin-opencoo/src/rules/no-feature-env-vars.ts`) is unchanged. CLAUDE.md "UI-first configuration" rule honored.
- **No new credentials.** The release workflow uses GitHub's built-in `GITHUB_TOKEN` for the GHCR push; no maintainer PAT to provision. Image signing in PR-X4 will require a cosign keypair + repo secret; that gate is documented below.

### Schema

- No new migrations. PR-X2 is image distribution + compose template only; no engine code paths change.

### Documentation

- **`docs/pilot-runbook.md` §2** rewritten as the GHCR-pull bootstrap (`docker compose -f compose.partner.yml pull` → `up -d` → `logs -f`); the legacy `pnpm install && pnpm build && pnpm opencoo` flow moved to NEW §2.5 ("Bootstrap from source — contributors only") with an explicit non-recommendation for partner deployments. The bootstrap-admin verbs (`opencoo setup`, `agents seed`, `doctor`, `agents fire`) under the docker flow run via `docker compose run --rm opencoo <verb>`; runbook documents the pattern. Healthcheck endpoint name corrected to `/health` (the shared engine-scaffold endpoint per `packages/shared/src/engine-scaffold/server.ts:51`); `/ready` is the deeper readiness probe and stays out of Docker's HEALTHCHECK by design.
- **`docs/pilot-runbook.md` §11.2** reframed for image-pull upgrades: a partner upgrade is `docker compose pull && up -d`, not `pnpm build && restart`. The UI dist is baked into the engine image, so the SPA-asset-hash skew the previous §11.2 documented is impossible by construction — a tag bump is atomic. The legacy `pnpm build` + restart flow moved to NEW §11.2.5 ("UI bundle rebuild — contributors only").
- **No `architecture.md` impact.** Image distribution is a delivery mechanism, not a product surface. The architecture doc continues to specify per-client docker-compose deployment; X2 just replaces "build from source then `up`" with "pull tagged image then `up`".

### Tests

- No new TypeScript tests. PR-X2 ships infrastructure (Dockerfile + compose template + GHA workflow + runbook prose); the validation surface is the build-and-run smoke documented in the PR description. The existing `pnpm test` / `pnpm typecheck` / `pnpm lint` suites must stay green — none of the X2 files are TypeScript so this is a no-op verification.
- The release-image workflow itself is the test surface: a `workflow_dispatch` against any commit builds + pushes both images, and the `docker buildx imagetools inspect` smoke step at the end of each job confirms the manifest landed cleanly. The first real-world test is the next phase-rollup tag cut (`0.1.0-a.N+1`) — the workflow runs in parallel with `release.yml` (the e2e ship-gate); a failure of one does not block the other.

### Threat-model alignment (§5 PR checklist)

- **Zero new admin-API write surfaces.** PR-X2 ships container-distribution infrastructure; the engine's HTTP routing is unchanged. The image-build pipeline runs in CI under the same GitHub Actions sandbox the rest of the workflows use; no new permissions are granted (`permissions: { contents: read, packages: write }` at job level — least-privilege over the workflow's `secrets.GITHUB_TOKEN`).
- **Non-root UID hardening.** Both images run as a fixed UID (engine 10001 / mcp-server 10002). Even if the engine process were compromised, the non-root user has no shell (`/usr/sbin/nologin`), no home directory write access outside `/home/opencoo`, and no capability to escalate. THREAT-MODEL §3.8 ("don't run as root") is honored by construction.
- **Backend network isolation.** `deploy/compose.partner.yml` puts Postgres + Redis on a `backend: { internal: true }` network. Even if a Postgres CVE allowed RCE, the resulting shell has no outbound — exfiltration would require pivoting through the engine container, which is the same threat surface the engine already has and the existing THREAT-MODEL coverage already addresses.
- **Healthcheck with full parameter set.** `interval=30s timeout=10s start-period=15s retries=3` on every service; an unhealthy container is a Docker-visible signal the operator's monitoring stack can wire alerts on.
- **No new secrets in the image.** Runtime config is env-from-`.env` at the host. The image bakes only `NODE_ENV=production`, `PORT=8080`, and `UI_DIST_PATH` — no PATs, no DSNs, no encryption keys. Layer-cache poisoning that could leak a secret is moot because no secret is ever in the build context (the `.dockerignore` blocks every `.env*`, every dotfile, every test fixture that might accidentally include credentials).
- **The `_FILE` Docker-secrets convention is honored at runtime.** `deploy/compose.partner.yml` wires plain-string env by default (the simplest path for the first partner cutover); the env-loader at `packages/shared/src/engine-scaffold/config.ts:53-67` recognises every URL/secret env var's `_FILE` variant unchanged. Partners moving to a secrets-manager-aware setup add a `secrets:` block + switch each var to its `_FILE` form without any engine code change. Documented in `deploy/.env.example` header.
- **CI surface is the same CI surface that already builds + tests + e2e's the engine.** The release-image workflow runs on the same `ubuntu-latest` runners under the same `czlonkowski/opencoo` repo permission model as `release.yml` and `ci.yml`. No new attack surface.

### Deferred (tracked for `0.1.0` final release)

- **PR-X4 — image signing + SBOM (renumbered from a previously-planned PR-X3 slot when X3 was reassigned to CI parallelization).** Adds cosign keyless signing (using GitHub OIDC) to the release-image workflow + an `imagetools inspect` step that verifies the signature before the smoke passes; publishes an SPDX SBOM as a sibling artifact. Required by `IMPLEMENTATION-PLAN.md` §3.3 ("GPG-signed release tags") and tracked there as a `0.1.0`-final gate item. No new images, no compose changes — the signing layer goes on top of X2's distribution layer.
- **Multi-arch `linux/arm64`** — deferred to v0.2. The `setup-buildx-action` is wired today so the change is a one-line `platforms: linux/amd64,linux/arm64` addition; the gate is the v0.2 partner who actually deploys on Apple Silicon / Graviton.

---

## Phase-a follow-up — X3 (CI parallelization + test sharding)

A third post-`0.1.0-a` PR closes the CI wall-time tax that the W1 timeout bump (25 → 35 min) made visible without actually fixing — the prior monolithic `toolchain` job in `.github/workflows/ci.yml` ran install → eslint-plugin build → lint → typecheck → test → schema drift → fixtures-lint **serially** on a single runner, and the last four green runs on `main` clocked 1635–1650s (~27 min) — only ~5 min of margin against the W1-bumped 35-min timeout, with the test step contributing ~75% of wall time. PR-X3 splits `toolchain` into four parallel jobs (`lint`, `typecheck`, `test`, `drift-and-fixtures`) and shards the `test` job 4-ways via vitest's native `--shard=N/M` matrix. Wall time on a green PR drops from ~27 min to ~6–8 min on the longest path. The `prompt-injection-corpus (deterministic tier)` job stays unchanged — it already ran in parallel with `toolchain` on a separate runner. Trade-off: 4–5× actions-minutes consumed for the same work; we're a personal-account public repo with unlimited free Linux minutes on github.com (the `github.com` tier vs. GHES) so the trade is pure upside on the project's current footing.

### Changed (X3) — `.github/workflows/ci.yml`

- **`toolchain` becomes four parallel jobs.** `lint` (10 min timeout), `typecheck` (15 min), `test` (20 min per shard), `drift-and-fixtures` (10 min). Each runs on its own `ubuntu-latest` runner with the same install pattern (`actions/checkout@v4` → `pnpm/action-setup@v4` → `actions/setup-node@v4` with `cache: pnpm` → `pnpm install --frozen-lockfile` → `pnpm --filter @opencoo/eslint-plugin build`). The eslint-plugin build is preserved on every job (not just `lint`) so each job has the same setup shape — easier to reason about, and the build is ~10s. The `test` job additionally runs `pnpm --filter @opencoo/shared build` before the suite — a large fraction of tests across the workspace import `@opencoo/shared/*` via subpath exports (`@opencoo/shared/db/schema`, `@opencoo/shared/llm-router`, `@opencoo/shared/logger`, `@opencoo/shared/wiki-write`, etc.) which resolve to `dist/`; vitest does not run tsc transparently, mirroring the explanation already documented in the existing `prompt-injection-corpus` job for the same reason.
- **`test` matrix with `fail-fast: false`.** `strategy.matrix.shard: [1, 2, 3, 4]` runs four shards in parallel; each runs `pnpm test -- --shard=${{ matrix.shard }}/4`. `fail-fast: false` is critical: without it, one shard's failure cancels the others on first failure, masking per-shard signal. We want every shard to report so a regression's blast radius is immediately localised — "shard 3 failed" tells us where to look, while a fail-fast cancel masks whether the issue is shard-local or systemic. The matrix job name is `test (${{ matrix.shard }})` so the four checks appear as `test (1)`, `test (2)`, `test (3)`, `test (4)` in the PR check list.
- **`drift-and-fixtures` job carries the schema-drift + fixtures-lint steps verbatim** from the prior `toolchain` job (lines 50–83 of the pre-X3 ci.yml). The schema-drift step runs `pnpm --filter @opencoo/shared db:check && db:generate` and fails if `git diff` shows a non-empty diff under `packages/shared/drizzle/` (the trip-wire for "edited a schema file without regenerating the migration"). The fixtures step runs `pnpm lint:fixtures`, asserts non-zero exit (the fixtures MUST fail to prove the boundary rules are wired), and asserts that all five expected rule ids (`opencoo/no-cross-engine-import`, `opencoo/no-direct-gitea-write`, `opencoo/no-direct-llm-sdk`, `opencoo/no-feature-env-vars`, `opencoo/no-update-append-only`) appeared in the output. Both steps are bytewise-identical to the pre-X3 versions; the move is a job-boundary refactor, not a behavior change.
- **`prompt-injection-corpus (deterministic tier)` job unchanged.** Already ran in parallel with `toolchain` on a separate runner pre-X3 — no edit needed.
- **Workflow-level `concurrency` block unchanged.** `group: ${{ github.workflow }}-${{ github.ref }}` + `cancel-in-progress: true` still cancels superseded PR runs as a unit (every job in a run shares the same group, so the run is cancelled atomically when the PR head moves).

### Configuration

- **No new env vars.** PR-X3 is a pure CI-workflow change; no engine code paths touched.
- **No new credentials.** No new GitHub Actions secrets needed; the parallel jobs run under the same `secrets.GITHUB_TOKEN` permission model the prior monolithic `toolchain` did.

### Schema

- No new migrations. PR-X3 is CI-workflow-only.

### Documentation

- **`docs/pilot-runbook.md` §12** gains a fifth bullet (PR-X3 follow-up): the `main`-branch protection rule on github.com lists `toolchain (lint / typecheck / test / fixtures)` as a required check; that name disappears with this PR and must be replaced with the new check names: `lint`, `typecheck`, `test (1)`, `test (2)`, `test (3)`, `test (4)`, `drift-and-fixtures`, plus the unchanged `prompt-injection-corpus (deterministic tier)`. Until updated, the old check appears "expected — Waiting for status to be reported" on every PR and blocks merge. This is a one-time UI action by the maintainer; no operator-side change.
- **`IMPLEMENTATION-PLAN.md` §1.1** appends X3 to the phase-a follow-up roster; new §1.2.21 mirrors the §1.2.19 (X1) / §1.2.20 (X2) shape.
- **No `architecture.md` impact.** CI parallelization is a build-system concern, not a product surface. The architecture doc is unaffected.
- **No `THREAT-MODEL.md` impact.** The set of CI checks that gate merges is unchanged; only their job topology + names changed. The `prompt-injection-corpus (deterministic tier)` ship-blocker (§4.2) still runs on every PR; the `no-direct-gitea-write` / `no-direct-llm-sdk` / `no-cross-engine-import` / `no-feature-env-vars` / `no-update-append-only` boundary-rule trip-wires (`drift-and-fixtures` job) still fire on every PR.

### Tests

- **No new TypeScript tests.** PR-X3 ships infrastructure (CI workflow YAML); the validation surface is the build-and-run smoke documented in the PR description. The existing `pnpm test` / `pnpm typecheck` / `pnpm lint` suites must stay green — none of the X3 files are TypeScript so this is a no-op verification.
- **Sharding partitions; it does not exclude.** Local verification: each of `pnpm test -- --shard=1/4` through `--shard=4/4` passes independently. Sum of per-shard test counts (740 + 625 + 623 + 531 = 2519) equals the unsharded `pnpm test` total (2506 passed + 13 skipped = 2519). The partition is exhaustive — no test file is dropped from the matrix.

### Threat-model alignment (§5 PR checklist)

- **Zero new admin-API write surfaces.** PR-X3 is CI-workflow-only; the engine's HTTP routing is unchanged.
- **Same CI sandbox.** All four jobs run on `ubuntu-latest` under the same `czlonkowski/opencoo` repo permission model as `release.yml` and the previous monolithic `toolchain`. No new secrets, no elevated permissions; the default `GITHUB_TOKEN` scope is unchanged.
- **No new attack surface.** Splitting one serial job into four parallel jobs doesn't add an external trust boundary — every job runs the same `actions/*` actions the monolithic job did. The `pnpm/action-setup@v4` + `actions/setup-node@v4` + `actions/checkout@v4` set is identical.
- **Append-only invariant preserved.** PR-X3 doesn't touch any schema, migration, or log path. THREAT-MODEL §2 invariant 8 (append-only) is unaffected.

### Deferred (tracked for `0.1.0` final release)

- **Turborepo remote cache wiring.** `pnpm typecheck` and `pnpm lint` could skip per-package tasks when their inputs haven't changed since the last green run, but wiring requires either pointing turbo at a GHA-cached `--cache-dir` or using a remote cache action. Skipped from X3 because the per-job `pnpm install` (cached via `setup-node`'s `cache: pnpm`) + the explicit eslint-plugin build is already fast enough to hit the ~6–8 min wall target. Re-evaluate if any single job's cold-cache path exceeds 8 min after a few PR cycles of empirical data.
- **PR-X4 — image signing + SBOM** (renumbered from the previously-planned PR-X3 slot when X3 was reassigned to CI parallelization). See the X2 "Deferred" block above for the full description; the substance is unchanged.

---

## Phase-a follow-up — Z1 (Drive client wiring)

The first real partner cutover (Estyl, 2026-05-11) provisioned a Drive source binding cleanly through the management UI — credential schema validated, the `sources_bindings` row inserted, the admin-API returned 201 — but the moment a manual force-trigger reached the scanner, the engine emitted `scanner.scan_failed adapter_slug=drive error: drive: production makeDrive not wired in v0.1 — bind via UI when adapter ships`. The package itself (`packages/adapters/source-drive/`) was complete: `createGoogleDriveAdapter`, the `MakeDrive = (refreshToken: Buffer) => DriveLikeApi` factory contract, the `DriveLikeApi` boundary interface, the `makeMockDrive` test mock that satisfies it, the `binding-config.ts` zod schemas — all already there. What was missing was the production client: the `production-composition.ts` factory injected a `makeDrive` that threw at call time. PR-Z1 wires the real `googleapis@^144` Drive client to satisfy the existing contract, unblocking the partner's first compiled-page deliverable. Z2 (the `seed()` primitive Drive will use to backfill existing folder contents) and Z3 (the scanner cron that ticks polling adapters) dispatch only after this PR merges.

### Changed (Z1) — `packages/adapters/source-drive/`

- **New dep: `googleapis@^144` + `google-auth-library@^9.15`** added to `packages/adapters/source-drive/package.json` `dependencies` (NOT `cli/package.json` — the SDK weight stays inside the adapter package). The lockfile resolves to `googleapis@144.0.0` + `google-auth-library@9.15.1` + 4 transitives (`googleapis-common@7.2.0`, `gaxios@6.7.1`, `gtoken@7.1.0`, `gcp-metadata@6.1.1`, plus `google-logging-utils@0.0.2`). On-disk weight under `node_modules/.pnpm/googleapis@144.0.0/` is ~114 MB; the partner image baseline grows accordingly. This was captured in the wave-12 scoping doc's pre-flight check #4 ("Operator confirmed acceptance of `googleapis@^144` as a new dependency in `packages/source-drive/` (it pulls a chunky transitive tree — adds ~10 MB to the engine image). Captured 2026-05-11.") — the actual on-disk number runs an order of magnitude higher than the original estimate because much of the SDK is per-API discovery JSON, but the runtime working-set the v8 isolate loads stays modest (we import `google.drive` + `JWT` only).
- **New file: `packages/adapters/source-drive/src/google-drive-api.ts`** — wraps `googleapis@^144`'s Drive v3 client to the existing `DriveLikeApi` interface from `drive-api.ts`. Three exports:
  - `parseServiceAccountJson(raw: string): ServiceAccountKey` — defensive parser for the SA JSON the operator pastes into the credential form. Validates the two required fields (`client_email`, `private_key`) and produces actionable typed errors on each documented failure mode (malformed JSON, wrong top-level shape, missing required field, empty-string field, non-string field). Deliberately zero-dep — no zod import here, the inline parser is a dozen lines and the errors it produces are equally readable.
  - `createGoogleDriveApi(credentials: ServiceAccountKey): DriveLikeApi` — synchronous factory that constructs a `JWT` (the canonical service-account auth pattern from `google-auth-library`, NOT OAuth2 — opencoo never needs user-delegated access) scoped to `https://www.googleapis.com/auth/drive.readonly`. Returns a plain object exposing the three boundary methods. Each call mints/reuses a short-lived bearer token via the SDK's internal cache.
  - `getStartPageToken()` maps to `drive.changes.getStartPageToken({})`. `listChanges({ pageToken, folderId, mimeTypes })` maps to `drive.changes.list` with `fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,modifiedTime,mimeType,parents))"` — that field-mask trims the response to only what the adapter consumes (avoids paying for the full Drive change-payload on every page). The result honors mime-type whitelisting + folder-parent scoping client-side (defense-in-depth — the adapter ALSO filters in `adapter.ts`, but applying it at the API boundary trims response volume). `exportAsBytes({ fileId, mimeType })` branches on Google-native vs. binary: Google Docs go through `drive.files.export` with `mimeType: text/markdown` preferred (the wiki compiler likes the lighter normalization), with a tightened fallback to `text/plain` only on the documented "format unavailable" 400 error mode (any other failure bubbles unchanged); non-Google files (PDF, images, plain text) flow through `drive.files.get?alt=media`. Both branches return a Node `Buffer` defensively coerced from the SDK's `ArrayBuffer`/`Uint8Array` response.
- **`packages/adapters/source-drive/src/index.ts`** — re-exports the three new symbols (`createGoogleDriveApi`, `parseServiceAccountJson`, `ServiceAccountKey`) from the package root so the production composition root can import them without a deep subpath. The existing `MakeDrive` / `DriveLikeApi` / `createGoogleDriveAdapter` exports are unchanged — Z2 + Z3 will rebase on this lockfile and depend on those staying stable.

### Changed (Z1) — `packages/cli/src/provision/production-composition.ts`

- **Replaced the `makeDrive: () => { throw new Error(...) }` stub** in `loadSourceAdapterFactories` with the real wiring: `makeDrive: (refreshToken) => { const json = refreshToken.toString("utf8"); const sa = mod.parseServiceAccountJson(json); return mod.createGoogleDriveApi(sa); }`. The closure honors the existing `MakeDrive = (refreshToken: Buffer) => DriveLikeApi` contract — the adapter calls `makeDrive(record.plaintext)` once per scan with the freshly-resolved Buffer from the CredentialStore, so a rotated SA key picks up on the next scan without an engine restart (the rotation-friendliness pin lives in the existing adapter test).
- **The matching n8n stub is unchanged** — Z1 scope is Drive-only. The `source-n8n` real client wiring is documented in the wave-12 scoping doc as out of scope ("Estyl doesn't need n8n as a SOURCE (they use n8n as automation, consumed via `n8n-mcp`). Filed as v1.x scope.").
- **`packages/cli/src/bin.ts`'s `source test` stub is also unchanged** — that code path is documented as "binding-config validation only" and never invokes `makeDrive` (the adapter's factory validates `config` at construction time without needing the client). Wiring it would expand the PR's surface without unblocking any partner.

### Tests

- **New unit test: `packages/adapters/source-drive/tests/google-drive-api.test.ts`** — 13 tests covering `parseServiceAccountJson` happy + every documented failure mode (malformed JSON, JSON array / null / primitive at top level, missing client_email, empty-string client_email, missing private_key, empty-string private_key, non-string client_email) and `createGoogleDriveApi` shape verification (returns a plain object exposing the three contract methods, returns synchronously not as a Promise). Covers the boundary the production composition root cares about; doesn't exercise the SDK methods themselves (that's the gated real-API test's job — mocking `googleapis` here would just rebuild the SDK's own tests).
- **New gated real-API test: `packages/adapters/source-drive/tests/google-drive-api.real.test.ts`** — runs only when `RUN_REAL_DRIVE=1` is set AND `RUN_REAL_DRIVE_SA_JSON` points at a readable SA-key file AND `RUN_REAL_DRIVE_FOLDER_ID` + `RUN_REAL_DRIVE_DOC_ID` are present. Asserts: `getStartPageToken` returns a non-empty string, `listChanges` from the start token returns the result shape (changes array + non-empty nextPageToken — we don't pin count because the change-feed semantics return zero on a fresh token), `exportAsBytes` against the fixture Google Doc returns a non-empty Buffer. Skip pattern parallels PR-Q4's `RUN_REAL_PILOT=1` lane — no fixture is committed; the operator opts in.
- **Existing tests stay green.** `pnpm --filter @opencoo/source-drive test` reports 36 passed + 1 skipped (the gated real-API sentinel), unchanged delta on the existing mock-driven `source-drive.test.ts` (22 tests still passing — `createGoogleDriveAdapter` accepts any `MakeDrive`, including the mock; the new wiring only touches the production-side closure). `pnpm --filter @opencoo/cli test` reports 99 passed (no regression from the production-composition edit). `pnpm test` at root reports 2520 passed + 14 skipped, with 42 unhandled `EPIPE` rejections in `engine-ingestion/tests/start-webhook-mount.test.ts` that pre-date this PR (verified by stashing the change and re-running — same 42 errors on `main`).

### Threat-model alignment (§5 PR checklist)

- **No new env vars.** The SA JSON lives in the existing CredentialStore (the same AES-256-GCM Drizzle store the rest of v0.1 uses). The `RUN_REAL_DRIVE_SA_JSON` env is test-only — it points at a local file path, never at credential bytes; production never reads it. THREAT-MODEL §2 invariant 9 (no new feature env vars) holds.
- **No new admin-API surface.** PR-Z1 changes a single closure inside the composition root + adds a new internal module; the management UI's binding-create flow and the admin-API routes are unchanged.
- **CredentialStore-only sourcing preserved.** `parseServiceAccountJson` reads `refreshToken` (a `Buffer`) supplied by the adapter, which sourced it from `CredentialStore.read(args.credentialId).plaintext`. THREAT-MODEL §3.6 invariant 11 (credentials come from the store by id, never inline) holds — the existing adapter-level type-pin (`@ts-expect-error` negative-case test) still enforces it; this PR doesn't widen the factory signature.
- **Read-only Drive scope.** The `JWT` is constructed with `scopes: ["https://www.googleapis.com/auth/drive.readonly"]`. opencoo cannot mutate Drive content; a leaked SA key cannot be used to delete partner files. The narrow scope is also the floor we'd want from a defense-in-depth standpoint even if the adapter wanted write access (it doesn't — there's no Drive write call anywhere in the engine).
- **New transitive-dep tree — flag for §5 walk.** googleapis pulls `google-auth-library`, `googleapis-common`, `gaxios`, `gtoken`, `gcp-metadata`, `google-logging-utils`. All published by Google or `googleapis-org` on npm with multi-year publish histories. Maintainer to confirm the npm publisher posture against THREAT-MODEL §4.1's supply-chain criteria during the wave-end §5 walk. The choice mirrors the explicit decision in the wave-12 scoping doc (pre-flight check #4) — `googleapis` is the canonical Google-published Drive SDK; building a hand-rolled REST client to avoid the transitive-dep tree was rejected as more risk per maintenance dollar than it's worth for a v0.1 reference adapter.
- **Append-only invariant preserved.** PR-Z1 doesn't touch any schema, migration, or log path. THREAT-MODEL §2 invariant 8 (append-only) is unaffected.

### Image size impact

- **~114 MB added to `node_modules/.pnpm/`** for the `googleapis@144.0.0` package alone (most of which is per-API discovery JSON shipped at npm-publish time — the v8 isolate's working set after `import { google } from "googleapis"; google.drive(…)` is much smaller than the on-disk footprint suggests). The wave-12 scoping doc's pre-flight estimate was ~10 MB, captured before the actual install measurement; the real number is order-of-magnitude higher and worth flagging in the wave-end Chrome QA against the `0.1.0-a.2` partner image (the engine container's compressed-layer delta is the meaningful operator-facing number, not the pnpm-store on-disk size). If the layer delta turns out to be operationally painful, the v0.2 alternatives are: pin the package + drop unused per-API shards via a custom build step, or replace `googleapis` with a hand-rolled `fetch` against the Drive REST API (the boundary surface is small enough — three methods — that this would be a tractable v0.2 follow-up, not a v0.1 blocker).

### Migrations / DB

- No new migrations. PR-Z1 is composition-root + adapter-package code only.

### Documentation

- **`IMPLEMENTATION-PLAN.md` §1.1** appends Z1's merge sha + URL to the phase-a follow-up roster's status snapshot. (The wave-end closeout will add §1.2.21's wave-12 pointer; this PR doesn't pre-create that section.)
- **`docs/plan-appendix/phase-a-12-cutover-completion.md` (Z0)** lists Z1 as the first PR of sub-wave 1 — no doc edit needed here, the scoping doc landed before this PR.
- **No `architecture.md` impact.** Z1 implements the production half of the existing `MakeDrive` factory contract; the adapter-boundary surface (§10 in the architecture spec) is unchanged.

### Deferred (tracked outside Z1)

- **Image-size optimization.** See "Image size impact" above. v0.2 follow-up.
- **Retry / backoff for transient Drive errors.** The SDK's default `gaxios` configuration retries 5xx + 429 with exponential backoff; we don't currently override it. If pilot data surfaces noisy retry storms, the v0.2 follow-up is to inject an `IDPlusRetry`-aware policy from `@opencoo/shared/llm-router`'s pattern.
- **Drive change-watcher webhooks.** The engine polls Drive at the scanner cron's cadence (which Z3 lands). Drive's push-notification feature could turn this into push instead of poll; deferred until partner data shows poll-cadence latency is the operator's pain point.

### Review fix-ups (post-merge code-quality pass)

After Z1 landed, a code-quality review surfaced one Critical + three Important items. C1, I1, and I3 ship as a follow-up commit on the Z1 branch; I4 (pageSize-override path documentation polish) is deferred and the P1–P6 cosmetic items are tracked outside this PR.

- **C1 (Critical) — `parents`-empty no longer widens scope past the binding folder.** The post-fetch filter in `listChanges` previously short-circuited on `parents.length > 0 && !parents.includes(folderId)` — when Drive returned `parents: []` (a legitimate shape for files moved to root, shared-link-only access, certain shared-drive items without `supportsAllDrives`, and various field-mask edge cases) the change leaked past the binding's folderId scope into the adapter. The strict include-test now always fires (`!parents.includes(folderId) → skip`), matching the mock's `file.folderId !== args.folderId → skip` behavior. The post-fetch filter logic was extracted into a pure helper `filterChangesByFolderId(rawChanges, args)` exported from `google-drive-api.ts` so the C1 contract pin lives in unit-testable code rather than inside the SDK-coupled `listChanges` closure. +8 unit tests cover the predicate matrix (empty parents, missing parents, other-folder parents, target-folder parents, multi-parent including target, removed-event tombstones, mime-type filter precedence, defensive empty-fileId skips).
- **I1 (Important) — markdown export 400-fallback narrowed to the documented "format unavailable" mode.** `isMarkdownExportUnavailable` previously matched any 400 — an auth-permission 400 or a malformed-fileId 400 would silently downgrade the export to `text/plain` instead of bubbling. The predicate now inspects `errors[0].reason` for `/exportFormat|formatUnsupported/i` (Drive's canonical signal) with a defensive message-substring fallback for SDK versions that don't populate `errors[]`. The previously-dead `code === "400"` string branch (I2 fold-in) is dropped — `gaxios@6.x` uses a numeric `code`. +9 unit tests cover the canonical signal, a permissionDenied 400 negative, two message-only positives, a 401 negative, non-error inputs, an unrelated-message 400 negative, the `status: 400` SDK-version variant, and the looser `fileFormatUnsupported` reason.
- **I3 (Important) — shared-drive items now reachable.** Every Drive REST call below `createGoogleDriveApi` that accepts the flag passes `supportsAllDrives: true` unconditionally, and `changes.list` additionally passes `includeItemsFromAllDrives: true`. The binding might be on My Drive or a shared drive (the common Google Workspace pattern); the engine doesn't know which at scan time, so opting in matches Google's recommended pattern for "I don't know which drive type the user has." Without the flags, partners on shared drives silently got zero results. `files.export` is the exception — Drive REST v3 doesn't expose the flag on that endpoint (the file's drive type is already resolved by the time export runs); the file-header comment documents the carve-out. No new unit tests — the mock doesn't model shared-drive semantics; coverage lands when a partner runs against a shared drive via the gated real-API test.
- **I2 (Important) — fold-in only.** The dead `code === "400"` string-form branch in `isMarkdownExportUnavailable` was dropped as part of the I1 rewrite (gaxios@6.x always uses a numeric code).

Test count moves from 36 passed + 1 skipped to 53 passed + 1 skipped on `pnpm --filter @opencoo/source-drive test` (delta: +17 tests). Repo-wide `pnpm test` reports 2537 passed + 14 skipped (was 2520 passed + 14 skipped pre-fix-up). The pre-existing EPIPE flake in `engine-ingestion/tests/start-webhook-mount.test.ts` is unaffected.

## Phase-a follow-up — Z5 (worldview seed)

### Why

Wave-12 gap **G4** (`docs/plan-appendix/phase-a-12-cutover-completion.md`): the domain-create flow seeded `index.md` + `log.md` + `schema.md` into the new Gitea repo but NOT `worldview.md`. The Heartbeat agent reads `worldview://<slug>` via `gitea-wiki-mcp-server` (`packages/gitea-wiki-mcp-server/src/resources/worldview.ts`'s `readWorldview`), which raises `McpResourceNotFoundError` when the file is missing. Verified live on the partner deployment: every Heartbeat dispatch on a freshly-provisioned domain failed at validation (`error_class=validation, output={"name":"McpResourceNotFoundError"}`) until the first ingest cycle produced a worldview body.

### What shipped

- **4th seed file in `provisionDomainRepo`** (`packages/engine-self-operating/src/composition/gitea-provisioning.ts`). The function was already opencoo's single sanctioned exception to the "every Gitea write flows through `wikiWrite`" invariant (architecture.md §1424, THREAT-MODEL §3.5); Z5 extends it from 3 seed POSTs to 4. Provisioning is still atomic — any seed failure rolls back the `domains` row inside the existing `db.transaction` wrapper in `POST /api/admin/domains`.
- **Locale-aware placeholder body.** `buildWorldviewPlaceholder(locale)` returns the canonical placeholder in English (default) or Polish; `auto` and any unknown locale fall back to English, mirroring the prompt-loader convention (`packages/shared/src/prompts/loader.ts` §7). The text deliberately leads with the lede ("Awaiting first ingest" / "Oczekiwanie na pierwszą synchronizację") so an operator viewing the file in Gitea immediately understands it is a placeholder.
- **Commit-message pin.** The legacy three seeds use `[provisioning] seed <path>`; the worldview seed uses `seed: empty worldview placeholder` so a partner inspecting `git log` on the wiki repo immediately sees the file's intent.
- **Tests.** `packages/engine-self-operating/tests/composition/gitea-provisioning.test.ts` grows from 11 to 18 assertions: the happy-path now asserts 5 fetch calls (1 repo create + 4 seeds) and pins the worldview commit message; the fresh-empty-repo bug-C regression test asserts the 4th URL ends with `/contents/worldview.md`; three new wire-shape tests pin the locale-correct placeholder body (en + pl + auto fallback) + the path; four unit tests cover `buildWorldviewPlaceholder` directly.

### IMPORTANT — what Z5 does NOT do

**The worldview compiler does NOT automatically overwrite `worldview.md` on subsequent ingests.** Tracing `packages/engine-self-operating/src/pipelines/worldview/compile-domain.ts` — `compileDomainWorldview` is exported through `pipelines/worldview/index.ts` and re-exported from `src/index.ts`, but a repo-wide grep (`compileDomainWorldview` + `compile-domain`) finds **no production caller**: it's invoked only from the unit-test suite (`tests/pipelines/worldview/compile-domain.test.ts`). The compiler emits a `worldview_impact: string[]` bullet array per page (handled via `normaliseWorldviewImpact` in `packages/engine-ingestion/src/compiler/worldview-impact.ts`), but no aggregator wires those bullets into a single `worldview.md` write.

Wave-12 scoping doc (the "Out of scope" section) asserts: _"Z5 seeds a placeholder; the existing compiler overwrites it on the first ingest cycle."_ That sentence is incorrect — there is no production aggregator today. Z5 ships the placeholder regardless (it closes G4 either way: Heartbeat now succeeds against an empty domain), but the placeholder may live indefinitely on a partner deployment until the compiler-aggregator gap is filled.

This is a **previously-uncatalogued gap** in the wave-12 inventory. Surfaced here for the next wave's planning; not blocking Z5's G4 closure. Candidate scope for a follow-up PR (call it Z11 / phase-b appendix item): wire the `IngestionProcessor` worker to call `compileDomainWorldview` post-merge per affected domain and route the result through `wikiWrite` with `path='worldview.md'` + tag `[compiler]`. The compiler already enforces a 24 KB byte cap with a single retry-on-overflow path (`WorldviewOverflowError` → DLQ), so the missing piece is the trigger + the write, not the compilation.

### Migrations / DB

None. Z5 is composition-helper code only.

### Documentation

- **`IMPLEMENTATION-PLAN.md` §1.1** updates the wave-12 status-snapshot line to include Z5 (and pins Z1's merge sha + PR number `b7e1a4b` / #106).
- **`docs/plan-appendix/phase-a-12-cutover-completion.md`** — no edit needed; Z5 was already enumerated in the wave roster + file-overlap map.
- **No `architecture.md` impact.** The worldview placeholder is a domain-create-time bootstrap detail; the §9 worldview-compiler spec is unchanged.

### Deferred (tracked outside Z5)

- **Compiler-aggregator wiring** — the production path that turns `worldview_impact` bullets into a regenerated `worldview.md` per ingest cycle (see "what Z5 does NOT do" above). Filed for follow-up; v0.1 or v0.2 depending on partner pressure.

### Tests + verification

- `pnpm --filter @opencoo/engine-self-operating test`: 669 passed (was 662). Delta: +7 (4 new worldview placeholder + 3 unit tests for `buildWorldviewPlaceholder` + 4 wire-shape tests on the worldview seed call; some assertions extended existing tests, net new-test count is 7).
- `pnpm lint` clean. `pnpm typecheck` clean (29/29 tasks).
- `pnpm test` repo-wide: 2545 passed (was 2537 post-Z1). The pre-existing EPIPE flake in `engine-ingestion/tests/start-webhook-mount.test.ts` (Redis socket teardown noise unrelated to Z5) still surfaces in test-runner output as an unhandled rejection without failing any test; the runner emits non-zero only because of that unhandled-rejection — captured for the wave-end Chrome QA. Mitigation candidate logged for v0.2.

---

## Phase-a follow-up — Z2 (`SourceAdapter.seed()` primitive + Drive seed + Asana seed)

Z1 wired Drive to the real `googleapis` SDK and unblocked binding-create. Z2 closes the next gap — the **brand-new binding's existing content is invisible** until something changes. The `SourceAdapter` port at `packages/shared/src/source-adapter/index.ts` only exposed `scan(SourceScanArgs)` (cursor-keyed change-feed polling) + optional webhook helpers. A first scan against a null cursor bootstraps with Drive's `getStartPageToken()` and from that point forward only emits CHANGES — every file that existed in the bound folder BEFORE the binding was created is invisible to the engine. Asana is worse: webhooks only catch events after registration, so a project with 50 existing tasks delivers exactly zero `ingestion_intake` rows until someone touches one. The partner's freshly-bound Drive folders and Asana projects sat empty in the wiki because of this exact gap (G2 in the wave-12 scoping doc).

Z2 adds the missing primitive. The `SourceAdapter` interface gains an optional `seed?(SourceSeedArgs): Promise<SourceSeedResult>` method; the Scanner pipeline learns to dispatch to `seed()` instead of `scan()` when a binding's `last_scan_cursor` is null AND the adapter exposes seed. Drive's seed walks the bound folder recursively via Drive's `files.list` (the `q` parameter has no "descendants of" operator, so the recursion is engine-side BFS) and hands a `getStartPageToken()` snapshot captured BEFORE the walk as the seed-boundary cursor — files that mutate mid-seed flow back through the change feed and `ingestion_intake` UNIQUE absorbs the overlap. Asana's seed paginates the project's tasks via the existing `AsanaClient.fetchProjectSnapshot` helper (which already handles 429-aware backoff + 5xx retry + `next_page.uri` pagination) and emits one `SourceChangedDocument` per task with a `:seeded` discriminator on the sourceDocId so subsequent event-driven webhook rows don't dedupe-collide.

The seed primitive is OPTIONAL on the interface. Webhook-only adapters where the "existing content" set is genuinely empty (`fireflies` — meeting transcripts only exist forward-in-time; `webhook` — generic event-driven; `n8n` — workflow-trigger-driven) leave `seed` undefined and the Scanner falls back to `scan()` on the first tick. Z3 (the next PR — scanner cron + scan-now endpoint) will close G6 by calling the same Scanner code path on binding-create so the seed runs without waiting for the 4h cron.

### Changed (Z2) — `packages/shared/src/source-adapter/`

- **New types: `SourceSeedArgs`, `SourceSeedResult`** added to `index.ts`. `SourceSeedArgs` carries only an optional `now?: number` (no `cursor` — seed is always a fresh full-fetch from zero, by definition). `SourceSeedResult` mirrors `SourceScanResult.documents` with the same `SourceChangedDocument` shape so the Scanner's intake-dedupe + enqueue path consumes either without branching on the source. The result's `cursor` is the persisted handoff to subsequent `scan()` invocations: for Drive it's the `getStartPageToken()` snapshot captured at seed-START; for Asana it's a `asana-seeded:<ISO>` sentinel because Asana has no resumable cursor (the steady-state is webhook-driven).
- **`SourceAdapter.seed?(args)` added** as optional. The contract: emissions flow through the SAME `ingestion_intake` UNIQUE(binding_id, source_doc_id, source_revision) dedupe path `scan()` uses, so a seed followed by a same-tick `scan()` does NOT re-emit the seeded docs. Adapters opt out by omitting the property — the Scanner detects `seed === undefined` + a null cursor and falls back to `scan()` on the first tick.

### Changed (Z2) — `packages/adapters/source-drive/`

- **New file: `packages/adapters/source-drive/src/seed.ts`** — the `runDriveSeed(...)` helper exposes the recursive-walk logic as a pure function so the unit tests can call it directly with a mocked `DriveLikeApi`. The walker captures `getStartPageToken()` BEFORE the BFS starts (so files mutating mid-seed land back through the change feed rather than vanishing in a race), then iterates direct children via `listFiles({ folderId, pageToken })`, queues subfolders for recursion (Drive folder mime = `application/vnd.google-apps.folder`), and exports each file matching the binding's `mimeTypes` whitelist. A 5000-folder cap defends against pathological partner data; per-file 1 MiB ceiling mirrors the scan-path assertion 7. The `partitionSeedListing` sibling helper is the C1-style C1-style pure-filter predicate so the test pin lives in unit-testable code rather than inside the SDK-coupled walker closure.
- **`DriveLikeApi.listFiles?(args)` added** to `drive-api.ts` as an optional method — existing scan-focused test mocks compile without changes; the seed implementation throws a clear error if the injected client doesn't implement it. Production wiring (`google-drive-api.ts`) implements `listFiles` against `drive.files.list` with `q: "'<folderId>' in parents and trashed = false"`, `fields: "nextPageToken,files(id,mimeType,modifiedTime)"`, and the same `supportsAllDrives + includeItemsFromAllDrives + corpora: 'allDrives'` shared-drive flags Z1 added to `listChanges`.
- **`createGoogleDriveAdapter` exposes `seed`** on the returned `SourceAdapter`. The factory delegates to `runDriveSeed` — the credential is read at seed time (rotation-friendly, same as the scan path), `makeDrive(plaintext)` constructs the client, and the recursive walk pulls the bound folder. No new env vars; no new admin-API surface.
- **`MockDriveSimulator` extends with `addFolder({ folderId, parentId })`** so the seed unit tests can model a folder tree. The mock's `listFiles` returns direct children of the requested folderId (files + subfolders) — pagination intentionally returns everything on a single page; the pagination path is exercised by a separate hand-rolled mock that scripts `nextPageToken` explicitly.

### Changed (Z2) — `packages/adapters/source-asana/`

- **New file: `packages/adapters/source-asana/src/seed.ts`** — the `runAsanaSeed(...)` helper iterates the bound `projectGid` (or every entry in `monitoredProjectGids` when configured) and emits one `SourceChangedDocument` per task. Doc shape mirrors the webhook path's `parseEvents` output: `sourceDocId = task-<gid>:seeded` (the `:seeded` discriminator keeps seed rows distinct from event rows `<gid>:<action>` so a future webhook delivery for the same task doesn't dedupe-eat the seed row), `sourceRevision = task.modified_at` (so a follow-up seed run is intake-dedupe no-op), `sourceRef = asana:task/<gid>`, `contentBytes = JSON.stringify(taskRow)`. Per-project fail-open: a transient 5xx on one project logs a structured warning and skips ahead to the next, mirroring the existing `enrichEvents` snapshot-fetch policy.
- **The cursor handoff is a `asana-seeded:<ISO timestamp>` sentinel.** Asana is webhook-driven for incremental — there's no resumable cursor in the REST API the way Drive has page tokens. Returning literal `null` would cause every subsequent Scanner tick to re-route to seed() because the Scanner uses cursor-non-null as the "is this binding seeded?" flag. The sentinel is opaque to scan() (Asana's scan() ignores its input cursor anyway — default modes return `{ documents: [], nextCursor: null }`; periodic mode returns one snapshot per project) and operator-readable so a glance at `sources_bindings.last_scan_cursor` reveals when the binding was seeded.
- **`createAsanaSourceAdapter` exposes `seed`** on the returned `SourceAdapter` ONLY when an `asanaClient` OR a `makeAsanaClient` factory is wired. Webhook-only deployments without an Asana client (snapshotMode='off' + no client provided) get `seed: undefined` so the Scanner falls back to scan-first behavior. The lazy-resolution pattern mirrors the existing `enrichEvents` resolver (PR-Q8 Copilot triage): `makeAsanaClient` is invoked exactly once on the first `seed()` call and cached for the adapter's lifetime, so credential decrypt is deferred to first use; a throwing `makeAsanaClient` fails open with a structured warning (the receiver-side scanner already handles the at-least-once retry via the cursor-not-advanced path).

### Changed (Z2) — `packages/engine-ingestion/src/pipelines/scanner.ts`

- **Seed-vs-scan dispatch added.** For each enabled binding the scanner now checks `binding.lastScanCursor === null && adapter.seed !== undefined` and routes to `adapter.seed({ now })` instead of `adapter.scan({ cursor: null, now })`. The returned `cursor` is persisted to `sources_bindings.last_scan_cursor` exactly like a `scan()` result's `nextCursor`. Emissions flow through the same `upsertIntake` + BullMQ enqueue path as scan() — no new code in the intake-side; the `ingestion_intake` UNIQUE(binding_id, source_doc_id, source_revision) constraint absorbs partial-seed replay automatically.
- **Failed seed leaves the cursor null** so the next 4h cron tick re-tries seed from zero. Intake-dedupe handles partial-emit replay cleanly (UNIQUE doesn't care if the row already exists at the same revision). A separate logger event class (`scanner.seed_started` / `scanner.seed_completed` / `scanner.seed_failed`) is emitted so operators can grep for seed-specific telemetry without filtering through scan() noise.

### Tests

- **New file: `packages/adapters/source-drive/tests/seed.test.ts`** — 12 tests covering: (a) happy-path recursive walk emits 4 docs across a folder tree of 3 root files + 1 subfolder with 1 nested file, (b) cursor handoff captures the seed-START `getStartPageToken()` snapshot, (c) mime-type whitelist drops non-whitelisted files but always recurses into folders, (d) the `listFiles`-missing-on-client error path, (e) `partitionSeedListing` pure-filter predicate matrix (folder/file separation, mime whitelist, empty-fileId defense), (f) 1 MiB ceiling enforcement, (g) pagination — `nextPageToken` consumption through a hand-scripted mock with two pages.
- **New file: `packages/adapters/source-asana/tests/seed.test.ts`** — 9 tests covering: (a) one doc per task with `task-<gid>:seeded` shape, (b) `asana-seeded:<ISO>` sentinel cursor format + ISO-parseable suffix, (c) contentBytes is the JSON-encoded task row, (d) `monitoredProjectGids` multi-project iteration, (e) primary `projectGid` fallback when monitored gids absent, (f) per-project fail-open with `console.warn` capture, (g) lazy `makeAsanaClient` invoked once across multiple seeds, (h) `seed: undefined` on the adapter when neither client wired, (i) `AsanaClient` pagination — `next_page.uri` walking across two HTTP fixture responses verifies a >100-task project doesn't truncate.
- **New file: `packages/engine-ingestion/tests/pipelines/scanner-seed.test.ts`** — 6 tests covering the dispatcher integration: (a) first tick on a seed-capable adapter routes through seed() and persists the cursor, (b) subsequent tick with non-null cursor routes through scan() not seed(), (c) webhook-only adapter (no seed property) falls back to scan() on first tick, (d) two-tick flow — seed then scan with the persisted cursor, (e) failed seed leaves `last_scan_cursor` null so next tick re-tries, (f) partial-seed replay dedupes via the `ingestion_intake` UNIQUE constraint.
- **Test count delta.** `pnpm --filter @opencoo/source-drive test` moves from 53 passed + 1 skipped to 65 passed + 1 skipped (+12). `pnpm --filter @opencoo/source-asana test` moves from 124 passed + 2 skipped to 133 passed + 2 skipped (+9). `pnpm --filter @opencoo/engine-ingestion test` adds 6 tests in `tests/pipelines/scanner-seed.test.ts` (369 passed, was 363). Repo-wide `pnpm test` reports 2564 passed + 14 skipped (was 2537 passed + 14 skipped pre-Z2). Net delta: +27 tests across 3 new files. The pre-existing 42 EPIPE unhandled-rejection errors in `engine-ingestion/tests/start-webhook-mount.test.ts` are unaffected — verified by stashing the Z2 changes and re-running the offending file (same 42 errors on `main`).

### Threat-model alignment (§5 PR checklist)

- **No new env vars.** Seed uses the same `CredentialStore` Drive/Asana scan paths use. THREAT-MODEL §2 invariant 9 (no new feature env vars) holds.
- **No new admin-API surface.** Z2 changes the `SourceAdapter` port, two adapter packages, and the scanner pipeline. The management UI's binding-create flow and the admin-API routes are unchanged; Z3 will add the post-create scan-trigger endpoint.
- **CredentialStore-only sourcing preserved.** Both Drive seed and Asana seed resolve credentials by id at seed time, never inline. The factory signatures are unchanged from Z1 — no new inline-credential branches, no widening of the THREAT-MODEL §3.6 invariant 11 type-pin. The existing `@ts-expect-error` negative-case test continues to enforce the constraint at compile time.
- **Append-only invariant preserved.** Z2 doesn't touch any schema, migration, or log path. `last_scan_cursor` is an existing column (migration 0004); Z2 writes to it the same way `scan()` already does. THREAT-MODEL §2 invariant 8 (append-only) is unaffected.
- **Partial-seed replay safety.** Seed emissions flow through the same `ingestion_intake` UNIQUE(binding_id, source_doc_id, source_revision) constraint as scan emissions. A seed that fails mid-walk leaves `last_scan_cursor` null; the next cron tick re-emits the docs that were already inserted, intake-dedupe absorbs the dupes, and the seed completes on retry. No fresh attack surface — the dedupe key is already the same as the steady-state scan path.
- **No webhook signature paths changed.** Asana's webhook helpers (`extractAsanaWebhookSecret`, `wrapAsanaWebhookSecret`, `handshakeFn`, `verifier`) are untouched. Seed is a separate code path that doesn't intersect with the HMAC-verification surface.

### Out-of-scope (deferred)

- **Per-source seed cadence rate-limiting / pause-resume UI.** Z2 ships unbounded pagination. For the partner's 2 small Drive folders + 5 Asana projects this is fine. v0.2 may add a "pause seed" UI button if any partner has a 100k-task project. The 5000-folder cap in `runDriveSeed` is a defensive ceiling, not a rate-limit knob.
- **Drive push-notification (changes.watch) webhook mode.** Z2 keeps polling. Push delivery via Drive's `changes.watch` is a v0.2 follow-up — partner data will tell us whether polling cadence latency is an operator-facing pain point worth the receiver+renew complexity.
- **Re-seed UI button.** Z2 ships the primitive; Z3 wires the post-binding-create trigger; an explicit "Re-seed" button (force-clear cursor + dispatch) is a v0.2 polish if operators need it.

### Migrations / DB

- No new migrations. `last_scan_cursor` is an existing column (migration 0004); Z2 writes to it the same way scan() already does.

### Documentation

- **`IMPLEMENTATION-PLAN.md` §1.1** appends Z2 to the phase-a follow-up roster's status snapshot.
- **`docs/plan-appendix/phase-a-12-cutover-completion.md` (Z0)** already lists Z2 as the second PR of sub-wave 1 — no doc edit needed here; the scoping doc landed before this PR.
- **No `architecture.md` impact.** The `SourceAdapter` port gains an optional method; §10 (adapter boundaries) already covers extensibility via per-adapter capabilities.

## Phase-a follow-up — Z4 (Output channels)

The same partner cutover that surfaced G1 (Drive `makeDrive` stub) also exposed G5: the `OutputAdapter` interface, the `@opencoo/output-asana` package, and the `OutputChannelRegistry` class ALL existed in the repo — but `packages/cli/src/provision/production-composition.ts` never instantiated the registry. Heartbeat stored `output_channel_ids` on `agent_instances` (writable through the management UI), but at dispatch time there was no registry to deliver through in production. The daily-report-to-Asana path was 90% built and not wired. PR-Z4 closes the loop.

### Motivation

- G5 (`docs/plan-appendix/phase-a-12-cutover-completion.md`): `OutputChannelRegistry` never instantiated in production composition. Test fixtures wired the registry; production didn't.
- Partner cutover needed the Heartbeat daily report to land as a task in a specific Asana project (Estyl daily-ops). The package handled the write; nothing routed agent output to it.
- No CRUD surface for managing the channels. An operator could store `output_channel_ids` on the instance row, but couldn't create the underlying channel without a manual SQL INSERT.

### What shipped

- **Registry instantiation at the composition root.** `composeProductionFromEnv` now builds an `OutputChannelRegistry`, lazy-imports `@opencoo/output-asana`, wraps the resulting `OutputAdapter` via a new `outputAdapterToChannelAdapter` bridge, and registers it. The composition returns the registry + the per-adapter descriptor map; the CLI orchestrator threads both into `engine-self-operating.start({ outputChannels, outputChannelDescriptors })`. A missing OutputAdapter package logs `output_adapter.unavailable` and skips — boot-tolerance mirrors the source-adapter factory pattern.
- **Post-run delivery hook on `AgentDispatcher`.** After every successful agent run, the dispatcher iterates the instance's `output_channel_ids[]` bindings and calls `OutputChannelRegistry.deliver({bindings, delivery})` per binding. Q10 binding enforcement (THREAT-MODEL §3.5) is enforced INSIDE the registry — the dispatcher just supplies the binding set + payload. Per-binding failures are logged via the structured `output_channel.deliver` log line (status: success | failed, error: scrubbed); they do NOT flip `agent_runs.status` because the agent body already terminalised on success. `dryRun: true` (operator-issued one-shot) skips delivery so re-runs don't produce side effects.
- **New `output_channels` table.** Drizzle migration `0012_output_channels.sql` adds the operator-managed channel-row table: `(id, adapter_slug, name, config, credentials_id, enabled, created_at, updated_at)` with `UNIQUE (adapter_slug, name)` and FK to `credentials.id` (ON DELETE RESTRICT). The agent-instance binding (`output_channel_ids[]`) points at `output_channels.id` via `config.channel_id`; dangling references are tolerated (the bridge throws `OutputChannelLookupError`, the dispatcher logs + skips). Schema definition at `packages/shared/src/db/schema/output-channels.ts`.
- **CRUD admin-API at `/api/admin/output-channels`** — full matrix (`GET` list, `POST` create with credential encryption via `CredentialStore.write`, `PATCH` with mutually-exclusive `{enabled} | {config} | {credentials}` branches, `DELETE` with best-effort credential cleanup). All state-changing routes CSRF-gated + admin-team-gated via `makeGuardedApp`. Audit rows for every action: `output_channel.create`, `output_channel.update`, `output_channel.credentials_rotate`, `output_channel.delete` — metadata captures `(channel_id, adapter_slug, name, caller_username)`; for update the changed field NAMES (never values); credentials NEVER appear in audit metadata. UNIQUE violation maps to 409 via the existing `isPgUniqueViolation` narrower.
- **`/api/admin/adapters` extended** with `outputAdapters[]` alongside the existing `adapters[]`: each entry is `{slug, credentialSchema, channelConfigSchema}`. The schemas are JSON-Schema-shaped so the management UI renders the credential + channel-config form dynamically per architecture §10 (no hardcoded adapter UI).
- **UI: new Outputs tab.** Sidebar entry between Sources and LLM Policy. The route (`packages/ui/src/routes/Outputs.tsx`) mirrors `Sources.tsx`'s shape: list + `+ New output channel` modal + per-row drill-down. The modal (`NewOutputChannelModal.tsx`) auto-renders the credential + channel-config form from `/api/admin/adapters`. The detail modal (`OutputChannelDetail.tsx`) supports Enable/Disable + Delete with an inline confirmation step.
- **Asana production wiring.** `createAsanaFetchApi` (new in `packages/adapters/output-asana/`) is a fetch-backed `AsanaLikeApi` implementation that wraps `POST https://app.asana.com/api/1.0/tasks`. Error mapping: 429 → `AsanaApiHttpError` with `retryAfterSeconds`; 4xx/5xx → `AsanaApiHttpError`; network failure → `AsanaApiTransientError`. The access token NEVER appears in error messages — the wrapper builds the Authorization header internally; response body excerpts cap at 200 bytes. `asanaChannelConfigSchema` exports `{project_gid: string, assignee_gid?: string}` (Zod-strict). The composition's `mergeAsanaPayload` closure combines the channel's `project_gid` with the agent's emitted JSON output (title from `summary`, notes from JSON pretty-print).

### Threat-model alignment

- **§3.5 Q10 binding enforcement.** The `OutputChannelRegistry.deliver` cross-check between `delivery.adapterSlug` and the instance's `bindings[].adapter_slug` set survives — the dispatcher just hands the set + the delivery in. A prompt-injection attack on the agent cannot redirect delivery to a slug outside the instance's allow-list. The bridge's additional channel-row lookup (`channel_id` → `output_channels`) is a strict include-test: any failure mode (missing channel_id in the binding config, deleted channel row, disabled row) throws a `validation`-class error and DLQs.
- **§3.6 invariant 11 — credential bytes never leak.** The admin-API routes encrypt the operator-submitted credential payload via the existing `CredentialStore.write` BEFORE persisting any state. The audit-log writer records only `credentials_id` (uuid) — not the plaintext. The Asana fetch client builds the Authorization header internally and throws with a generic shape (`asana: <status> <text>`); the response body excerpt caps at 200 bytes and excludes request headers. Output adapter error messages flow through the existing `safeErrorMessage` scrubber on the dispatcher's log line.
- **§2 invariant 9 — no new feature env vars.** Every channel-config + credential lives in Postgres; no new `OPENCOO_*` env var was added. The output-adapter package list at the composition root is a TypeScript-level registry, not env.
- **§2 invariant 8 — append-only logs preserved.** The new `output_channels` table is full CRUD (operator config, not an audit surface), but the **audit log** (`admin_audit_log`) remains append-only — every CRUD action writes ONE row, never updates. The existing `opencoo/no-update-append-only` ESLint rule is unaffected.
- **CSRF + admin-team gate.** Every state-changing route is wrapped by the admin-api plugin's `makeGuardedApp` proxy — `verifyAdmin` always runs first, `requireCsrf` runs second. The 401-without-auth + 403-without-CSRF matrix is pinned in the new admin-api test suite.

### Tests

- **Composition test** (`packages/cli/tests/output-channels-registry.test.ts`, new): asserts `composeProductionFromEnv` returns an `OutputChannelRegistry` with `asana` registered, plus a descriptor map carrying the channel-config + credential JSON-Schema shapes the admin-API routes consume. PGlite-backed.
- **Dispatcher delivery test** (extends `packages/engine-self-operating/tests/scheduler/agent-dispatcher.test.ts`, +3 tests): seeds a heartbeat instance with `output_channel_ids = [{adapter_slug, config}]`; injects a `MockOutputChannelAdapter`; force-dispatches via the test seam; asserts `deliver` was called with the heartbeat output payload + the binding config. Two more tests pin (a) `dryRun: true` skips delivery, (b) one-binding failure doesn't block the next.
- **Bridge test** (`packages/engine-self-operating/tests/output-channels/bridge.test.ts`, new): pins (a) happy: `mergePayload` runs + the wrapped `OutputAdapter.write` is called with the resolved `credentialId`; (b) `OutputChannelMissingChannelIdError` on a binding with no `channel_id`; (c) `OutputChannelLookupError` on a missing row; (d) `OutputChannelDisabledError` on a disabled row.
- **Admin-API CRUD test** (`packages/engine-self-operating/tests/admin-api/output-channels.test.ts`, new): 14 assertions covering the full matrix — happy paths + 404/409/422/auth gates + credential encryption + audit-row content + `GET /api/admin/adapters` surfacing `outputAdapters[]`.
- **UI test** (`packages/ui/tests/unit/output-channel-detail.test.tsx`, new): 4 assertions — empty state, populated row, `+ New output channel` modal flow POSTing the right body, DELETE confirmation flow.

Per-package counts after Z4:
- `pnpm --filter @opencoo/output-asana test` → 22 passed
- `pnpm --filter @opencoo/engine-self-operating test` → 682 passed (was 670 pre-Z4: +12 = 11 admin-api + bridge + dispatcher)
- `pnpm --filter @opencoo/cli test` → 100 passed (was 99 pre-Z4: +1 composition wiring)
- `pnpm --filter @opencoo/ui test` → 254 passed (was 250 pre-Z4: +4)
- Repo-wide `pnpm test`: 2559 passed + 14 skipped (was ~2537 pre-Z4). Pre-existing EPIPE flake in `engine-ingestion/tests/start-webhook-mount.test.ts` unaffected (same 42 unhandled rejections both before + after Z4).

### Migration

- **New migration**: `packages/shared/drizzle/0012_output_channels.sql` (CREATE TABLE + UNIQUE + FK). Round-trips cleanly via `pnpm --filter @opencoo/shared db:check` (zero drift). Idempotent (Drizzle's journal-tracked migrator + auto-migrate at engine boot — PR-X1).
- **No destructive ops.** Pure CREATE.
- **Schema-ownership rule honored** (architecture §14.4): the pgTable lives in `packages/shared/src/db/schema/output-channels.ts`; engine-self-operating consumes it as a read-only schema import.

### IMPLEMENTATION-PLAN

- **§1.1 status snapshot** appended with Z4's scope summary (registry instantiation + CRUD routes + UI tab + migration + post-run delivery hook). The wave-end closeout will add the §1.2.22 wave-12 pointer; this PR doesn't pre-create that section.

---

## Phase-a follow-up — Z7 (host + Gitea bootstrap scripts)

Two manual sequences appeared in every partner-cutover walkthrough: a half-page of host hardening (Docker install + non-root user + sshd lockdown + UFW + fail2ban + unattended-upgrades) and a four-step Gitea bring-up (admin user via `gitea admin user create`, PAT mint via the tokens API, org create, team create + admin-membership). Each previously lived as a fragile heredoc sequence in the partner-private deployment journal; each had at least one step that silently dropped during a real cutover (the admin-team-membership step in particular, which left a permission gap the engine only noticed on its first wiki write). PR-Z7 codifies both as idempotent POSIX-ish bash scripts under `bin/`, each emitting one structured-JSON event per step plus a final summary line.

### Added — `bin/opencoo-bootstrap-host.sh`

- **9-step host hardening sequence:** distro detect (Debian 12+ / Ubuntu 22.04+), base package install (curl, ca-certificates, ufw, fail2ban, unattended-upgrades, jq, gnupg), Docker install via `get.docker.com` with a hello-world smoke test, `opencoo` user create (uid 1001, `docker` + `sudo` groups, locked password), optional admin SSH pubkey append to `/home/opencoo/.ssh/authorized_keys` (dedupe by exact line match), sshd lockdown drop-in at `/etc/ssh/sshd_config.d/99-opencoo.conf` (PermitRootLogin no / PasswordAuthentication no / KbdInteractiveAuthentication no) with `sshd -t` validation before reload, UFW configure (default deny in + allow out + allow 22/80/443 tcp + enable), fail2ban enable + start, unattended-upgrades configure (write `/etc/apt/apt.conf.d/20auto-upgrades` directly — idempotent two-line file).
- **Flags:** `--non-interactive` (sets `DEBIAN_FRONTEND=noninteractive` for unattended cloud-init use), `--admin-pubkey-file <path>` (required on first run if the operator wants to SSH back in after sshd reload locks out password auth).
- **Exit code contract:** 0 on success (steps_failed == 0), 1 on usage error, 2 on any step failure. Every step runs even if an earlier one fails so the final summary reports the full picture in one invocation.

### Added — `bin/opencoo-gitea-bootstrap.sh`

- **6-step Gitea bootstrap:** poll `/api/healthz` up to 60s for readiness, create admin user via `gitea admin user create` (host binary if present, else `docker exec` into the configured container — default `gitea`, override with `--container`), mint a PAT named `opencoo-bootstrap` with scopes `write:repository, write:organization, read:user, admin:org` via `POST /api/v1/users/<admin>/tokens`, create the org (`POST /api/v1/orgs` with `visibility=private`), create the `opencoo-admins` team in the org with `permission=owner` + `includes_all_repositories=true` + `can_create_org_repo=true` + the full unit set, and add the admin to the team via `PUT /api/v1/teams/<id>/members/<admin>` (the step the previous manual sequence had skipped).
- **Conflict handling:** every step tolerates the "already exists" shape — `user already exists` from the CLI, 422 with the matching message from POST endpoints. Team-id lookup falls back from the search endpoint to a full listing if the search shape is missing. PAT rotation: on 422 the existing token is deleted (by-name on Gitea ≥1.20, by-id fallback for older versions) and re-minted so the on-disk secret is always a usable plaintext (the `sha1` is only ever returned on creation; there's no recovery path otherwise).
- **Required env:** `OPENCOO_GITEA_ADMIN_PASSWORD`. If unset, the script generates a 32-char alphanumeric random one from `/dev/urandom` and persists it to `<secret-out-dir>/gitea-admin-password.txt` (mode 0600) next to the PAT.
- **Output paths:** PAT defaults to `./secrets/gitea-pat.txt` (configurable via `--secret-out`, mode 0644 so the engine container can read it via the standard `compose.yml` secrets mount).
- **Summary line** includes `admin`, `org`, `team_id`, `pat_file`, plus the same `steps_completed`/`steps_skipped`/`steps_failed` counters as the host script.

### Added — `bin/README.md`

Canonical 8-step partner-deployment order (cloud-init VM → SSH as root → copy pubkey → host bootstrap → re-SSH as `opencoo` → `docker compose up` → Gitea bootstrap → wire PAT into `.env`). Documents the JSON event schema, the idempotency expectation per script, and the failure modes worth knowing (sshd reload locks out password auth mid-script; PAT rotates on every run; host script defers swap / timezone / hostname to cloud-init metadata).

### Tests

- **`bin/tests/test-bootstrap-host-idempotent.sh`** — runs the host script twice inside a privileged `debian:12-slim` Docker container. Asserts: run 1 emits ≥3 `installed|configured` events (base packages + user create + sshd lockdown — the systemd-coupled steps degrade gracefully when systemd isn't PID 1, which it isn't in a test container; the live wave-end QA against a real VM is the canonical signal for those). Run 2: `install-base-packages`, `create-opencoo-user`, and `sshd-lockdown` all report `skipped`.
- **`bin/tests/test-gitea-bootstrap-idempotent.sh`** — spins up a throwaway `gitea/gitea:1.21` container on a random localhost port, runs the bootstrap script twice. Asserts: run 1 reports `created` for admin user + org + team, summary has a non-null `team_id` and a readable `pat_file` containing a non-empty PAT. Run 2 reports `exists` for admin user + org + team (no `created` status anywhere on the second pass).
- **Gating:** both tests are opt-in behind `RUN_SHELL_TESTS=1` — they pull a Docker image, take ~60–120s, and need the local Docker daemon, so they're inappropriate for the default vitest matrix. A dedicated CI job runs them. `CONVENTIONS.md §3` documents the convention.

### Threat-model alignment (§5 PR checklist)

- **No new env vars in the engine.** `OPENCOO_GITEA_ADMIN_PASSWORD` is read by the bootstrap script only, never by the engine; the engine reads the PAT path from its existing `.env`. THREAT-MODEL §2 invariant 9 (no new feature env vars) holds.
- **Secrets discipline preserved.** The PAT is the only durable secret the bootstrap writes; it lands at the operator-chosen path (default `./secrets/gitea-pat.txt`, 0644 so the engine container reads via bind mount). If the script generated the admin password, that lands at a sibling path with 0600. Neither secret is logged: the JSON event stream surfaces `pat_file` (the path) and `admin` (the username), never the plaintext.
- **sshd lockdown validated before reload.** `sshd -t` runs after the drop-in lands; a malformed config refuses to reload (preserves the running daemon, which is the operator's only escape hatch). The drop-in lives in `/etc/ssh/sshd_config.d/99-opencoo.conf` so it composes with the stock sshd_config rather than overwriting it.
- **UFW enables AFTER the SSH rule lands.** The script populates `allow 22/tcp` before issuing `ufw --force enable`, so an operator running this on a live SSH session keeps the session alive across the enable.
- **No new internet-facing routes.** Pure shell-scripted host config + one-shot HTTP calls to a freshly-started local Gitea container. Nothing new for the engine's `INTERNET_FACING_PATHS` enumeration.
- **Append-only invariant preserved.** PR-Z7 ships shell scripts only; no schema, migration, or `log.md` touch. THREAT-MODEL §2 invariant 8 (append-only) unaffected.

### Migrations / DB

- None. PR-Z7 is bash-only.

### Documentation

- **`bin/README.md` (NEW)** — canonical order + JSON event schema + failure-mode notes.
- **`CONVENTIONS.md §3` (testing conventions)** — adds the `RUN_SHELL_TESTS=1` convention for `bin/tests/*.sh`.
- **`IMPLEMENTATION-PLAN.md` §1.1** (separate maintainer touch on phase merge) — will record Z7's merge sha alongside the other Z-series PRs on phase rollup.
- **No `architecture.md` impact.** Operator-runbook codification; doesn't change any adapter / engine surface.

### Deferred (tracked outside Z7)

- **Hostname / timezone / swap configuration** — partner-specific decisions; cloud-init metadata is the right place. Not a host-bootstrap concern.
- **Multi-org Gitea bootstraps** — the script provisions one org per run by design (a single partner deployment, one org). Multi-tenant Gitea deployments are out of scope for v0.1; re-running with a different `<org-slug>` works but allocates a fresh PAT each time.
- **Caddy / Traefik install + cert provisioning** — the host script opens 80/443 but doesn't install a reverse proxy. The partner's `compose.yml` runs one as a sidecar; install is `docker compose up` from there.

## Phase-a follow-up — Z8 (polish bundle: `_FILE` in mcp-server + `REPOS` auto-derive + GHCR public + runbook gotchas)

Four small but consequential polish items captured during the partner cutover (wave-12 scoping doc §G9, G10, G11, G15). Each is too small to justify a standalone PR; bundling them keeps wave-12's cadence efficient while closing every operator-facing gotcha surfaced during real deployment.

### Changed (Z8) — `packages/gitea-wiki-mcp-server/`

- **`_FILE` env-suffix support (closes G9).** `src/config.ts` gains a `readWithFile(env, name)` helper modeled on `@opencoo/shared/engine-scaffold`'s implementation: when `<NAME>_FILE` is set, the file's contents are read and trailing newline runs stripped; otherwise the inline `<NAME>` env var is used. Applied to every secret-bearing var the server reads: `MCP_BEARER_TOKEN`, `GITEA_PAT`, `GITEA_WEBHOOK_SECRET`, `GITEA_OAUTH_CLIENT_SECRET`, `GITEA_ADMIN_TOKEN`. The non-secret config (URLs, host, port, log level, repos JSON) keeps its direct env reads — only secrets get the `_FILE` precedence, mirroring the engine's policy. The helper is synchronous on purpose (boot-time only, runs once) and throws on a missing `_FILE` path so an operator-typo'd Docker secret mount surfaces loud at boot instead of silently falling through to a stale inline value. Documented inline + tested with six unit assertions (file wins over inline, inline used when `_FILE` unset, empty `_FILE` falls through, missing path throws, both unset returns undefined, trailing newlines stripped).
- **`POST /refresh-all` endpoint (closes G10).** `src/http/server.ts` adds a new bearer-gated route alongside the existing `/refresh/:slug`. Body shape: `{ repos: [{ slug, owner, name?, default?, aggregator?, access_tag? }, ...] }`. The handler normalizes each entry (`name` defaults to `slug`; auto-promotes the first entry to `default: true` when none is flagged — operator convenience for the single-domain partner case), validates via the existing `validateRepos` refinement (rejects reserved slugs, multiple aggregators, duplicates), then calls the new `RepoRegistry.replace()` method to mutate the in-memory registry wholesale. Cloning of new repos is dispatched best-effort via `gitSync.ensureAllCloned()` — a clone failure logs but doesn't fail the request, since the periodic sync scheduler retries. The route is static-token-only: OAuth principals (ChatGPT / Claude.ai) are rejected with 403, since reshaping the registry is an engine-to-engine operation. The existing `/refresh/:slug` route remains untouched (additive change) — the raw-body capture's path-prefix guard `/refresh/` with the trailing slash means `/refresh-all` falls through to the standard JSON parser. `src/services/repo-registry.ts` gains the `replace(repos)` method, which re-enforces the constructor's invariants (exactly one default, unique slugs, non-empty) so a partial application can't drift the registry into an unrecoverable state.
- **Boot log update.** `[http] listening on ...` now lists the new path (`paths: /mcp, /refresh/:slug, /refresh-all, /health`).

### Changed (Z8) — `packages/engine-self-operating/`

- **Domain-create flow fires `/refresh-all` (G10 engine side).** `src/admin-api/routes/domains.ts` gains a `PingWikiMcpRefreshFn` optional callable, threaded through `admin-api/index.ts`. After the `domains` row commits + the audit row writes, the handler reads the FULL set of active (`disabled_at IS NULL`) domains and dispatches a fire-and-forget ping with the complete payload. The MCP server replaces wholesale (not appends), so partial payloads would drop existing repos — the SELECT is the load-bearing piece. The dispatch is `void refresh(repos).catch(() => undefined)` — no `await`, no error bubble. A slow or unreachable MCP server cannot stretch the 201 response time or fail domain creation. Composition root wires the real helper when BOTH `GITEA_WIKI_MCP_URL` and `MCP_BEARER_TOKEN` are set; partial config falls through to "skip the ping" (a partial setup would 401 or DNS-fail anyway, and the helper swallows both).
- **New module: `src/composition/wiki-mcp-refresh.ts`** — the `pingRefreshAll(config, repos, logger)` helper. POSTs to `${baseUrl}/refresh-all` with the bearer header + JSON body. Failure semantics: NEVER rejects. 5xx → logs `wiki_mcp_refresh.failed` at warn + resolves; 401 same; network blip / abort / DNS → logs `wiki_mcp_refresh.error` + resolves. Default 3-second abort timeout. Empty repos array → logs `wiki_mcp_refresh.skipped` + returns without dispatching.
- **`src/composition/env.ts`** — reads `GITEA_WIKI_MCP_URL` and `MCP_BEARER_TOKEN` via the existing `readWithFile` helper (Docker-secrets convention applies). Both are optional; when either is unset the composition root skips wiring `pingWikiMcpRefresh`. Mirrors the existing `giteaWikiMcpUrl` pattern used by the McpToolClient `/mcp` consumer.

### Changed (Z8) — `.github/workflows/release-image.yml`

- **GHCR images flipped to public on tag (closes G11).** After the engine-image push step, a `Make GHCR image public (best-effort)` step iterates `opencoo` + `opencoo-gitea-wiki-mcp-server` and calls `gh api -X PATCH /user/packages/container/<pkg> --field visibility=public`. The default `GITHUB_TOKEN` has `packages:write` (granted at the job level) but NOT `admin:packages`, which is what this endpoint requires. The step uses `secrets.GH_PAT_PACKAGES || secrets.GITHUB_TOKEN` so an operator who provisions a PAT with `admin:packages` (recommended one-time setup) gets the automatic flip; without the PAT, the step logs a clear warn line pointing at the manual one-shot `gh api -X PATCH ...` command. `set +e` ensures the step never fails the workflow regardless. Gate: `if: success() && github.ref_type == 'tag'` — main pushes (`:edge`) stay private (low-priority churn). The image-names line is the authoritative spelling: `opencoo` (engine), `opencoo-gitea-wiki-mcp-server` (mcp-server).

### Changed (Z8) — `docs/pilot-runbook.md`

- **New §11.3 "Runtime gotchas — partner cutover findings" (closes G15).** Three explicit callouts captured from the 2026-05-11 partner deployment journal:
  1. **Compose secrets file permissions.** Default `0440 root:root` on mounted secret files; engine runs as UID 1001 and gets `permission denied`. Workaround: `chmod 0644 secrets/*.txt` on the host (these files contain bearer tokens, not high-value secrets — operator should rotate them periodically).
  2. **`docker compose restart` doesn't reload `env_file`.** Changing the contents of an `env_file:` and then `docker compose restart` does NOT pick up the new values. Use `docker compose up -d --force-recreate <service>` instead.
  3. **`postgres-init.sh` permissions.** The init script mounted at `/docker-entrypoint-initdb.d/` must be mode `0755` (not `0700`) so the postgres user inside the container can read it. Symptom: postgres logs `permission denied` and falls back to an empty cluster.
- **§11.3 + §12 cross-reference for the GHCR-public flip.** §12 (Residual advisories) gains an item flagging that the workflow's `GITHUB_TOKEN` may lack `admin:packages` scope; the operator may need to set up `GH_PAT_PACKAGES` (a PAT with `admin:packages`) on the repo OR run a one-shot `gh api -X PATCH /user/packages/container/<pkg> --field visibility=public` to flip visibility manually.

### Tests

- **New file: `packages/gitea-wiki-mcp-server/tests/tools/refresh-all.test.ts`** — 13 tests covering the new endpoint + the `readWithFile` helper. `/refresh-all`: 200 happy (registry mutated, `ensureAllCloned` fired), auto-promote-first-to-default when no flag, `name` defaults to slug, 401 without bearer, 401 with wrong static-token bytes, 400 on missing body, 400 on reserved slug `company`, 400 on duplicate slug, 400 on multiple aggregators, and a regression assertion that `POST /refresh/:slug` still routes (returns 401 on missing signature — not 404). `readWithFile`: `_FILE` precedence, both-set → file wins, only-inline → inline returned, both-unset → undefined, empty `_FILE` path falls through, non-existent `_FILE` path throws.
- **New file: `packages/engine-self-operating/tests/composition/wiki-mcp-refresh.test.ts`** — 7 tests pinning `pingRefreshAll`'s fire-and-forget contract: happy POST (URL + headers + body), trailing-slash baseUrl normalisation, empty-repos skip (no fetch), 5xx resolves, 401 resolves, network failure resolves, abort/timeout resolves.
- **`packages/engine-self-operating/tests/admin-api/_fixture.ts`** gains a `MockWikiMcpRefresh` class threaded through the fixture; `wikiMcpRefresh.calls` records every dispatch and `nextError` simulates failure.
- **`packages/engine-self-operating/tests/admin-api/domains-create.test.ts`** adds two new tests inside a `/refresh-all ping` describe block: (1) ping dispatched with the full active-domains set after a commit (pre-existing domain row visible in the dispatched payload, proving the route reads the WHOLE table, not just the new row), (2) the route returns 201 even when the ping throws (fire-and-forget contract). `pnpm --filter gitea-wiki-mcp-server test` → 98 passed (delta +13). `pnpm --filter @opencoo/engine-self-operating test` → 670 passed + 5 skipped (delta +9 over baseline pre-Z8).

### Threat-model alignment (§5 PR checklist)

- **No new env vars on the feature path** — `GITEA_WIKI_MCP_URL` is infrastructure config (per-deployment topology, like `MCP_BASE_URL` already is). `MCP_BEARER_TOKEN` is already in scope. THREAT-MODEL §2 invariant 9 (no new feature env vars) holds; this is a co-deployment knob.
- **`/refresh-all` is bearer-gated AND static-only.** OAuth principals (ChatGPT / Claude.ai users) get a 403 — reshaping the registry is engine-to-engine, never user-facing. Without bearer the route returns 401 (same WWW-Authenticate shape as `/mcp`).
- **No PAT / secret bytes in audit-log metadata, body, or stderr.** The `_refresh-all`-dispatch warn lines log slugs only — never bearer bytes, never URLs containing tokens. The `wiki_mcp_refresh.error` log emits `err.name` (e.g. `"AbortError"`), never `err.message` (which could contain the URL).
- **Append-only invariant preserved.** Z8 doesn't touch any schema, migration, or log path. `redaction_events`, `admin_audit_log`, `log.md` invariants unchanged (THREAT-MODEL §2 invariant 8).
- **CredentialStore-only sourcing preserved.** The `/refresh-all` body carries no credentials. The MCP server's bearer is read from env (with `_FILE` precedence); the engine carries the matching token in memory only, never persists it.

### Migrations / DB

- No new migrations. Z8 is config-loader + HTTP-route + workflow + docs changes only.

### Documentation

- **`docs/pilot-runbook.md` §11.3** — new "Runtime gotchas — partner cutover findings" subsection (compose secrets mode, env_file requires --force-recreate, postgres-init.sh mode).
- **`docs/pilot-runbook.md` §12** — new residual advisory for the GHCR-public flip noting the `admin:packages` PAT may be needed.
- **`IMPLEMENTATION-PLAN.md` §1.1** — Z8 will be added to the phase-a follow-up roster's status snapshot post-merge (matching the Z1 pattern).
- **`docs/plan-appendix/phase-a-12-cutover-completion.md` (Z0)** — Z8 is listed as the polish bundle in sub-wave 3; no doc edit needed here.
- **No `architecture.md` impact.** Z8 doesn't touch any product-surface architecture pin.

### Deferred (tracked outside Z8)

- **Branch / ref tracking in `/refresh-all`.** The body accepts a `branch` key silently ignored — the MCP server tracks remote HEAD via simple-git, not a pinned ref. If a partner needs branch pinning (e.g. for staging-vs-prod wiki repos), this becomes a v0.2 follow-up.
- **Worldview seed file from Z5.** The brief mentions seeding `worldview.md` from Z5 before the `/refresh-all` dispatch. Z5 hasn't landed yet; when it does, the seed list grows but the dispatch site (after audit-log write) is unchanged.
- **`PROVENANCE` / image signing for the GHCR-public flip path.** PR-X4 (deferred) tracks cosign + SBOM publication; visibility-flip is orthogonal.

## Phase-a follow-up — Z3 (Scanner cron + Scan-now)

The same partner cutover that surfaced Z1 (Drive client wiring) also surfaced three distinct gaps in the scanner side of the ingestion engine that, taken together, made every polling-mode binding sit forever empty: **G3** — no code anywhere registered a BullMQ repeat-job for the `ingestion.scanner` queue, so Drive + n8n bindings never ticked (verified live: `bull:ingestion.scanner:repeat` did not exist in Redis on the partner host); **G6** — the admin-API `POST /api/admin/source-bindings` handler INSERTed the binding row + audit row and returned 201, but with no `ingestion.scanner` job enqueued, a freshly-bound Drive folder waited for the next 4h cron tick (which never came, per G3); **G8** — PR-R3 had added an on-demand "Run now" surface for the three scheduled agents (heartbeat / lint / surfacer) but the scanner had no equivalent admin-API verb, so the operator had to shell into the box and add a BullMQ job manually to verify a binding worked. PR-Z3 closes all three in one PR because they share the same `ingestion.scanner` Queue handle: the orchestrator now opens it once, registers the cron, and threads it through to both the source-bindings POST handler (for the initial-scan trigger) and a new `:id/scan-now` endpoint (for on-demand re-scans).

### Changed (Z3) — `packages/engine-ingestion/src/workers/production-context.ts`

- **Two new exported constants — `SCANNER_REPEAT_KEY` (`"ingestion.scanner.tick"`) and `SCANNER_CRON_DEFAULT` (`"0 */4 * * *"`).** The first is the stable BullMQ `jobId` used to dedupe the repeat-job across engine restarts (BullMQ keys repeatables by `(queue, name, pattern, tz, jobId)`); without a stable jobId, a restart would stack duplicates and the scanner would fire every 4h × N-restarts. The second is the default cadence per architecture.md §9.1 (Ingestion Scanner cadence). Both are re-exported from `packages/engine-ingestion/src/index.ts` so the CLI composition test and downstream runbook references can pin against the same labels.
- **`composeProductionWorkerContext({scannerCronPattern, registerScannerCronFn})` — two new optional inputs.** `scannerCronPattern` accepts the operator's `OPENCOO_SCANNER_CRON` env override (falls back to `SCANNER_CRON_DEFAULT`). `registerScannerCronFn` is a test seam that bypasses BullMQ's Lua-scripted repeat path (which hangs on ioredis-mock — the same limitation the AgentDispatcher tests document at `agent-dispatcher.ts:104`); production passes `undefined` and the engine uses the real `webhookScannerQueue.add(...)` path.
- **Scanner cron registration call.** After the `webhookScannerQueue` is constructed, the composition runs `webhookScannerQueue.add(SCANNER_REPEAT_KEY, {}, { jobId: SCANNER_REPEAT_KEY, repeat: { pattern: scannerCronPattern, tz: "UTC", immediately: false }, removeOnComplete: 100, removeOnFail: 1000 })`. Pinned to `tz: "UTC"` to mirror the AgentDispatcher's repeat pattern (`agent-dispatcher.ts:539`) — without this, BullMQ resolves the cron against the host's local timezone and schedules drift on non-UTC dev hosts (developer Macs, bare-metal Linux deploys). `immediately: false` prevents a boot-time burst (the scanner runs on the cron, not on engine start). The whole call is wrapped in a try/catch that converts failure to a `scanner.cron_register_failed` warn log — best-effort, so a transient Redis blip during boot doesn't crash the engine; the webhook fast-path and on-demand "Scan now" still work without the cron backstop.

### Changed (Z3) — `packages/cli/src/provision/production-composition.ts`

- **Reads `OPENCOO_SCANNER_CRON` via the existing `readWithFile` helper** (same Docker-secrets `_FILE` convention as every other env in the composition root) and threads it through to `composeProductionWorkerContext({scannerCronPattern})`. Per the file-header note in `production-context.ts`, this is INFRASTRUCTURE config (cron cadence, not feature behaviour), so THREAT-MODEL §2 invariant 9 (no feature env vars) does not apply; the runbook can document the override and operators can dial frequency without a code change.
- **Exposes `scannerQueue` on `ProductionCompositionResult`** — the SAME BullMQ Queue instance the workers consume (read from `workerContext.webhookScannerQueue`, defensive-throw if undefined). The orchestrator threads it into self-op's `start({scannerQueue})` so the admin-API source-bindings POST handler + `:id/scan-now` route operate on the same Queue handle (not a parallel one opened against the same Redis name — BullMQ would dedupe by name anyway, but sharing the instance keeps shutdown ordering clean and matches the `forgetJobEnqueuer` shape).
- **`registerScannerCronFn` test seam** added to `ComposeProductionArgs` and forwarded into `composeProductionWorkerContext` so the CLI-level composition test can record the cron registration call without hitting BullMQ.

### Changed (Z3) — `packages/cli/src/commands/serve.ts` + `packages/engine-self-operating/src/start.ts` + `packages/engine-self-operating/src/composition/server-factory.ts` + `packages/engine-self-operating/src/admin-api/index.ts`

- **`ServeStartFactory` + `ServeIngestionPreflightResult` + `EngineStartFn` + `ProductionServerFactoryArgs.ingestionQueue` + `RegisterAdminApiArgs.ingestionQueue` + `RegisterSourceBindingsRoutesArgs.ingestionQueue` — all widened with an optional `add(...)` method.** The pre-Z3 shape was read-only (`getJobCounts` only — used for DLQ depth probing in the GET binding-list route). The new optional `add` is what the POST handler + scan-now endpoint call to enqueue scans. Boot-tolerant: when `add` is undefined (composition didn't wire it — same pattern as `deleteCap` / `forgetJobEnqueuer`), the source-bindings POST silently skips the initial-scan enqueue (binding still creates cleanly) and `:id/scan-now` returns 503.
- **The orchestrator (`serve.ts:runServe`) threads `preflight.scannerQueue` → `startFactory({scannerQueue})` → `defaultStartFactory(...) → composeStartedEngineWithBundle({scannerQueue}) → start({ingestionQueue: scannerQueue})`.** Five hops, each typed `unknown` at the cross-engine seam (per the `no-cross-engine-import` ESLint boundary rule); the engine narrows back to the structural shape at consumption. When preflight returned null (composition failure — missing GITEA_PAT / ENCRYPTION_KEY / etc.), `scannerQueue` is `undefined` all the way through and the admin-API returns 503 on `:id/scan-now` (composition-incomplete).

### Changed (Z3) — `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts`

- **Post-binding-create initial-scan enqueue (closes G6).** After the binding row INSERT + audit row write + 201 response is computed, the handler enqueues `args.ingestionQueue.add("post-create-scan", {}, { jobId: \`post-create-scan-${bindingId}\`, ... })` IF `args.ingestionQueue?.add !== undefined`. Best-effort: a transport failure logs `binding_create.initial_scan_enqueue_failed` and continues — the binding row already committed, the operator already saw 201, the next 4h cron tick still picks it up.
- **New `POST /api/admin/source-bindings/:id/scan-now` route (closes G8).** Mirrors the existing PATCH/DELETE/forget pattern on the same file: CSRF-gated (via `requireCsrf` preHandler), admin-team-gated (via the `verifyAdmin` wrapper in `index.ts`), audit-row-emitting. Validates `:id` as UUID (400 on malformed), verifies the binding exists (404) AND is enabled (409 `binding_disabled`), generates a unique `jobId: \`scan-now-${id}-${Date.now()}\`` so back-to-back operator clicks each fire (no dedupe collision), writes an `audit-row source_binding.scan_now` BEFORE the enqueue (audit-before-side-effect invariant — a partial enqueue still leaves a forensic trail), then enqueues `scan-now` job + returns 202 `{enqueued: true, jobId}`. On enqueue throw: 500 + `enqueue_failed` (audit row already exists; operator retries idempotently). On composition-incomplete: 503 + `scanner_queue_unavailable`.
- **No rate-limit in v0.1** — operators iterate fast when binding a new source, the enqueue is cheap (marker job; the worker dedupes downstream), and a per-binding cooldown is parked at v0.2 per the wave-12 scoping doc's "Out of scope" §. The UI's 3-second client-side button-disable window after a successful click is the only anti-spam protection.

### Changed (Z3) — `packages/engine-self-operating/src/admin-api/audit-log.ts`

- **`AUDIT_LOG_ACTIONS` array gains `"source_binding.scan_now"`.** Metadata shape: `{binding_id, caller_username}` ONLY — no payload (the URL param is the binding UUID + the body is empty) so there's no operator-supplied freeform text to smuggle (THREAT-MODEL §3.13). The row is written BEFORE the BullMQ enqueue (audit-before-side-effect invariant); operators correlate via the (`caller_username`, `binding_id`, `created_at`) tuple, same pattern as `agent.dispatch_now` (PR-R3).

### Changed (Z3) — `packages/ui/src/components/SourceBindingDetail.tsx` + locales

- **New "Scan now" button next to Edit / Disable / Forget / Delete in the Sources row drill-down modal.** Disabled client-side when `binding.enabled === false` (the server returns 409, but disabling client-side gives the operator a clear affordance — they pick "Enable" first instead of firing a fail-known click). Disabled for `SCAN_NOW_DISABLE_MS` (3 seconds) after a successful click to prevent operator-spam (server doesn't rate-limit yet — v0.2 follow-up). Success flashes a `--healthy`-toned `GlyphFilledDisc` + i18n string ("Scan queued — see the Activity tab.") via the same `COPY_FEEDBACK_STYLE` pattern the copy-URL feedback already uses.
- **Error mapping:** 409 `binding_disabled` → "Enable the binding before queuing a scan." (operator picks Enable instead of retrying); 503 `scanner_queue_unavailable` → "Scanner queue is not wired in this deployment — check engine logs." (composition-incomplete signal); 5xx / network → routed through the existing `mapActionError` machinery (same generic copy as PATCH/DELETE 5xx — the recovery action is the same regardless of which mutating verb hit the server).
- **i18n keys (en + pl):** `sources.detail.actions.scanNow`, `sources.detail.scanNow.success`, `sources.detail.scanNow.disabled`, `sources.detail.errors.scanNowFailed`, `sources.detail.errors.scanNowUnavailable`. Polish locale mirrors English literally (pl.json is currently a placeholder file — same convention as the other Sources-detail strings).

### Tests

- **Composition test: `packages/cli/tests/scanner-cron-registration.test.ts` (NEW, 4 tests).** Pins (1) exactly one cron registered with `SCANNER_REPEAT_KEY` + `SCANNER_CRON_DEFAULT` when `OPENCOO_SCANNER_CRON` is unset; (2) operator's env override reaches the registration call (not the default); (3) the composition exposes a writable `scannerQueue` handle that's the SAME instance as `workerContext.webhookScannerQueue` (single shared handle — verified by `Object.is` identity); (4) composition succeeds even when the cron registration call throws (best-effort — the webhook fast-path + on-demand "Scan now" still work without the cron backstop).
- **Worker-context test: `packages/engine-ingestion/tests/workers/production-context.test.ts` (extended, +3 tests).** Pins the same three invariants at the engine-ingestion direct-call level (closes the seam between the engine boundary and the CLI composition root).
- **Admin-API test: `packages/engine-self-operating/tests/admin-api/source-binding-scan-now.test.ts` (NEW, 14 tests).** Pins the scan-now endpoint matrix: 202 happy + body shape, audit row written with correct metadata, 400 on invalid UUID, 404 on missing binding, 409 on disabled binding (no audit row + no enqueue call — bail before side effect), 401 without auth, 403 without CSRF, 503 when scanner queue unwired (no audit row — composition-gate fires before audit), 500 + audit-before-enqueue invariant on a queue.add throw (audit row exists; operator has a forensic trail), distinct jobIds across back-to-back clicks. Additionally pins the post-binding-create path (closes G6): four tests covering (a) ingestionQueue.add called with `post-create-scan` + correct jobId, (b) binding creates cleanly when ingestionQueue is undefined, (c) binding creates even when ingestionQueue.add throws (best-effort), (d) no enqueue on a 422-failed binding-create.
- **UI test: `packages/ui/tests/unit/source-binding-detail-scan-now.test.tsx` (NEW, 8 tests).** Pins the button render, the disabled-binding client-side gate, the POST endpoint URL + method, the success toast + 3s cooldown window via vitest fake timers, the 409/503/5xx error-copy mapping, and the error-path re-enable-immediately (no cooldown on error so the operator can retry).
- **Existing tests stay green.** `pnpm --filter @opencoo/cli test` reports 103 passed (delta: +4 for the scanner-cron file). `pnpm --filter @opencoo/engine-ingestion test` reports 366 passed + 3 skipped (delta: +3). `pnpm --filter @opencoo/engine-self-operating test` reports 675 passed + 5 skipped (delta: +14). `pnpm --filter @opencoo/ui test` reports 258 passed (delta: +8). `pnpm test` at root reports 2558 passed + 14 skipped (delta: +21 net, after subtracting the Z1 fixup test count baseline). The pre-existing EPIPE unhandled-rejection flake in `engine-ingestion/tests/start-webhook-mount.test.ts` is unchanged (verified to predate this PR — same 42 errors on `main`).

### Threat-model alignment (§5 PR checklist)

- **New admin-API write surface: `POST /api/admin/source-bindings/:id/scan-now`.** CSRF-gated (via `requireCsrf` preHandler, identical to PATCH/DELETE/forget on the same route file). Admin-team-gated (via `verifyAdmin` wrapper applied uniformly at `index.ts:makeGuardedApp`). Audit-row-emitting (`source_binding.scan_now`, metadata = `{binding_id, caller_username}` only — no operator-supplied freeform text per THREAT-MODEL §3.13). Audit row written BEFORE the BullMQ enqueue (audit-before-side-effect invariant — partial enqueue still leaves forensic trail). Idempotent at the audit level — back-to-back clicks each write a row with the same binding_id + caller_username + distinct created_at, so the trail accurately reflects how many times the operator fired.
- **No new credential surface.** The scanner already has access to source credentials via the existing `CredentialStore` (the scanner pipeline calls `adapter.scan(...)` which internally reads via `credentialStore.read(binding.credentials_id)`). The scan-now route enqueues a marker job; the worker resolves credentials at scan time, same path as the cron tick. THREAT-MODEL §3.6 invariant 11 (credentials come from the store by id, never inline) holds — the route never touches credential bytes.
- **No new env vars (with one narrow exception).** `OPENCOO_SCANNER_CRON` is INFRASTRUCTURE config (cron cadence, not feature behaviour) and the no-feature-env-vars invariant (THREAT-MODEL §2 invariant 9) explicitly excludes infrastructure knobs (same carve-out as `DATABASE_URL` / `REDIS_URL` / `GITEA_URL` / `GITEA_PAT` / `ENCRYPTION_KEY` / `MCP_BEARER_TOKEN`). The variable follows the same Docker-secrets `_FILE` convention as the rest of the boot env. Default is `0 */4 * * *` (every 4h UTC) per architecture.md §9.1 — operators don't need to set it.
- **No new admin-team-bypass.** The route doesn't open any path that an unauthenticated request can reach. The composition-incomplete 503 fires AFTER both gates (admin-team + CSRF) have already passed.
- **No new free-form text into audit metadata.** The route has no body to smuggle (URL param is UUID + body is empty), so the metadata cannot contain operator-supplied text. Same property the agents-dispatch route has under PR-R3's matching audit shape.
- **Append-only invariant preserved.** Z3 doesn't UPDATE or DELETE any audit row. The new `source_binding.scan_now` action is INSERTed only, matching every other action in the `AUDIT_LOG_ACTIONS` table.
- **No new transitive deps.** Z3 reuses the existing BullMQ Queue handle the workers already constructed; no `package.json` `dependencies` edits.

### Image size impact

- **Zero.** Z3 is composition-root + admin-API route + UI button code only. No new packages, no new bundle weight.

### Migrations / DB

- No new migrations. The `source_binding.scan_now` action joins the existing `admin_audit_log.action` `text` column — no schema change required.

### Documentation

- **`IMPLEMENTATION-PLAN.md` §1.1** appends Z3's merge sha + URL to the phase-a follow-up roster's status snapshot.
- **`docs/plan-appendix/phase-a-12-cutover-completion.md` (Z0)** lists Z3 as the third PR of sub-wave 1 — no doc edit needed here, the scoping doc landed before this PR.
- **No `architecture.md` impact.** Z3 implements the production half of the existing scanner-cron + admin-API surfaces; the architecture spec already documents the 4h cron cadence (§9.1) and the admin-API admin-team gating (§7.3).

### Deferred (tracked outside Z3)

- **Per-binding scan-now cooldown / rate-limit.** v0.2 follow-up per the wave-12 scoping doc's "Out of scope" §. The UI's 3-second client-side button-disable is the only anti-spam protection in v0.1.
- **Backpressure / queue-depth probe before enqueue.** A misbehaving operator could click "Scan now" against 100 bindings sequentially and saturate the scanner queue. v0.2 could probe `queue.getJobCounts("waiting")` and refuse with 429 when above a threshold.
- **`scanNowState` carrying the jobId for SSE deep-link.** Currently the success toast says "see the Activity tab"; an enhancement would deep-link the toast to the specific run row. Deferred until the Activity tab grows a per-job filter.
- **Per-binding scoping of the scanner payload.** Both the post-create initial-scan and the `:id/scan-now` route enqueue `ingestion.scanner` jobs with an empty `{}` payload, and the scanner worker enumerates ALL enabled bindings per tick rather than scoping to a single `bindingId`. The dedupe pipeline (cursor + `source_doc_id`) keeps this correct — extra bindings re-scanned by the same tick are no-ops — but it is mildly confusing operator UX (the "Scan now" button on binding A causes binding B to scan too). Threading `bindingId` through `scanner.add(...)` + narrowing the worker's SELECT is its own refactor; filed as Z10 / phase-b candidate. Inline comments at both enqueue sites point at this entry.

---

_Drafted from `IMPLEMENTATION-PLAN.md` §1.2.1–§1.2.21 + per-PR `gh pr view` body residuals. Maintainer to edit before the `0.1.0` final tag cut (the `0.1.0-a` rollup has already shipped — see the §1.1 status snapshot)._

---

## Wave-13 closeout — agent-output pipeline (phase-a appendix #13)

Four PRs (W0–W3) shipped 2026-05-12 closing the next layer of partner-cutover gaps surfaced during wave-12 verification: worldview compiler had zero production callers, no UI/admin-API to bind output channels to agent_instances, output-webhook adapter not registered in composition. After wave-13, opencoo can autonomously produce + deliver a useful daily report. Full scoping in `docs/plan-appendix/phase-a-13-agent-output-pipeline.md`. Main closes at `7662ce0`.

### Added

- **`compileDomainWorldview` wired into production** (PR-W1 `f5f9471` / #119). New BullMQ worker on `selfop.worldview.compile` consumes per-domain trigger jobs, reads all domain pages except `worldview.md` via the wikiAdapter, calls the compiler, writes via `wikiWrite` with `Worldview-Recompile: <triggerType>` git trailer. New trigger pipeline walks per-domain commits via `wiki-gitea.listRecentCommits` (NEW helper), parses `Worldview-Impact: <level>` trailers, debounces per architecture.md §9.4 (high=15min from first-high, medium=≥3 OR ≥24h, low never triggers alone). Safety-net cron `0 3 * * *` UTC registered in production-context (env override `OPENCOO_WORLDVIEW_SAFETY_NET_CRON`). `WorldviewOverflowError` returns `{status: 'overflow'}` rather than re-throwing — BullMQ marks the job completed-with-overflow so retries don't loop on a non-retriable failure. Architectural note: the worker + trigger live in `engine-self-operating` (not `engine-ingestion`) because `compileDomainWorldview` lives in self-operating and the `no-cross-engine-import` ESLint rule blocks ingestion → self-operating imports; the cross-engine seam is the CLI composition root.
- **`POST /api/admin/domains/:slug/recompile-worldview`** (PR-W1). CSRF + admin-team gated + audit-before-enqueue + 503 gate when queue undefined + 409 on disabled domain. Y1 lesson applied: holds `queue` reference, calls `queue.add()` as method. Audit row `domain.recompile_worldview` added to allow-list.
- **"Recompile worldview" button on Domain detail UI** (PR-W1). Mirrors Z3's "Scan now" pattern: 3s cooldown + healthy-toned success toast + scrubbed error toast. Disabled when domain has `disabled_at` set. EN/PL locale keys.
- **`PATCH /api/admin/agent-instances/:id`** (PR-W2 `fb75819` / #118). Discriminated-union body: `{output_channel_ids: string[]}` | `{enabled: boolean}` | `{schedule_cron: string}`. Mixed body → 400 `mixed_patch_body`; dangling UUIDs → 422 `unknown_output_channel_ids`; duplicate UUIDs → 422 `duplicate_output_channel_ids` (strict — operator awareness, not silent dedupe); cron validated via cron-parser. Three new audit actions (`agent_instance.bind_outputs`, `.set_enabled`, `.set_schedule`).
- **`GET /api/admin/agent-instances`** (PR-W2). Read-only list, 200-row cap.
- **New Agents UI tab + `AgentInstanceDetail.tsx` drill-down** (PR-W2). Mirrors `SourceBindingDetail.tsx`: multi-select for output channels (fetched from `/api/admin/output-channels`), enable/disable, schedule editor. 3s cooldown + toast pattern.
- **Per-(agent, adapter) output transformers** (PR-W2). New `packages/cli/src/provision/output-transformers.ts` exports `mergePayloadFor({agentSlug, adapterSlug, agentOutput, channelConfig})` + 7 first-party transformers (heartbeat/lint/surfacer × asana/webhook) + 2 generic fallbacks. **Heartbeat → Asana** emits `html_notes` (NOT `notes` — Asana doesn't render markdown) following Asana's restricted tag whitelist: `<body>` root + per-alert `<h2>` + `<p>` + `<ul><li>` as siblings (Asana rejects nested headers inside `<li>`). HTML-entity escaping on all agent bytes; 32 KB cap with sibling-boundary truncation (no half-tags or half-entities — `<p>(truncated…)</p>` marker appended when triggered). `agentSlug` threaded through `OutputChannelDelivery` → `OutputChannelDeliverArgs` → `MergePayload` (backward-compat optional).
- **`output-asana` `htmlNotes` field** (PR-W2). New optional field on `AsanaTaskPayload`; mutually exclusive with `notes` (Zod `.refine` rejects both — would 400 from Asana anyway). Adapter passes `htmlNotes` through to `html_notes` on `POST /tasks`.
- **`output-webhook` registered in production composition** (PR-W3 `7662ce0` / #120). Lazy-imports `@opencoo/output-webhook` + registers a custom `OutputChannelAdapter` wrapper that constructs a per-delivery `WebhookOutputAdapter` from each channel row's `config` (`targetUrl` + optional `headers` + optional `retryPolicy`) and `credentials_id` (HMAC signing secret). Operator-facing `webhookChannelConfigSchema` (Zod) + `WEBHOOK_CHANNEL_CONFIG_JSON_SCHEMA` (UI form) distinct from the package's `webhookOutputBindingConfigSchema` — credentials route through `output_channels.credentials_id` (same pattern as Asana PAT). `OUTPUT_ADAPTER_SLUGS` widened to `["asana", "webhook"]`.
- **`OutputAdapterDescriptor.channelConfigJsonSchema.properties` type widened** (PR-W3) to support object-typed entries with `properties` / `additionalProperties` / `minimum` / `maximum` — needed so `WEBHOOK_CHANNEL_CONFIG_JSON_SCHEMA` can expose `headers` (object with operator-supplied HTTP headers, Authorization forbidden) and `retryPolicy` (object with `maxAttempts` 1–10 + `baseDelayMs` 100–30000). UI's `NewOutputChannelModal` skips the `<input>` widget for object-typed entries (description-only documentation); server-side Zod still enforces shape.
- **Validation-class error throws in `buildWebhookChannelAdapter`** (PR-W3). Replaced plain `Error` throws on missing `channel_id` / null lookup / disabled channel / invalid config with `OutputChannelMissingChannelIdError` / `OutputChannelLookupError` / `OutputChannelDisabledError` / `ValidationError`. The harness's `classifyError` treats `OpencooError` with `errorClass: 'validation'` as non-retriable → DLQ instead of retry-loop.
- **`docs/pilot-runbook.md` §13** (PR-W3). Operator-facing n8n wiring guide: outgoing request shape (HMAC-SHA256 signature, deterministic delivery ID, retry policy), n8n Webhook trigger + HMAC verification setup, opencoo-side channel-create + agent binding flow, rotation procedure.
- **W0 scoping doc** (PR-W0 `20ab223` / #117). `docs/plan-appendix/phase-a-13-agent-output-pipeline.md` — gap inventory + PR roster + Asana adapter quirks (load-bearing for W2) + worldview cadence (load-bearing for W1) + deployment steps.

### Deferred (tracked outside wave-13)

- **`worldview_compiles` audit table.** Rely on the `Worldview-Recompile:` git trailer + BullMQ worker-completion log. Promote to a table if operators ask for a "last 30 days of recompiles" panel.
- **Cross-domain `company.md` aggregator.** Architecture.md §9.4 mentions a downstream compile of per-domain worldviews into a `company.md` on the aggregator domain. v0.2 — today partners run a single domain.
- **Heartbeat delivery transactionality.** Best-effort per Z4: a failed delivery still leaves `agent_runs.status=success`. v0.2 may add per-binding retry config if operators want stricter semantics.
- **`output-slack` / `output-email` adapters.** Packages don't exist. The W3 pattern is the template for adding either; v0.2 once an adopter asks.
- **Per-channel formatting templates** (operator-edited Mustache/Liquid for the agent output → adapter payload mapping). v0.1 ships code-owned first-party transformers; operators can fork the package if they want a different shape. v0.2 if real demand surfaces.
- **Surface server `worldview_queue_unavailable` reason in the recompile-worldview UI toast.** `fetchAdmin` discards 5xx bodies; the generic `domains.detail.errors.transient` copy fires regardless. Pinned in the route's docstring; structured server reason is operator-visible in logs.
- **Delivery-ID stability across credential rotation.** `output-webhook`'s `deriveDeliveryId` uses `credentialId + payload-hash`, so rotating the channel's signing secret changes the delivery ID. Downstream n8n dedupe tables should expire entries on a TTL; documented in runbook §13.

