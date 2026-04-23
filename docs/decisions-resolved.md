# Resolved architectural decisions

> Canonical list of architectural decisions opencoo has committed to, each with a one-line rationale. New items land here when an open decision in `DECISIONS.md` is closed. Open questions that are genuinely deferred (v2+, waiting on real-customer signal) are separately indexed in `DECISIONS.md` under "See also — Open questions."
>
> Read alongside `ARCHITECTURE.md` (shapes) and `THREAT-MODEL.md` (security invariants).

## Product shape

- **Single-tenant per customer.** Multi-tenant SaaS is out of scope. Each customer runs its own docker-compose instance.
- **Open-source engine + paid per-client implementations.** The moat is domain knowledge; the software ships Apache-2.0 (monorepo, including `packages/gitea-wiki-mcp-server/`, relicensed from MIT; pre-existing MIT copies remain MIT).
- **Distribution:** Docker images primary (GHCR + Docker Hub, digest-pinned). `packages/gitea-wiki-mcp-server/` also ships to npm with provenance. All other packages `"private": true`.
- **Pilot migration path:** design-partner PoC production-stability is the v0.1 coding gate. Coding starts from finished PoC; migration is pipeline-by-pipeline coexistence (n8n and opencoo run in parallel during cutover). The design partner is the first customer, not a forever-PoC. One deliberate scope stretch past strict PoC parity: **SkillMiner ships in v0.1** because the induction-from-transcripts vision is load-bearing for the product story; the partner adopts it via a dedicated post-cutover sub-task.

## Retrieval & knowledge

- **No RAG / no vector search / no semantic retrieval.** The Karpathy LLM-wiki pattern: knowledge is pre-synthesized at ingestion time, not retrieved at query time. Agents navigate by exact path. Rationale: Barman et al. 2026 on interference/forgetting in semantic stores; we would pay the query-time cost on every agent call for no wiki-quality gain.
- **Progressive disclosure.** Never load the full wiki into LLM context — `index.md` → category → page. Attention collapses past ~100–120 competing items.
- **Worldview compilation.** One bounded (default 6000-token) Thinker-compiled `worldview.md` per domain; multi-domain deployments additionally get `company.md` on the aggregator domain, compiled from per-domain worldviews (not underlying pages), so sovereignty is delegated correctly. Refreshed on impact triggers (per-commit `Worldview-Impact` trailers), not on every edit. Injected into every agent's system prompt via `AgentDefinition.grounding`; MCP resource (`worldview://{domain}`, `worldview://company`) for external clients. Page-level **projections** deferred to v2+.
- **Multilingual wiki.** Per-domain `locale` (`en` | `pl` | `auto`; `auto` detects from first ingest and locks). Prompts shipped per-locale at `packages/shared/prompts/{locale}/`. Ship `en` + `pl` v0.1. Management UI i18n scaffolding ships in v0.1 (`next-intl` or equivalent, strings wrapped in `t(...)` from day one).

## LLM posture

- **No external LLM gateway.** Vercel AI SDK directly inside the engine process — no LiteLLM, no proxy container, no Python. March 2026 LiteLLM supply-chain attack is the blocker. Per-domain `llm_policy` enforced in `packages/shared/llm-router/`; cloud-pinned-reject / local-pinned-reject returns a typed `LlmPolicyViolationError`, never a silent fallback.
- **Three-tier model strategy.** Thinker / Worker / Light picked per call. `llm_usage` captures timestamp + engine + tier + model + pipeline/agent + doc_id + tokens + cost + latency on every call.
- **Per-domain monthly spend cap.** `llm_budget_monthly_cap_usd` nullable; on breach, router pauses the domain's queues and emits an admin alert. Fail-closed.

## Schema & storage

- **Gitea is both the storage backend AND the agent-facing MCP server.** `packages/gitea-wiki-mcp-server/` (already in partner production) is canonical.
- **DB migrations:** Drizzle ORM + `drizzle-kit` for schema-as-TypeScript and generated SQL migrations; hand-written SQL for renames, backfills, type coercions. Auto-run on engine boot with `--skip-migrate` escape hatch and `opencoo migrate` CLI. Type-safe schema acts as a compile-time audit for generated queries.
- **Wiki write concurrency:** all writes flow through `packages/shared/wiki-write`, one BullMQ queue per domain at `concurrency: 1`; one call = one atomic Gitea commit; stale-SHA pull-retry; shared bare clone per domain; `Co-authored-by:` trailer preserves LLM attribution on human-approved commits.
- **Append-only audit.** `page_citations`, `redaction_events`, `erasure_log`, `miner_suppressions`, `agent_runs`, `miner_runs`, `llm_usage` are append-only. Engine code never UPDATEs or DELETEs. Cleanup is the only DELETE source (retention pruning on `ingestion_intake` + `webhook_events` + `llm_usage`, never on compiled wiki pages).

## Ingestion

