# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository State

No implementation code exists yet. The repo contains two kinds of documents:

- **`architecture.md`** — design spec for the open-source product. The forward-looking vision for the TypeScript engine. Read this first when asked to implement. **Gitignored from the public repo** (kept local for Claude Code and maintainers); contributors see the distilled `docs/ARCHITECTURE.md` + `docs/decisions-resolved.md`. Cross-references to `architecture.md §X` throughout this repo's committed docs point at this local internal spec.
- **`docs/local/`** — private working documents for a design-partner PoC, the live implementation that is validating the product patterns in production. **Gitignored.** Contains partner-specific credentials, identifiers, and operational notes. **Do not publish, quote, paraphrase, or reference filenames from `docs/local/` in any public artifact** — commits, issues, PR descriptions, documentation, or anything else that leaves this repo. Treat it as read-only ground truth for local development; use architecture.md and DECISIONS.md for anything that ships.

## The design-partner PoC vs. the OSS product

These are **two related-but-distinct projects** and confusing them is the most common failure mode:

| | Design-partner PoC (`docs/local/`) | OSS product (`architecture.md`) |
|---|---|---|
| Status | In pilot production; **the v0.1 coding gate** | Design frozen pending PoC completion; no TypeScript code yet |
| Implementation | n8n workflows + Gitea + Gemini REST | TypeScript engine + Fastify + Vercel AI SDK + Gitea |
| Scope | Single design-partner deployment validating product assumptions | Open source, multi-client; design partner is one adopter, not the scope |
| Host | Partner's existing infrastructure (n8n instance + Gitea + Postgres) | Per-client docker-compose |
| LLM access | Direct HTTP to provider from n8n nodes | Vercel AI SDK inside engine process |

**No opencoo TypeScript is written until the PoC is end-to-end production-stable** (architecture.md §17 Resolved, "Pilot migration path"). What the PoC reveals in production — edge cases, prompts needing more iteration, flows that didn't survive contact with reality — becomes architecture.md refinement *before* any engine code lands. v0.1's parity target is the finished PoC.

The OSS architecture **rejects n8n-as-the-engine** (§12.2): workflow JSON is unreadable/untestable/unPR-able, so the distributable product must be standalone TypeScript. n8n remains available as an optional `AutomationAdapter`. **The PoC's n8n patterns do not translate to the OSS engine** — what transfers is the *product logic* (the two-pass ingest, prompt shapes, delivery cadence, lint/merge loop), not the *workflow topology*. Do not use PoC workflow-node layouts as the design for the OSS engine; do read the PoC prompts and outcomes as the empirical ground truth.

The PoC is where every product assumption was **empirically validated** — the two-pass ingestion (Worker classify → Thinker compile), the three-tier model strategy, the Karpathy wiki pattern, the heartbeat-as-daily-task delivery, the lint-and-merge loop, and the Gitea-MCP-as-agent-interface all exist and work today. The canonical operational walkthrough lives in `docs/local/` (browse via filesystem; do not name files from that directory in public commits). It contains the **real production prompts** for the live LLM calls — these seed `packages/shared/prompts/pl/` when coding starts; they have been iterated against live feedback and are not to be rewritten from scratch.

**Migration plan.** Once v0.1 is coded and tested, the design-partner deployment cuts over **pipeline-by-pipeline, not big-bang**. n8n workflows and opencoo pipelines run in parallel during the cutover window; a workflow is turned off only when its opencoo replacement is demonstrably ahead on output quality and reliability. The design partner is the first opencoo customer, not a forever-PoC.

### Working with `docs/local/`

When you need PoC ground truth, browse `docs/local/` directly via the filesystem — it's on disk for local development. When answering questions:

- If the question is about *what exists and runs today*, `docs/local/` is authoritative; reference concepts, not filenames or stakeholders.
- If the question is about *what we're building as open source*, `architecture.md` is authoritative.
- State the frame when answering.

Never copy `docs/local/` content into a commit message, PR body, architecture.md edit, or anything else that ships. If a PoC fact needs to be reflected in the public spec, paraphrase generically (e.g. "the PoC uses X pattern") rather than quoting or attributing.

## Product in one paragraph

Strategic COO ingests documents and meeting transcripts, compiles them into a per-domain markdown wiki stored in Gitea (the Karpathy LLM Wiki pattern — knowledge is **pre-synthesized at ingestion time, not retrieved at query time** — no RAG, no vectors), and serves that wiki to AI agents via Gitea's native MCP server. The business model is open-source engine + paid per-client implementations; each client runs their own docker-compose instance.

## Load-bearing architectural decisions

