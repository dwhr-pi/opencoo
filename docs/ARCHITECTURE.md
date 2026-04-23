# opencoo — Architecture

> Contributor-facing summary. The full internal design-of-record (~160 KB) is kept local and gitignored; this file covers what anyone writing code against the repo needs to know. For the canonical decision list with rationale, see `docs/decisions-resolved.md`. For what we're shipping, when, and how, see `PRD.md`, `IMPLEMENTATION-PLAN.md`, `CONVENTIONS.md`, `THREAT-MODEL.md`.

## 1. What opencoo is

opencoo ingests documents and meeting transcripts, compiles them into a per-domain Markdown wiki stored in Gitea (the Karpathy LLM-Wiki pattern — knowledge is **pre-synthesized at ingestion time, not retrieved at query time**; no RAG, no vectors), and serves that wiki to AI agents via Gitea's native MCP server. Business model: open-source engine + paid per-client implementations; each client runs its own docker-compose instance.

## 2. Load-bearing decisions

These are the decisions that make opencoo different from the alternatives it rejects. Do not relitigate without explicit cause; each has a corresponding entry in `docs/decisions-resolved.md`.

1. **No RAG / no vector search / no semantic retrieval.** Agents navigate by exact path: `index.md → category → page`. Pages are compiled by LLMs at ingestion. The justification (Barman et al. 2026, interference/forgetting in semantic stores) is load-bearing for the whole product.
2. **No external LLM gateway.** Use the **Vercel AI SDK** directly inside the engine process — no LiteLLM, no proxy container, no Python. The March 2026 LiteLLM supply-chain attack is the blocker.
3. **Gitea is both the storage backend AND the agent-facing MCP server.** `packages/gitea-wiki-mcp-server/` (already shipping, in partner production) is the canonical MCP surface. Do not build a custom wiki MCP server.
4. **n8n is an optional overlay**, not a dependency. The core engine must run without it. Automation is an adapter (`AutomationAdapter`), not a foundation.
5. **UI-first configuration.** `.env` contains only `DATABASE_URL`, `ENCRYPTION_KEY`, `PORT`, `ADMIN_BOOTSTRAP_TOKEN`. Everything else — providers, integrations, domains, users, schedules — lives in Postgres and is edited via the management UI.
6. **Append-only logs.** `log.md`, event logs, audit tables never rewrite or delete. Agents that try to rewrite whole files are a known failure mode; the format prevents it.
7. **Progressive disclosure.** Never load the full wiki into LLM context. Three levels: `index.md` (always) → category pages (per task) → specific pages (on demand). LLM attention collapses past ~100–120 competing items.
8. **Front-load critical context.** In schema files, prompts, and templates, the most important rules live in the first ~100 lines — LLMs have a U-shaped attention curve.
9. **Workflow and skill repositories are catalog-class domains, not a parallel primitive.** `domains.class ∈ {knowledge, catalog-workflows, catalog-skills}`; catalog ingest rides the existing `SourceAdapter → Classifier → Compiler → wikiWrite` pipeline gated by `content_kind` to round-trip executable bodies losslessly.

## 3. Core domain model

The organizational unit is a **knowledge domain** (e.g. `wiki-executive`, `wiki-hr`, `wiki-ops`). Each domain has:

- Its own Gitea repo.
- Its own **LLM policy** — which provider/models process its data. This is a **data-sovereignty feature**: e.g. HR data can be pinned to local Ollama so it never leaves the premises. A policy-pinned domain hard-rejects out-of-policy LLM calls with a typed error (no silent fallback).
- Its own access control via Gitea teams.
- A bounded Thinker-compiled **`worldview.md`** (default 6000-token ceiling) — synthesis of priorities, active initiatives, key people, recent material changes, resolved + open contradictions. Refreshed on impact triggers (per-commit `Worldview-Impact: high|medium|low` trailers), not on every edit.

Multi-domain deployments additionally get a **`company.md`** on the aggregator domain, compiled from the per-domain worldviews (not their underlying pages). This delegates sovereignty correctly — cloud-routed aggregation only sees content that already passed through the source domain's LLM policy.

Worldview is injected into every agent's system prompt as persistent grounding. It is **not** retrieved at query time. Page-level **projections** (cross-domain compiles) are deferred to v2+.

Three domain classes:
- **`knowledge`** (default) — PDF / DOCX / transcript → compiled wiki page.
- **`catalog-workflows`** — n8n workflows round-trip losslessly via content-kind-gated Compiler templates. Nightly governance cadence; cloud-routed default.
- **`catalog-skills`** — agentskills.io `SKILL.md` bundles. Fed by SkillMiner + push-authoring. Quarterly cadence; local-pinned LLM-policy default.

## 4. Three-tier LLM strategy

Every LLM call picks a tier. This is a cost/capability knob, not cosmetic:

- **Thinker** — strategic compilation, contradiction detection, gap analysis, Heartbeat report, cross-domain aggregation.
- **Worker** — document classification, single-source page creation, conversational responses.
- **Light** — index/log entries, formatting, metadata.