- **Pipeline failure model.** Four-level idempotency keys (Intake / Webhook / Classifier / Compiler); three-class `ErrorClass` taxonomy (Transient / UpstreamQuota / Validation) drives retry policy; DLQ surfaced in Execution Log with tiered retention (7/14/30d); atomic Compiler writes per classifier run.
- **Document conversion.** TS router + Python Docling sidecar as the default shape. `DocumentConverterAdapter` as the sixth adapter type with per-domain sovereignty gating. Table-collapse detection → Review; image-drop logging (VLM captioning v0.2); NFC + control-char + whitespace normalization at the router. Marker / MinerU not bundled (GPL / AGPL).
- **Real-time ingestion.** Webhook support is v1 for all categories that support it.
- **Catalog-class domains.** Workflows and skills live as sub-classes of knowledge domains (`class: 'knowledge' | 'catalog-workflows' | 'catalog-skills'`), gated by `content_kind` on `SourceEvent` to bypass the DocumentConverter and use a content-kind-specific Compiler template (`catalog-n8n-workflow.md`, `catalog-skill-bundle.md`) whose contract is frontmatter-merge-only — the executable body round-trips losslessly. **Not** a new top-level primitive; revisit only if a third catalog class surfaces with customer demand.
- **Ingestion module scope.** Index Rebuilder, Webhook Receiver, and Cleanup all live in the Ingestion module. The "engines don't import each other" rule constrains imports, not BullMQ worker placement.

## Self-operating & agents

- **Agent harness shape.** `AgentDefinition` object per agent (not class, not YAML), Zod-typed `output` and `budget`, tools imported directly (no runtime registry), three invocation paths (scheduled / HTTP / MCP) behind one definition. `agent_runs` is the universal audit log. Many-to-one instantiation via `agent_instances` (name, scope, channels, schedule, memory, locale). Builder writes additionally carry `skills_used: [{slug, version, sha, source}]` in `agent_runs` for skill-version audit.
- **Agent memory.** `AgentDefinition.memory` declaration; harness loads N previous runs from `agent_runs` before each invocation. Heartbeat defaults to 3 previous reports (per-instance configurable). No separate memory store; `agent_runs` is the substrate.
- **Skills as first-class.** opencoo adopts the agentskills.io SKILL.md format. Agent definitions declare `skills: [...]`; Ingestion Compiler accepts per-domain skill bindings; partners author skills on the filesystem. v1 = frontmatter + Markdown body + on-demand full-body load. v2+ = bundled scripts, remote registries, skills-as-wiki-pages.
- **MCP as tool transport.** Agent definitions can reference configured MCP servers (`mcp("gitea-wiki-mcp-server")`) alongside native TS tool imports. MCP is the integration boundary; native tools are opencoo-internal utilities.
- **UI host + Chat agent placement.** UI (React, bundled static files) is served by the self-operating module's Fastify. Chat is a first-party v0.1 agent in self-op, sharing the harness / audit / memory / grounding abstractions with Heartbeat, Lint, Surfacer, Builder. One instance per deployment, scope determined at call time by caller's Gitea PAT.
- **Human-in-the-loop.** Review Dashboard is v1 (approve/reject). v2 adds inline edit and conflict resolution.

## Automation loop (Surfacer + Builder)

- **n8n is never our engine; n8n-mcp is the bridge.** n8n remains an optional `AutomationAdapter`.
- **Automation loop.** Two separate agents — Surfacer reads, Builder writes. Three gates: (1) Surfacer proposes, never auto-approves; (2) Builder runs only on approved candidates, deploys workflows **disabled**; (3) **activation in n8n is always manual and non-configurable** — no admin toggle, no env var, no CLI override. Wiki backlinks + Lint-detected automation drift close the loop.
- **Builder polymorphism.** The active `AutomationAdapter` exports `{ tools, builderSkills: SkillRef[], credentialSchema }`; one Builder agent definition reads the active adapter's bundle at runtime. One active `AutomationAdapter` per deployment — partner selects in Management UI. `automation-n8n-mcp` is the v0.1 default and only first-party tier; other platforms are contributor territory.
- **n8n-skills marketplace.** Hybrid distribution: vendored pinned release at opencoo build time (offline-bootstrappable) + live-fetch loop (default-on, weekly, partner-adjustable or disable-able). Live-fetch verifies GitHub Releases `target_commitish` AND recomputes tarball tree-SHA, fails closed on mismatch. Review-Dashboard-gated accept — new skill versions never activate without explicit partner acceptance. Federation to alternative registries deferred to v0.2+.
- **Builder skills vs. catalog-skills domain.** Separate tracks in v0.1. Builder's skills are engine-internal (`builtin:*` from the active adapter, then `marketplace:*`, then partner overlay). The `catalog-skills` domain is external-facing — fed by SkillMiner + push-authoring, consumed by third-party agents via `gitea-wiki-mcp-server`. `AgentDefinition.skills` does not accept `catalog-skills:<domain>/<slug>` refs. Convergence explicitly deferred with no v2+ commitment.
- **Partner Builder-skill overlay.** Company-specific Builder skills live in a dedicated per-partner Gitea repo (convention `builder-skills-<partner-slug>`), registered with the active `AutomationAdapter` via Management UI. Loaded on adapter start + on-change, overlay takes precedence on slug collision. Explicitly **not** a catalog-skills domain. Provisioning: Management UI offers "Create in Gitea" (default, admin token creates pre-seeded repo) or "Use existing URL" (paste-in, validated).
- **Skill induction from transcripts (SkillMiner).** Eighth Ingestion pipeline. Two-pass (Worker Detector → Thinker Synthesizer) induction of agentskills.io-format SKILL.md from compiled transcripts + `agent_runs`. Thresholds `instance_count ≥ 3 ∧ confidence ≥ 0.7`. Output lands in `catalog_candidate`; Review Dashboard is the fifth item type; quarterly ATS-Lead review cadence. Miner binding declares `scan_domains` for sovereignty; LLM policy inherits from the target `catalog-skills` domain. Pre-summarization sub-step when evidence exceeds ~6k tokens. **Ships v0.1** — the one deliberate scope stretch past strict PoC parity.