When writing code or proposing changes, these are non-negotiable unless the user explicitly revisits them — they are the decisions that make this product different from the alternatives it rejects.

- **No RAG / no vector search / no semantic retrieval.** Agents navigate by exact path: `index.md → category → page`. Pages are compiled by LLMs at ingestion. The justification (Barman et al. 2026, interference/forgetting in semantic stores) is in §3.1.
- **No external LLM gateway.** Use the **Vercel AI SDK** directly inside the engine process — no LiteLLM, no proxy container, no Python. §4.1 / §12.1 explain why (March 2026 LiteLLM supply-chain attack).
- **Gitea is both the storage backend AND the agent-facing MCP server.** Do not build a custom MCP server unless Gitea's turns out to be inadequate (see open question in §15).
- **n8n is an optional overlay**, not a dependency. The core engine must run without it. Automation is an adapter (`AutomationAdapter`), not a foundation.
- **UI-first configuration.** `.env` contains only `DATABASE_URL`, `ENCRYPTION_KEY`, `PORT`. Everything else — providers, integrations, domains, users, schedules — lives in Postgres and is edited via the management UI. Do not add env vars for feature config.
- **Append-only logs.** `log.md`, event logs, source registries never rewrite or delete. Agents that try to rewrite whole files are a known failure mode; the format prevents it (§3.3).
- **Progressive disclosure.** Never load the full wiki into LLM context. Three levels: `index.md` (always) → category pages (per task) → specific pages (on demand). Attention collapses past ~100–120 competing items (§3.2).
- **Front-load critical context.** In schema files, prompts, and templates, put the most important rules in the first ~100 lines — LLMs have a U-shaped attention curve (§3.4).
- **Workflow and skill repositories are catalog-class domains, not a new primitive.** `domains.class ∈ {knowledge, catalog-workflows, catalog-skills}`; catalog ingest uses the existing SourceAdapter → Compiler pipeline gated by `content_kind` (§6.3.1) to round-trip executable bodies losslessly. Don't propose a parallel "Catalogs" top-level primitive or a new adapter kind — §17 Resolved settles this and records the trigger for revisiting (a third catalog class with real demand).
- **SkillMiner is v0.1, even though the PoC doesn't yet implement induction.** The induction-from-transcripts story is load-bearing for the product; OSS architecture commits to the full spec now (§6.9), and the design partner adopts it via a dedicated sub-task after PoC cutover. Don't revert this to "wait for PoC parity" — it's a deliberate, documented scope stretch (§17 Resolved "Pilot migration path").

## Core domain model

The organizational unit is a **knowledge domain** (e.g. `wiki-executive`, `wiki-hr`, `wiki-ops`). Each domain has its own Gitea repo, its own LLM policy (which provider/models process its data — this is a **data sovereignty feature**: e.g. HR data can be pinned to local Ollama so it never leaves the premises), and its own access control (via Gitea teams).

**Worldview compilation** (§9) is the v0.1 mechanism for cross-domain knowledge. Each domain holds a bounded Thinker-compiled `worldview.md`; multi-domain deployments additionally get a `company.md` on the aggregator domain, compiled from the per-domain worldviews (not their underlying pages), which delegates sovereignty correctly — cloud-routed aggregation sees only content that already passed through the source domain's LLM policy. Worldview is injected into every agent's system prompt as persistent grounding (§7.5), not retrieved at query time. Page-level **projections** are deferred to v2+ (§9.6).

## Three-tier LLM strategy

Every LLM call picks a tier (§8). This is a cost/capability knob, not cosmetic:

- **Thinker** — strategic compilation, contradiction detection, gap analysis, heartbeat report, cross-domain projection
- **Worker** — document classification, single-source page creation, conversational responses
- **Light** — index/log entries, formatting, metadata

§8.2 has the full step-to-tier mapping. Record token counts, cost, latency, model, tier, pipeline, step, and document ID for every call — clients need this to understand their operational costs.

## Pipelines (§9)

Six scheduled pipelines, all BullMQ jobs:

1. **Ingestion Scanner** (every 4h) — discover new/changed source docs, dedupe, queue.
2. **Ingestion Processor** — two-pass: Worker classifies + identifies target pages/domains; Thinker compiles/merges; Light updates index and log.
3. **Lint Agent** (weekly) — contradictions, stale pages, orphans, missing cross-refs, stale projections.
4. **Heartbeat Agent** (weekday mornings) — proactive daily report; max 5 alerts, always leads with #1 priority.
5. **Index Rebuilder** (every 6h) — keeps `index.md` current per domain.
6. **Cleanup** (weekly) — retention pruning.