Every call records `timestamp, engine, tier, model, pipeline/agent, document/run_id, tokens_in, tokens_out, cost, latency` to the `llm_usage` table. Clients need this to understand their operational costs. Full prompts/responses go to `llm_usage_debug` (7-day TTL) only when `LLM_DEBUG_LOG=1`.

All LLM calls route through `packages/shared/llm-router/`. An ESLint boundary rule (`no-direct-llm-sdk`) forbids `@ai-sdk/*` imports outside that package. Per-domain `llm_policy` is enforced at every call; per-domain monthly spend cap (`llm_budget_monthly_cap_usd`) pauses queues and alerts on breach — fail-closed.

## 5. Pipelines (Ingestion engine)

Eight BullMQ workers:

1. **Scanner** (every 4h) — discover new/changed source docs, dedupe, queue.
2. **Webhook receiver** — HMAC-verified, rate-limited, payload-capped; transport-only.
3. **Classifier** — Worker tier; structured-output-only (Zod-validated); path-allow-list validation rejects cross-domain writes silently to DLQ.
4. **Compiler** — Thinker tier; per-domain LLM policy; atomic `wikiWrite` per run; populates frontmatter provenance (`schema_version`, `prompt_version`, `compiled_at`, `compiled_by_run_id`) and `page_citations` rows.
5. **Index rebuilder** (every 6h) — keeps `index.md` current per domain.
6. **Review dispatcher** — routes flagged items to the Review Dashboard.
7. **SkillMiner** — weekly per `catalog-skills` domain; two-pass (Worker Detector → Thinker Synthesizer) induction of agentskills.io-format SKILL.md files from compiled transcripts + `agent_runs`.
8. **Cleanup** (weekly) — retention pruning on `ingestion_intake`, `webhook_events`, `llm_usage` only. Compiled wiki pages are never retention-purged.

Four-level idempotency keys (Intake / Webhook / Classifier / Compiler) + three-class `ErrorClass` taxonomy (Transient / UpstreamQuota / Validation) drive retry policy. Validation errors → immediate DLQ (no retry).

## 6. First-party agents (Self-Operating engine)

Five definitions, one harness, one `agent_runs` audit table (which doubles as the memory substrate):

1. **Heartbeat** — weekday-morning Thinker run per configured instance (e.g. `ceo-heartbeat`, `ops-heartbeat`); max 5 alerts, leads with #1 priority; delivered via bound `OutputAdapter`. Default memory: last 3 runs.
2. **Lint** — weekly; contradictions, stale pages, orphans, missing cross-refs, prompt-version drift, automation drift, `allowed_paths: ["**"]` bindings, redaction-pattern-disabled bindings. Synthetic `Worldview-Impact: high` for contradictions that hit worldview-level facts.
3. **Chat** — scoped by caller's Gitea PAT; per-session memory only, never persisted across sessions.
4. **Surfacer** — reads wiki (read-only); proposes `automation_candidates` (`status: 'proposed'`); never self-approves (gate 1).
5. **Builder** — runs on `status: 'approved'` candidates (gate 2); composes skills from `builtin:* < marketplace:* < overlay:*`; deploys to n8n **disabled** (gate 3 is always-manual and non-configurable); writes wiki backlinks on source pages; records `skills_used: [{slug, version, sha, source}]` per run.

## 7. Adapter boundaries

Six adapter interfaces. A new integration = one package implementing one interface + a `credentialSchema` (JSON Schema). The management UI **renders the config form dynamically from the schema** — do not hardcode integration-specific UI. Fields with `x-credential-field: { secret: true }` are encrypted at rest and masked in logs and UI.

| Adapter | Responsibility | v0.1 examples |
|---|---|---|
| `SourceAdapter` | Fetch source bytes; emit `SourceEvent` | `source-drive`, `source-asana`, `source-fireflies`, `source-n8n`, `source-skill-bundle` |
| `WikiAdapter` | Write compiled pages to the wiki backend | `wiki-gitea` (reference) |
| `OutputAdapter` | Deliver agent outputs | `output-asana` (v0.1; `output-slack` deferred to v2) |
| `AutomationAdapter` | Platform-specific automation tools + `builderSkills` bundle + `credentialSchema`. **One active per deployment.** | `automation-n8n-mcp` (v0.1 default) |
| `GuardAdapter` | Prompt-injection detection, content safety, or **redaction** (secret/PII scrubbing on structured payloads) | `guard-redaction-regex` (v0.1) |
| `DocumentConverterAdapter` | Source bytes → clean Markdown; per-domain sovereignty gating | Docling sidecar (default) |

`packages/adapters/source-drive/` is the reference `SourceAdapter` to model new ones after. Every adapter passes a shared contract-test suite (`packages/shared/adapter-contract-tests/*`).

## 8. Intended stack

TypeScript throughout. Fastify for HTTP (ingestion + self-op, one process each). React UI **bundled as static files and served by the self-op Fastify** — one process, one port, one container. PostgreSQL for state + audit; BullMQ + Redis for job queues; Drizzle ORM + `drizzle-kit` for schema-as-TypeScript and SQL migrations. pnpm workspaces + Turborepo. Docker Compose for deployment (GHCR + Docker Hub images, digest-pinned).

