# opencoo v0.1 — Product Requirements

> Team-facing PRD for the v0.1 OSS release. States **what** we're shipping and **why**.
> Does not re-specify the technical design — `docs/ARCHITECTURE.md` is the contributor-facing shape, and `architecture.md` (local, gitignored) is the full internal design-of-record; this document points back to them.
>
> Companion docs: `docs/ARCHITECTURE.md` (shapes), `docs/decisions-resolved.md` (decisions + rationale), `IMPLEMENTATION-PLAN.md` (phased delivery gates), `CONVENTIONS.md` (TDD + TypeScript discipline), `THREAT-MODEL.md` (security implementation guide), `DECISIONS.md` (open decisions index).

---

## 1. Problem

Executives and operators drown in documents, meetings, and transcripts that already contain every answer they need. Retrieval-era tools (RAG, vector search) promise to surface those answers at query time but degrade under the interference / forgetting failure modes documented in Barman et al. 2026, and force every downstream agent to re-solve the same "what does this company actually know" problem per query.

opencoo moves the work to **ingestion time**: LLMs compile source material into a per-domain Markdown wiki stored in Gitea; agents navigate that wiki by exact path, with a bounded, Thinker-compiled `worldview.md` grounding every call. No RAG, no vectors, no semantic retrieval. (`architecture.md` §3.1, §4.1)

---

## 2. Users

| Role | Primary interaction | What they need |
|---|---|---|
| **Partner** (implementation consultant) | Runs 2–6 week onboarding per customer; owns Management UI during setup; authors partner-specific Builder-skill overlays | Adapter scaffolding, credential vault, LLM-policy controls, Review Dashboard |
| **Admin** (customer org lead) | Approves candidates in Review Dashboard; flips gates; edits LLM policy | Server-side authorization on every action (THREAT-MODEL §3.13), sovereignty-diff confirmations, visible banners |
| **Operator** (customer team member) | Reads Heartbeat; triages Lint findings; chats with agents via MCP clients | Gitea PAT-scoped read, per-session Chat, scoped Heartbeat delivery |
| **Third-party AI agent** (Claude Code, IDE assistants, partner bots) | Connects via `gitea-wiki-mcp-server`; reads the compiled wiki + `worldview://` resources | MCP 2.1 + PKCE, PAT-scoped resources, uniform "not accessible" responses |

Non-users in v0.1: multi-tenant SaaS operators (single-tenant per customer, period — `architecture.md` §17 Resolved "Multi-tenant vs single-tenant"). Self-serve single-player is a **secondary install path**, not the primary v0.1 user story — shipped, but partner-led deployments are where the product value lives.

---

## 3. What we're shipping (v0.1 scope)

v0.1 ships as **one release rolled up from three internal phases** (a → b → c). Each phase is merge-able and releasable as a minor tag (`0.1.0-a.N` … `0.1.0-c.N`); `0.1.0` lands once phase-c is stable. Phase detail in `IMPLEMENTATION-PLAN.md`; product-level scope below.

### 3.1 Pipelines (eight BullMQ workers in the Ingestion engine)

Scanner · Webhook receiver · Classifier · Compiler · Index rebuilder · Review dispatcher · **SkillMiner** *(scope stretch — see below)* · Cleanup. (`architecture.md` §6.1)

**SkillMiner is the one deliberate scope-stretch past pilot-PoC parity.** It is v0.1 scope, but it lands in **phase b** (not phase a) and the design partner adopts it via a **dedicated sub-task after phase-a pilot cutover completes** (CLAUDE.md "v0.1 ship sequence"; `architecture.md` §17 Resolved "Pilot migration path" / "Skill induction from transcripts"). Every other pipeline gates phase-a; SkillMiner gates phase-b. See `IMPLEMENTATION-PLAN.md` §1.3 and §2.1 for the phasing contract.

### 3.2 First-party agents (five definitions in the Self-Operating engine)

Heartbeat · Lint · Chat · Surfacer · Builder. All share one `AgentDefinition` shape, one harness, one `agent_runs` audit table. (`architecture.md` §7.1)