## Adapter boundaries

Four adapter interfaces (§10): `SourceAdapter`, `WikiAdapter`, `OutputAdapter`, `AutomationAdapter`. A new integration = one package implementing one interface + a `credentialSchema` (JSON Schema). The management UI **renders the config form dynamically from the schema** — do not hardcode integration-specific UI. Fields with `x-credential-field: { secret: true }` are encrypted at rest and masked.

Google Drive is the reference `SourceAdapter` implementation to model new ones after.

## Intended stack (§12)

TypeScript throughout, Fastify backend, React frontend **bundled and served as static files from Fastify** (one process, one port, one container — same shape as Gitea/n8n), PostgreSQL, BullMQ+Redis, pnpm workspaces + Turborepo, Docker Compose for deployment. Do not introduce Python services. Do not split the frontend into a separate production SPA server.

## Design system

Lives under **`design_system/`** as a self-contained Agent Skill. **Always start at `design_system/README.md`** for the full reference (voice, color, type, components, layout, motion); use `design_system/SKILL.md` to invoke it as a skill (`name: opencoo-design`, user-invocable). Anything that produces a visual artifact — a UI screen, a marketing page, an HTML mock, a diagram, a slide — must read this folder first; do not invent new tokens, fonts, or component shapes.

- **What's where.** `colors_and_type.css` = canonical CSS vars (paper/ink scale, accents, radii, spacing, type scale, easings — import this directly into any new surface). `assets/` = logos, glyphs, app icon (use these SVGs — do not redraw). `preview/` = standalone HTML cards per component (badges, buttons, fields, heartbeat card, wiki card, log, iconography). `ui_kits/management-console/` = the only built UI kit so far (React + JSX). `source/` is read-only originals — don't edit.
- **Non-negotiables.** Product name is lowercase **`opencoo`** in prose, never `OpenCoo`/`OpenCOO`/`Open Coo`. Three type families with one job each: `Instrument Serif` italic = display/lede only · `Geist` = UI · `JetBrains Mono` = paths, IDs, micro-labels, button shortcuts. Three accents with fixed meaning and budgets: **Advisory Amber** (`--advisory`) under 10% per screen, agent layer only (Heartbeat, approvals, advisory CTAs); **Wiki Teal** (`--wiki`) only on compiled-knowledge chrome (citations, wiki-path badges); **Alert Red** (`--alert`) only on destructive/flagged items. **Healthy Green** (`--healthy`) for ok/compiled state.
- **Hard nos.** No gradients (anywhere, ever). No drop shadows for elevation — depth = border + background shift. No pills or fully-rounded buttons (radii cap at 6px for cards, 10px for sheets). No backdrop-blur / frosted glass. No emoji in any context — if it wants an emoji, it wants a glyph from the trio (open arc / filled disc / ring-with-dot). No marketing voice ("AI-powered", "unlock", "seamless", "intelligent" — rewrite). No purple / cool-gray enterprise palette.
- **The motion system has exactly one loop:** the heartbeat pulse on the operate glyph (`--heartbeat-dur`, 1600ms). Everything else is one-shot ease-out using `--ease-write` or `--ease-transform`. No spinners, no shimmer, no bounces.
- **Iconography is composed from the logo's three primitives.** Hand-rolled inline SVG, 24px grid, 2px stroke. Fall back to Lucide only if the trio cannot express the concept — and flag it so it can be promoted into the native set.
- **Diagrams.** Mermaid sources + rendered SVGs live under **`diagrams/`** with a shared **`diagrams/theme.css`** that wires the design-system palette and Geist/JetBrains Mono into mermaid output. Re-render with `cd diagrams && npx -y -p @mermaid-js/mermaid-cli mmdc -i <file>.mmd -o <file>.svg -b "#F6F3EC" --cssFile theme.css`. When adding a diagram, copy an existing `.mmd` so it inherits the front-matter theme variables and `classDef` tokens — and pull any new color from `design_system/colors_and_type.css`, never improvise.

## When implementing