## Security

- **Prompt injection + content safety.** Four layers: (1) XML spotlighting always on, (2) structured-output-only with path + domain allow-lists, (3) optional pluggable `GuardAdapter` (injection / content-safety / redaction roles) with `fail_mode = block | review | log_only | transform` (default `review` for injection/safety, `transform` for redaction), (4) transcription bindings default to `review_mode: approve`. v0.1 reference guards: Llama Prompt Guard 2 86M (injection), Bielik-Guard 0.1B (Polish) / Granite Guardian 3.3 (English) for content safety. Pre-ingest only in v0.1; post-generate is v0.2.
- **Credentials vault.** v1 = app-layer AES-256-GCM per-row with random IV + AAD binding to credential ID + `encryption_version` column. Abstracted behind a `CredentialStore` interface so KMS / Vault backends plug in later without schema or caller changes. KMS/Vault deferred until a partner asks.
- **Secret loading.** All sensitive boot env vars accept a `{VAR}_FILE` alternative (Docker secrets / Kubernetes secret-volume idiom).
- **PII / data retention.** Partner-responsibility framing (we ship controls, not a compliance product). `page_citations` for source→page back-reference; per-domain `retention_days` driving weekly Cleanup over `ingestion_intake` + `webhook_events` + `llm_usage` (never compiled wiki pages); `opencoo source forget <binding>` CLI with `--dry-run`, re-compile for multi-cited pages (or `--cascade-delete`), and `erasure_log` audit. LLM usage logs are metadata-only by default; `LLM_DEBUG_LOG=1` writes content to `llm_usage_debug` (7-day TTL).

## Engineering discipline

- **Monorepo tooling.** pnpm workspaces + Turborepo.
- **Inter-module communication.** Modules coordinate through Postgres, BullMQ/Redis, and the Gitea wiki. No imports between engine modules; no custom transport layer. Enforced by the `no-cross-engine-import` ESLint rule.
- **Adapter packaging.** One package per adapter (`packages/adapters/source-drive/`, `source-asana/`, `output-asana/`, …), not a single `adapters/` with subfolders. Third-party adapters publish independently; tree-shakes cleanly; per-adapter `package.json` + version cadence. `opencoo adapter new` scaffolds.
- **Upgrade & migration.** Never auto-rewrite wiki content on upgrade. `schema_version` + `prompt_version` + `compiled_at` + `compiled_by_run_id` on every compiled page. Lint surfaces version drift. `opencoo recompile` CLI for opt-in bulk backfill. Prompt overrides preserved on upgrade (UI diff banner on new defaults). `opencoo doctor` warns on version drift until `--ack-upgrade`. Downgrade unsupported — restore from backup.
- **Versioning.** Hybrid. SemVer for things that get imported (`gitea-wiki-mcp-server` on npm, `0.3.1`-style); CalVer for things that get deployed (opencoo Docker images, `2026.04.1`-style). Breaking-change signalling moves entirely to `CHANGES-vX.Y.md`.
- **Telemetry.** Install-level opt-out only in v0.1. Random install UUID + version + first-boot + weekly heartbeat ping. **No** usage counts, wiki content, errors, or customer identifiers. Supabase destination with RLS granting the embedded anon key `INSERT`-only — the key cannot read anything, even for us. Partners opt out via the setup wizard or `TELEMETRY_ENDPOINT=`. Aggregate usage telemetry and crash reporting deferred to v0.3+.
- **Backup / DR.** Delegated. opencoo ships no backup machinery; `deploy/BACKUP.md` documents pgBackRest / Barman / `pg_dump` for Postgres and `git mirror` for Gitea. `docker-compose.yml` volumes annotated with backup=yes/no/cache.

---

*This file is the public, distilled equivalent of `architecture.md §17 Resolved` (kept local, gitignored). On resolving a new decision from `DECISIONS.md`, land a paragraph here in the same PR.*