### 3.3 Adapter packages (one per adapter, `packages/adapters/*`)

**SourceAdapters:** `source-drive`, `source-asana`, `source-fireflies`, `source-n8n`, `source-skill-bundle`.
**WikiAdapter:** `wiki-gitea` (reference).
**OutputAdapters:** `output-asana` (`output-slack` deferred to v2).
**AutomationAdapter:** `automation-n8n-mcp` (one active adapter per deployment — `architecture.md` §17 Resolved "Builder polymorphism").
**GuardAdapter:** `guard-redaction-regex` (role=`redaction`, fail_mode=`transform`).
**DocumentConverterAdapter:** Docling sidecar as the default shape.

### 3.4 Domain classes

Three values of `domains.class` (`architecture.md` §8.1):

- `knowledge` — default; PDF/DOCX/transcript → compiled wiki page.
- `catalog-workflows` — n8n workflows round-trip losslessly via content-kind-gated Compiler templates. **Nightly** governance cadence; cloud-routed default; archived mirror to `_archived/`.
- `catalog-skills` — agentskills.io `SKILL.md` bundles; fed by SkillMiner + push-authoring. **Quarterly** governance cadence; local-pinned LLM-policy default.

(`architecture.md` §8.1, §6.3.1, §17 Resolved "Catalog-class domains")

### 3.5 Cross-cutting

- **Worldview compilation:** one bounded `worldview.md` per domain + `company.md` on the aggregator domain for multi-domain deployments. MCP resource + harness system-prompt grounding. Projections deferred to v2+. (`architecture.md` §9)
- **Per-domain LLM policy** (data sovereignty): HR-class domains can be pinned to local Ollama; cloud-routed fallback is a typed error, not a silent downgrade. (`architecture.md` §8.2)
- **Review Dashboard** with five item types: source-binding review, Lint findings, Surfacer candidates, marketplace-update accepts, **SkillMiner skill candidates**. (`architecture.md` §7.3)
- **Management UI** bundled as static files served by the Self-Op Fastify — same process, same port, same container. React + JSX per the `design_system/ui_kits/management-console/` kit.
- **Install telemetry:** install-UUID + version ping only, Supabase-RLS INSERT-only; opt-out in setup wizard. (`architecture.md` §15.8)

---

## 4. Non-goals for v0.1

Explicit exclusions. If a PR wants to add one of these, it goes back to `DECISIONS.md` or `architecture.md` §17 Open questions first.

- **No RAG / vector store / semantic retrieval.** Architectural invariant. (`architecture.md` §3.1, §4.1)
- **No external LLM gateway** (LiteLLM, Helicone proxy, Portkey). Vercel AI SDK in-process only. (`architecture.md` §4.1 / §12.1)
- **No custom MCP server for the wiki.** Gitea's own MCP (wrapped as `gitea-wiki-mcp-server`) is authoritative.
- **No custom agent authoring UI.** Harness supports user-defined definitions from day one; the UI to author them is v2+.
- **No Prometheus `/metrics` endpoint.** UI surfaces `agent_runs` + `llm_usage` instead. (`architecture.md` §15.5)
- **No distributed tracing.** BullMQ job IDs + `agent_runs.id` are the correlation story in v1.
- **No backup tooling in-repo.** `deploy/BACKUP.md` documents pgBackRest / `git mirror`; we're not a backup product.
- **No multi-tenant data plane.** Single-tenant per customer.
- **No Python services in core.** Docling is a sidecar, not in-process. (`architecture.md` §12)
- **No env-var feature config.** `.env` holds only `DATABASE_URL`, `ENCRYPTION_KEY`, `PORT`, `ADMIN_BOOTSTRAP_TOKEN`. Everything else in Postgres + UI. (THREAT-MODEL §2 invariant 9)
- **No post-generate content safety guard.** v0.1 is pre-ingest only; post-generate is v0.2. (`architecture.md` §6.6)
- **No projections (page-level cross-domain compiles).** v2+. (`architecture.md` §9.6)
- **No workflow-pattern miner.** Infra is present (SkillMiner reuses `catalog_candidate`), but the prompts + `class: 'workflow-pattern'` entries land post-v0.1.
- **No federation of Builder-skill marketplaces.** Official `czlonkowski/n8n-skills` only; partner overlay repo covers the private case. (`architecture.md` §17 Resolved "n8n-skills marketplace")

