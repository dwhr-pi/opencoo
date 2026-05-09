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
- **SSE 401 terminal state** — Q1's reconnect loop currently retries on 401 even though the PAT is durably bad. Tracked as task #47.
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
- **Source forget impact preview** (R7, `612b36e` / #89). New shared planner `packages/shared/src/forget/planner.ts` — pure read-only SQL classifier over `page_citations` returning `{ pagesRecompiled[], pagesDeleted[], citationsRemoved, domainSlug }` (sorted output, single CTE, no N+1). New `POST /api/admin/source-bindings/:id/forget?dryRun={0|1}` (CSRF + admin-auth). Dry-run is read-only (no enqueue, no audit row). Execute path: cap-preflight → cap-reserve → audit COUNTS-only → enqueue. 409 `daily_cap_exceeded` with current `dailyDeleteCapState`. New `ImpactPreviewDialog` UI: counts summary → deleted-paths list (`--wiki` Wiki Teal on path badges — one of the few approved `--wiki` uses) → checkbox-gated `--alert`-accented Confirm. **Closes PRD §5 criterion 9 (amber → green).** Closes architecture.md §6.4 page-citation impact-preview commitment.
  - **Wave-11 W1 follow-up — R7 production wiring** (PR-W1, phase-a appendix #11). Wave-end Chrome QA on 2026-05-09 surfaced that `POST /api/admin/source-bindings/:id/forget` returned 503 `composition_incomplete` against the design-partner deployment ("Nie udało się załadować wpływu" on dialog open). R7 had wired the route's expectation of injected `deleteCap` + `forgetJobEnqueuer` and the unit-test fixtures supplied both, but `cli/src/provision/production-composition.ts` did not. PR-W1 hoists `InMemoryDeleteCap` construction to the composition root so the SAME instance the compiler workers reserve against also feeds the route's `peek/reserve` (single-process v0.1 shape per architecture §16); adds a shared `createForgetJobEnqueuer` (`packages/shared/src/forget/enqueue.ts`) that fans the planner output into per-page jobs on two new BullMQ queues (`wiki.recompile` + `wiki.delete`); threads both through `cli/serve.ts` → `engine-self-operating.start({deleteCap, forgetJobEnqueuer})` → `productionServerFactory` → `registerAdminApi`. The consumer worker for the new queues lands in a follow-up PR; v0.1 ships the producer side only (jobs sit on the BullMQ backlog, visible in the existing pipelines view, drainable via standard BullMQ tooling). **PRD §5 criterion 9 is now actually green (was effectively amber post-R7-merge until W1 landed).**

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

- **Chrome QA wave-end walkthrough** outstanding — every R-PR ships its own before/after pair, but the integrated flow (rename a domain → rotate a binding's creds → run heartbeat now → view audit log → view cost dashboard → change Lint cadence to bi-weekly → forget a source with impact preview) needs a single-session smoke before tag.
- **`OPENROUTER_API_KEY` repo secret for nightly-green** — the appendix-#9 nightly live-pilot workflow requires this secret to be set in repo settings for the lane to flip green; verification step before tag.
- **Copilot-loop stale re-flags** — same pattern observed in appendix #9: after a fix-up commit lands, Copilot re-flags pre-fix lines as stale; verified clean by inspection rather than chasing the loop. Not a code residual; a process note.

---

## Appendix #11 (W1, W2, …) — Wave-end Chrome QA fix-ups

The 2026-05-09 Chrome QA walkthrough exercised the appendix-#10 integrated flow end-to-end and surfaced wiring gaps that the per-PR before/after pairs had missed.

### Fixed (W2, `<sha>` / #<n>) — cost-tracker pricing for every MODEL_CATALOG member

R5 (#88)'s `/Cost` dashboard was structurally working but recording every OpenRouter (kimi) call as `$0.00` because `packages/shared/src/cost-tracker/pricing.ts` was missing entries for 13 catalog models — including `moonshotai/kimi-k2.6`, the model the design-partner deployment pins for all three tiers. Every kimi call logged `cost-tracker.unknown_model` and fell to `FALLBACK_PRICING`, but the warning was not the user-visible regression — the dashboard under-reporting was. PR-W2 adds 13 missing pricing entries covering every catalog model previously without a price (the catalog has 19 non-ollama members across openai/anthropic/google/openrouter; 6 already had prices from earlier PRs): the Anthropic 4-series catalog ids (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-3-5-sonnet-20241022`), the missing Google entries (`gemini-2.0-flash-thinking`, `gemini-1.5-flash`), the missing OpenAI `o1`, and the six OpenRouter-prefixed models (`moonshotai/kimi-k2.6`, `anthropic/claude-sonnet-4`, `anthropic/claude-opus-4-7`, `openai/gpt-4o`, `google/gemini-2.0-flash`, `deepseek/deepseek-r1`). A new parameterized test in `tests/cost-tracker.test.ts` iterates `MODEL_CATALOG` and asserts `PRICING[model]` is defined for every non-ollama member — future catalog additions break the test until pricing is added in lockstep, mechanically preventing the same regression. No code-path changes (the `costFor` lookup function, the warning-emission code, and the `llm_usage` write shape are untouched); the data update intentionally changes the OBSERVABLE behavior for catalog models — `cost-tracker.unknown_model` warnings stop firing for them, and computed cost shifts from the `FALLBACK_PRICING` default to the real per-model rate. That observable shift IS the fix. Historical zero-cost rows in `llm_usage` are not backfilled (W2 only fixes forward).

OpenRouter's posted prices change occasionally; v0.2 will replace the static OpenRouter block with a daily fetch from `https://openrouter.ai/api/v1/models` (cached, override-safe). Until that lands, MODEL_CATALOG additions require a paired `pricing.ts` update — enforced by the catalog-coverage test, not just convention.

### Fixed (W5, `<sha>` / #<n>) — modal sheet caps to viewport + sticky-bottom action row

The 2026-05-09 Chrome QA pass at 1235x702 caught two wave-10 modals — `SourceBindingDetail` edit mode (~700px tall: config section + credentials section) and `DomainDetail` edit mode — pushing the bottom action row (Cancel / Save / Disable / Delete) below the fold. The operator could not see Save without resizing the window, which broke the edit-flow muscle memory established earlier in the QA pass. PR-W5 fixes the shell, not the consumers' content: `packages/ui/src/components/Modal.tsx` now (1) caps sheet height at `calc(100vh - 64px)` so the dialog never overflows the viewport (32px breathing room top + bottom, matching the existing backdrop padding cue), (2) wraps `props.children` in a scroll region (`flex: 1 1 auto; min-height: 0; overflow-y: auto` — the load-bearing `min-height: 0` is what lets a flex child shrink below its content's intrinsic height), and (3) accepts a new optional `actions` prop that renders sticky-bottom inside the sheet with `var(--paper)` background and `1px solid var(--rule)` top border. The depth cue is the rule line + paper mask, NOT a drop shadow (CLAUDE.md design-system hard-no). The wave-10 single-step modals (`DomainDetail` edit / disable / delete confirms, `SourceBindingDetail` read-only / edit / disable / enable / delete confirms, `ImpactPreviewDialog`, `NewDomainModal`) migrate to the new `actions` prop and lose their inline footer divs. The wizard-style `NewSourceBindingModal` keeps its stepwise inline footers — its action rows live inside child step components, the picker step did not appear in the QA finding, and the new scrollable body alone resolves the viewport-overflow risk for it. New unit tests in `packages/ui/tests/unit/modal.test.tsx` pin the `calc(100vh - 64px)` cap, the body's `overflow-y: auto / flex: 1 1 auto / min-height: 0` triple, the sticky-bottom action row's `position / bottom / background / border-top` set, the no-shadow invariant, and a parameterized "700px body fits at 1024x600 / 1235x702 / 1920x1080" matrix. Existing wave-10 modal-consumer test suites (DomainDetail, SourceBindingDetail, ImpactPreviewDialog, NewDomainModal, NewSourceBindingModal) all stay green without modification — the migration preserves text, callbacks, and DOM order; only the sheet's flex topology changed.

---

_Drafted from `IMPLEMENTATION-PLAN.md` §1.2.1–§1.2.18 + per-PR `gh pr view` body residuals. Maintainer to edit before the `0.1.0-a` tag cut._