- The implementation still does not exist as TypeScript code. The only code in the repo is `packages/gitea-wiki-mcp-server/` (already functional, running in design-partner production). Everything else — engines, adapters, shared/, cli/, ui/ — is unbuilt.
- **Companion docs at the repo root** — read these alongside `architecture.md` and this file. Each has a distinct job; do not duplicate content between them:
  - **`PRD.md`** — v0.1 product scope, users, 13 testable success criteria, explicit non-goals and parking lot. The "what + why."
  - **`IMPLEMENTATION-PLAN.md`** — phased (a/b/c) delivery with test-first acceptance criteria per PR-sized deliverable, entry/exit gates, risk register. The "when + in what order." §0 documents the pre-coding-gate scaffolding (toolchain + ESLint boundary rules) that must land before PR 01 opens.
  - **`CONVENTIONS.md`** — opencoo-specific overlay on the TDD / TypeScript / spec-driven skills at `.agents/skills/`: three-tier testing (use-case / adapter-contract / e2e), Zod at boundaries, ESLint boundary rules, PR discipline. The "how."
  - **`THREAT-MODEL.md`** — security implementation guide. §2 non-negotiable invariants, §3 per-subsystem must-do / must-not-do, §5 PR checklist, §7 known residual risks. **Run the §5 checklist before requesting review on any PR**, not after.
- **Commands.** No build / lint / test commands exist yet — the repo is pre-code except for `packages/gitea-wiki-mcp-server/` (which has its own scripts). The full toolchain (`pnpm` + `turbo` + Drizzle + vitest + ESLint with the four boundary rules) lands as `IMPLEMENTATION-PLAN.md` §0 pre-coding-gate scaffolding. Once scaffolded, `CONVENTIONS.md` §3 documents the three test tiers and how each is invoked; `architecture.md` §14.5 is authoritative for the `opencoo` CLI verbs.
- **`architecture.md` §17 "Resolved"** is the canonical list of decisions already made with rationale. Read it before revisiting anything — most "should we do X?" questions have been answered. Don't relitigate without explicit cause.
- **`DECISIONS.md`** at the repo root is the live list of unresolved decisions (both "quick yes/no unblock code shape" and "needed before v0.1 ships"). Check it before making judgment calls on anything non-trivial — if your question matches an entry, surface the entry rather than answering unilaterally.
- **`architecture.md` §17 "Open questions"** holds genuinely deferred design questions (v2+, waiting on real-customer signal). Not to be opened during v0.1 work unless a customer brings a triggering case.
- The name "Strategic COO" is a working title; the repo is `opencoo`, treated as the placeholder name. Anything referring to "opencoo" in code/docs can rename in one commit if the final name changes.

### v0.1 ship sequence (three phases under one release)

v0.1 is the first tagged release and is larger than strict pilot-PoC parity — it includes the SkillMiner induction pipeline, partner Builder-skill overlay, and marketplace live-fetch (per §17 Resolved). To keep dev cadence and the pilot cutover unblocked, v0.1 ships in three internal phases, each merge-able and releasable as a minor tag (`0.1.0-a.N`, `0.1.0-b.N`, `0.1.0-c.N`) but all rolling up to the `0.1.0` release once c is stable:

- **Phase a — Pilot cutover parity + `catalog-workflows`.** `packages/shared/` (schema, logger, errors, LLM router, cost tracker, CredentialStore, `wiki-write`, text-normalize); `engine-ingestion` scaffold; `engine-self-operating` scaffold; adapters (`source-drive`, `source-asana`, `source-fireflies`, `source-n8n`, `output-asana`, `automation-n8n-mcp` with vendored n8n-skills baseline, `wiki-gitea`, `guard-redaction-regex`, document converters); first-party agents (Heartbeat, Lint, Chat, Surfacer, Builder); Review Dashboard items 1–4; `catalog-workflows` class + compiler template. The design-partner deployment cuts over on this. **Gates pilot migration.**
- **Phase b — `catalog-skills` + SkillMiner.** `catalog-skills` class + compiler template; SkillMiner pipeline (Worker detector + Thinker synthesizer + pre-summarization); `catalog_candidate` + `miner_suppressions` + `miner_runs` tables; Review Dashboard 5th item type (skill candidates) with slug-collision Supersede flow; Miner UI tab with suppressions management; `redaction_events` audit table + Execution Log integration. Ships once phase-a is stable in pilot production.
- **Phase c — Overlay + marketplace live-fetch polish.** Partner Builder-skill overlay repo (creation flow in UI, loader in `automation-n8n-mcp`); marketplace live-fetch loop (GitHub Releases API polling, SHA verification); "Marketplace Updates" Review Dashboard entries with diff + accept/skip. Ships once phase-b is deployed to ≥1 partner.

**First PR is phase-a foundations**, in this order: `packages/shared/db/schema/*` (Drizzle), `packages/shared/{logger,errors,text-normalize}`, then `packages/shared/{llm-router,cost-tracker,credential-store,wiki-write}`, then `gitea-wiki-mcp-server` REPOS config updates, then engines, then adapters pairwise with the engine that consumes them. §14.4 names the schema-ownership rule; obey it.