---

## 5. Success criteria

Testable conditions. v0.1 is done when **all** hold on a fresh `docker-compose up` against a fixture Gitea + Postgres + Redis:

| # | Criterion | How to verify |
|---|---|---|
| 1 | Fresh `docker-compose up -d` produces a bootable admin + a default domain without manual DB edits | `opencoo doctor` returns all-green; `curl /health` on both engine ports returns 200 |
| 2 | An ingested PDF appears as a compiled wiki page in Gitea with populated frontmatter (`schema_version`, `prompt_version`, `compiled_at`, `compiled_by_run_id`) and a `page_citations` row | e2e test `ingest-pdf-produces-wiki-page.test.ts` (release-tag CI only) |
| 3 | Heartbeat runs on schedule, produces a rendered report delivered to the configured `OutputAdapter`, and appears in `agent_runs` with tokens + cost + latency | e2e test `heartbeat-delivers-and-audits.test.ts` |
| 4 | Per-domain LLM policy pinned to local Ollama **rejects** a cloud-provider call with a typed `LlmPolicyViolationError` (not a silent fallback) | Use-case test `llm-router-enforces-policy.test.ts` |
| 5 | Every one of the eight pipelines has a use-case test that runs in-memory (no Docker) and a contract test for each adapter port | CI job `pnpm test:use-cases` green; `pnpm test:contracts` green |
| 6 | The prompt-injection corpus at `packages/shared/prompts/__fixtures__/injection/*` passes for every locale × agent | CI job `pnpm test:injection` green — **phase-a ship-blocker** (THREAT-MODEL §4.2) |
| 7 | `wikiWrite` is the sole write path; ESLint boundary rule forbids direct Gitea-API writes from non-provisioning code | `pnpm lint` green with rule `no-direct-gitea-write` enabled |
| 8 | `packages/engine-ingestion/` and `packages/engine-self-operating/` do not import each other | ESLint boundary `no-cross-engine-import` green |
| 9 | `opencoo source forget <binding> --dry-run` prints a deletion plan and writes no rows; without `--dry-run` it writes `erasure_log` and either re-compiles or deletes cited pages | e2e test `source-forget-erases-and-audits.test.ts` |
| 10 | Upgrading image tag N → N+1 preserves human-edited wiki pages, preserves partner prompt overrides, and surfaces a "new defaults available" banner | e2e test `upgrade-preserves-overrides.test.ts` |
| 11 | SkillMiner produces `catalog_candidate` rows from a fixture transcript set, honors `miner_suppressions`, and surfaces candidates in the Review Dashboard as a fifth item type | e2e test `miner-produces-candidates.test.ts` |
| 12 | Marketplace live-fetch pulls a newer `n8n-skills` release, verifies SHA, writes a `marketplace_updates` row, and does **not** auto-activate | e2e test `marketplace-gates-accept.test.ts` |
| 13 | Design-partner deployment runs opencoo and n8n in parallel; at least one pipeline is demonstrably cut over (n8n version paused, opencoo version live, output quality ≥ n8n baseline) | Partner sign-off; pilot cutover log |

Criterion 13 is the true v0.1 done-signal — the design partner becoming the first opencoo customer. (`architecture.md` §17 Resolved "Pilot migration path")

---

## 6. Key flows (golden paths)

Reference flows the implementing team codes toward. Each has an e2e test in §5 above.

### 6.1 Ingest → compiled wiki page
Scanner discovers new Drive file → `source-drive.fetch()` returns bytes → Docling converter emits Markdown → text-normalize → Classifier (Worker-tier, structured output, path allow-list validation) → Compiler (Thinker-tier, per-domain LLM policy, atomic write via `wikiWrite`) → `page_citations` rows inserted → Index rebuilder updates `index.md` → Lint on next weekly run flags any contradictions. (`architecture.md` §6.1–6.5)