No Python services in core. Docling is a sidecar, not in-process. No Prometheus `/metrics` endpoint (UI surfaces `agent_runs` + `llm_usage` instead). No distributed tracing in v0.1 (BullMQ job IDs + `agent_runs.id` are the correlation story).

Four ESLint boundary rules are load-bearing for the architecture:
- `no-cross-engine-import` — `engine-ingestion/` and `engine-self-operating/` cannot import each other.
- `no-direct-gitea-write` — only `packages/shared/wiki-write/` touches the Gitea API (provisioning job is the single exception).
- `no-direct-llm-sdk` — `@ai-sdk/*` imports are confined to `packages/shared/llm-router/`.
- `no-feature-env-vars` — new `process.env.*` outside the allow-list fails lint.

## 9. Security posture (summary)

Full details in `THREAT-MODEL.md`. Non-negotiable invariants:

- **XML spotlighting** on every LLM call that includes untrusted or LLM-generated content (`<source_content>`, `<worldview>` wrapping). Load-bearing whether or not a `GuardAdapter` is configured.
- **Structured output only** from Classifier and Compiler (Zod-typed JSON; no free-form prose field).
- **No cross-domain writes** — `target_pages[].path` validates against the source binding's `allowed_paths` AND lives inside the binding's target domain.
- **Credentials referenced by ID**, never by value, in adapter payloads. App-layer AES-256-GCM with AAD binding to credential ID; `CredentialStore` interface so KMS/Vault backends plug in later.
- **Gate 3 (workflow activation in n8n) is manual and non-configurable** — no admin toggle, no env var, no CLI override.
- **Append-only audit tables**: `page_citations`, `redaction_events`, `erasure_log`, `miner_suppressions`, `agent_runs`. Engine code never UPDATEs or DELETEs. Cleanup is the only exception (retention pruning).
- **Prompt-injection corpus in CI** — `packages/shared/prompts/__fixtures__/injection/` covers direct / indirect / cross-domain-write / path-traversal / unicode-homoglyph / data-exfiltration attempts; a regression is a phase-a ship-blocker.

## 10. Design system

Self-contained Agent Skill under `design_system/`. Always start at `design_system/README.md`. Non-negotiables (see the skill for the full list):

- Product name is lowercase **`opencoo`** in prose. Never `OpenCoo` or `Open Coo`.
- Three type families, one job each: `Instrument Serif` italic (display/lede), `Geist` (UI), `JetBrains Mono` (paths, IDs, shortcuts).
- Three accents with fixed meaning: **Advisory Amber** (agent layer, under 10% per screen), **Wiki Teal** (compiled-knowledge chrome only), **Alert Red** (destructive/flagged).
- **No gradients. No drop shadows for elevation.** Depth = border + background shift. No fully-rounded buttons. No emoji.
- One motion loop only: the heartbeat pulse on the operate glyph. Everything else is one-shot ease-out.

Diagrams live under `diagrams/` with a shared `theme.css` that wires the design-system palette into mermaid output.

## 11. Repository layout

```
packages/
  shared/              — schema, logger, errors, LLM router, cost tracker,
                         credential store, wiki-write, text-normalize, prompts,
                         adapter-contract-tests
  engine-ingestion/    — Fastify boot + eight BullMQ pipelines (PRs 13–17)
  engine-self-operating/ — Fastify boot + agent harness + five first-party agents
                         + Review Dashboard + UI host (PRs 18–22, 28–29)
  ui/                  — React app, bundled as static files into self-op
  adapters/<kind>-<slug>/ — one package per adapter
  cli/                 — `opencoo` binary
  gitea-wiki-mcp-server/  — already shipping, Apache-2.0, separately npm-published
```

Schema-ownership rule: `packages/shared/db/schema/*` is the single source of truth for every `pgTable`. Every other package imports — never redefines.

## 12. Companion docs

- **`PRD.md`** — v0.1 product scope, users, 13 testable success criteria, non-goals.
- **`IMPLEMENTATION-PLAN.md`** — phased (a/b/c) delivery with test-first acceptance per PR, entry/exit gates, risk register.
- **`CONVENTIONS.md`** — TDD / TypeScript / testing discipline, ESLint boundary rules, PR discipline.
- **`THREAT-MODEL.md`** — security implementation guide; §2 invariants, §3 per-subsystem, §5 PR checklist, §7 residual-risk ledger.
- **`docs/decisions-resolved.md`** — the canonical list of architectural decisions with one-paragraph rationale per entry.
- **`DECISIONS.md`** — running list of **open** decisions. Empty at v0.1 start.
- **`design_system/`** — design-system skill. Start at `design_system/README.md` for any visual artifact.
- **`diagrams/`** — mermaid sources + rendered SVGs (`01-overview`, `02-ingestion`, `03-selfop`, `04-adapters`).

---

*This document reflects the v0.1 OSS architecture as it enters implementation. Update in the same PR as any change to the decisions it names; promote newly-resolved items from `DECISIONS.md` into `docs/decisions-resolved.md` on close.*