### 6.2 Heartbeat morning run
Scheduled BullMQ job → harness loads last 3 `agent_runs` (per-instance `memory.count`) + wraps `<worldview>` from own-domain `worldview.md` + `<worldview>` from company `company.md` → Thinker-tier LLM call → output validated against `Heartbeat.output` Zod schema → delivered via bound `OutputAdapter` (e.g. `output-asana`) → `agent_runs` row written with skills_used = `[]`. (`architecture.md` §7.4, §7.5, §9.5)

### 6.3 Surfacer → Builder → manual activation (three gates)
Surfacer reads wiki (read-only agent) → writes `automation_candidates` rows with `status: 'proposed'` → admin flips to `'approved'` (gate 1) → Builder runs on approved candidates, composes skills from `builtin:* < marketplace:* < overlay:*`, deploys to n8n **disabled** with wiki backlink (gate 2) → customer manually activates in n8n UI (gate 3 — non-configurable). (`architecture.md` §7.2, THREAT-MODEL §2 invariant 7)

### 6.4 SkillMiner weekly run
Scheduled job on `catalog-skills` domain with `scan_domains: [...]` → Pass 1 Worker Detector scans `agent_runs` + transcripts, emits candidates meeting `instance_count ≥ 3 ∧ confidence ≥ 0.7`, consults `miner_suppressions` → Pass 2 Thinker Synthesizer drafts `SKILL.md`, runs output-side redaction guard, writes `catalog_candidate` row → Review Dashboard shows fifth-type item → reviewer promotes (writes through `wikiWrite` to the catalog-skills domain repo) or suppresses (writes `miner_suppressions`). (`architecture.md` §6.9–6.10)

### 6.5 `opencoo source forget <binding>`
CLI resolves binding → dry-run prints deletion plan → execution purges `ingestion_intake` + `webhook_events` + `llm_usage_debug` rows for that binding → per page in `page_citations`: if multi-cited, re-compile without this source; if sole citation, delete page via `wikiWrite` mode `'delete'` (counts against daily cap) → `erasure_log` row per action. (`architecture.md` §6.7, THREAT-MODEL §3.5)

---

## 7. Dependencies and external contracts

| Dependency | Version pinning strategy | Why |
|---|---|---|
| PostgreSQL | Image digest-pinned in reference compose | Schema substrate; we own migrations via `drizzle-kit` |
| Redis | Image digest-pinned | BullMQ backing store |
| Gitea | Image digest-pinned; CI runs against oldest-supported + current | Storage + auth backbone + MCP substrate |
| Docling | Image digest-pinned; network-restricted | Document → Markdown sidecar; license-permissive (Marker/MinerU rejected on license) |
| Vercel AI SDK | SemVer in `packages/shared/llm-router` | Only direct LLM-SDK dependency; lazy per-provider imports |
| `czlonkowski/n8n-skills` | Vendored-pinned at build time; weekly live-fetch with SHA verify | Builder-skill marketplace (`architecture.md` §17 Resolved "n8n-skills marketplace") |
| n8n | Customer brings their own (not in compose) | Automation layer; opencoo talks to it via `automation-n8n-mcp` |
| LLM providers | Configured via UI, via Vercel AI SDK | Partner chooses; per-domain policy enforces |

---

## 8. Out of scope (explicit parking lot)

Items routinely raised that are not v0.1:

- Managed opencoo hosting as a product (`architecture.md` §17 Open questions).
- Review Dashboard v2 inline-edit UX.
- Custom agent authoring UX.
- `schema.md` evolution ownership.
- Workflow-pattern miner (post-v0.1 pilot target, waits on a ≥ 50-entry catalog + partner ask).
- Catalogs as a parallel top-level primitive (waits on a third catalog class).
- Federation of Builder-skill marketplaces.
- KMS / Vault credential backend (designed, plugs into `CredentialStore` without schema change — waits on partner ask).
- Separate `INSERT`-only Postgres role for audit tables (THREAT-MODEL §7 residual risk — v0.2).
- Post-generate content-safety guard (THREAT-MODEL §7 residual risk — v0.2).
- Output-redaction of `agent_runs.tool_calls[].result` at harness write (THREAT-MODEL §7 residual risk — v0.2).

---

## 9. Review cadence

- PRD reviewed at every minor-version planning (phase gate).
- Changes to §3 "what we're shipping" or §4 non-goals require a `DECISIONS.md` entry first.
- Success criteria (§5) are the release gate — if a criterion cannot be verified on `0.1.0`, it moves to §8 with a residual-risk entry in THREAT-MODEL.md §7.

---

## 10. Competitive context (lessons)

Adjacent open-source projects targeting the same "company brain" framing have appeared (notably Agno's `scout`, surfaced 2026-04). Reading their architecture sharpens what opencoo deliberately is and is not. The lessons below are observational — they reinforce existing scope and non-goals; they do not introduce new ones.

- **"Navigation over search" is now industry-validated.** Independent teams have converged on opencoo's anti-RAG thesis. The remaining split is *when* navigation happens: query-time (live-source navigation per request) vs. ingest-time (pre-compiled wiki — this PRD §3.1, `architecture.md` §3.1, `docs/ARCHITECTURE.md` §2.1). opencoo bets on the latter; the former is a different product, traded for audit, sovereignty, and proactive curation. We do not chase setup-speed parity at the cost of these properties.
- **The wiki must be the durable artifact, not a side effect.** Tools that build a wiki incidentally as conversations occur — and reset it on container restart, or persist it only inside a vendor-hosted control plane — treat the company brain as cache. opencoo's invariant: compiled pages survive every engine restart, image upgrade, and provider migration. Captured as load-bearing decision §2.10 in `docs/ARCHITECTURE.md`; tested via success criteria #2 (page lands in Gitea) and #10 (upgrade preserves edits and overrides).
- **Proactive curation is part of the product, not a feature on top of it.** A reactive-only company brain decays into contradictions and orphans within months. Heartbeat / Lint / Index rebuilder are non-negotiable surfaces — captured as load-bearing decision §2.12 and tested via success criteria #3 (Heartbeat delivers and audits) and #5 (every pipeline has a use-case test).
- **Self-hosted means self-controlled.** No external SaaS dashboard for auth, UI, or runtime config. Customers own the loop end to end — captured as load-bearing decision §2.11; its corollary in this PRD is the §8 parking-lot entry "Managed opencoo hosting." If a hosted control plane ever becomes load-bearing for a customer, sovereignty leaks.
- **Multi-domain partitioning is a sovereignty choice, not a scaling shortcut.** Regulated and multi-team customers cannot share one model surface across HR, exec, and ops. opencoo's per-domain LLM policy + worldview model exists for this reason (`architecture.md` §3, §8.2; this PRD §3.4). Tools that default to one-wiki-one-policy are tuned for small Slack-first teams and do not address this constraint at the architectural layer.
- **Adapters hide source quirks from the main agent's context.** Useful framing absorbed from the comparison: "a sub-agent behind each adapter owns the source's quirks; the main agent's context never sees them" describes opencoo's `SourceAdapter` / `OutputAdapter` / `AutomationAdapter` contract more concisely than current copy. Worth folding into `docs/ARCHITECTURE.md` §7 on the next editorial pass; recorded here so the language doesn't get lost.

If a future PR proposes loosening any of the above ("let's let the wiki rebuild on demand", "let's add an external auth dashboard", "let's drop scheduled curation for a query-only mode"), it goes through `DECISIONS.md` first — this section is the standing rationale for refusing the trade.

---

*Derived from `architecture.md` v0.1 (2026-04-23), `THREAT-MODEL.md` v1, `DECISIONS.md` 2026-04-23, and CLAUDE.md. When this document drifts from any of those, the source is authoritative; update this PRD in the same PR.*
