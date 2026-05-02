# Phase-a appendix #4 — observability surface + Review Dashboard UI + Reports + badge legibility + Asana state ingestion + webhook adapters

> **Status:** scoping doc · 2026-04-29 · ten PRs (five observability A–E + five Asana/webhook F–J) · ~5–7 weeks · **blocks `0.1.0-a` tag**.
> Pointer in `IMPLEMENTATION-PLAN.md` §1.2.12. THREAT-MODEL coverage per row.

---

## Why this exists

Phase-a (32 PRs + 5 fix-ups, `main @ 5a5b51e`) ships the engine but not a window into it. From the operator's seat as of 2026-04-28:

- The Sources STATUS column is a hardcoded `enabled ? "ok" : "paused"` — no probe, no last-error, no queue health.
- No way to see an agent run unfold: Heartbeat firing at 8am, Lint sweeping on Sunday, the Compiler mid-classify on a freshly dropped Drive doc. All `agent_runs` / `llm_usage` data lives in Postgres only.
- The "OK" status badge renders as "0k" because `Badge.tsx` ships `fontSize: 10` — JetBrains Mono's slashed-zero detail collapses sub-pixel.
- No Review Dashboard UI: PR #28 shipped the server-side state-machine + audit log + CSRF, and `/api/admin/{lint-findings,automation-candidates,marketplace-updates}` endpoints exist, but no UI consumes them.
- No way to read a Heartbeat report inside the app — delivered only via `OutputAdapter` (Asana/Slack).
- No surface for `redaction_events`.

PRD §4 explicitly defers Prometheus and says "UI surfaces `agent_runs` + `llm_usage` instead." That UI did not ship in phase-a. This appendix is that UI.

The user (2026-04-28) decided this blocks the `0.1.0-a` tag — `0.1.0-a` should not ship "engine works, you can't see it work." Four items originally marked for phase-b / v0.2 are pulled forward (Heartbeat reader, Lint + Surfacer review UI, redaction-events surface, real-time LLM token streaming). Only the in-app wiki page browser stays out (Gitea owns rendering by design).

## Ground truth (verified 2026-04-28)

- **No schema migrations needed.** `agent_runs`, `llm_usage`, `llm_usage_debug`, `ingestion_intake`, `webhook_events`, `redaction_events`, `automation_candidates`, `page_citations` all carry every column referenced below. (`packages/shared/src/db/schema/`.)
- **No `lint_findings` table.** Findings live in `agent_runs.output` jsonb where `definition_slug='lint'`. The existing `lint-findings.ts` admin route already unpacks them.
- **`webhook_events` has no explicit error column.** `status='invalid'` + `signature_ok=false` + `payload` jsonb is the surface we have. Plan around it (PR-A).
- **No SSE / WebSocket route exists yet.** PR-B pioneers the pattern.
- **No `QueueEvents` listeners wired** anywhere (`packages/shared/src/engine-scaffold/queue.ts`). PR-B wires the first ones.
- **`redaction_events` admin endpoint does not exist.** PR-D adds it.
- Admin-API plugin pattern: every route wrapped via `verifyAdmin` preHandler + `requireCsrf` for state-changing routes. Audit-log writer (`writeAuditLog`) called after successful tx commit. New endpoints slot in by `registerXxxRoutes({ app: guardedApp, db })` from `admin-api/index.ts`.
- UI tab registration: single line in `Chrome.tsx` `TABS` + entry in `App.tsx` route record + locale keys. Glyph trio (`GlyphRingWithDot` / `GlyphOpenArc` / `GlyphFilledDisc`) already exported.

## Deliverables

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| A | Real source-binding status + Sources table enrichment | PR #40 (#5a5b51e baseline) | `source-bindings-status.test.ts` — three-state probe (`healthy` / `advisory` / `alert`) computed from `webhook_events.received_at` (latest), `webhook_events.signature_ok=false` count in last 24h, `ingestion_intake.error_class` (latest non-null), and BullMQ DLQ depth for the binding's queue; UI snapshot covers all three states; `last_event_at`-null binding renders neutral, not alert | `GET /api/admin/source-bindings` returns each row with `name`, `status: 'healthy'\|'advisory'\|'alert'`, `last_event_at`, `last_error` (truncated to 200 chars, never including raw payload). UI Sources table renders human-readable `name` instead of UUID. THREAT-MODEL §3.6 invariant 11: error string is sanitised (no PAT, no credential bytes). | `pnpm --filter @opencoo/engine-self-operating test source-bindings-status` + manual UI confirmation against compose stack with one bad-PAT binding | ~10 |
| B | Observability core — Activity / Run detail / Pipelines (5th UI tab) + first SSE route + streamed LLM tokens | PR-A (data plumbing) | `agent-runs-list.test.ts` (admin-API, paginated reverse-chrono); `agent-runs-detail.test.ts` (single run with tool-call timeline, `LLM_DEBUG_LOG` gate honored); `sse-stream.test.ts` (auth-required, heartbeat ping every 15s, reconnect-with-`Last-Event-ID`, drops connection on 401); `pipelines-list.test.ts` (BullMQ queue stats across both engines, `QueueEvents` wired); `streamed-tokens.test.ts` (router emits per-token observable for in-flight runs, UI subscribes only when run.status='running') | New `Activity` 5th tab. Three views: feed (live, SSE-driven), run detail (system+user prompts gated by `LLM_DEBUG_LOG=1` per THREAT-MODEL §2 invariant 11; `tool_calls` rendered as timeline; tokens/cost/latency/model/tier/skills_used surfaced), pipelines (per-queue card: depth, processed/h, last run, last failure, DLQ count). SSE route under `/api/admin/events`, `verifyAdmin` preHandler enforced (no anonymous subscribers). Streamed tokens use the existing `llm-router` `streamText` path; non-streaming runs render final text only. THREAT-MODEL §3.6 invariant 11: prompt content never on the SSE channel unless `LLM_DEBUG_LOG=1`. | `pnpm --filter @opencoo/engine-self-operating test activity` + `pnpm --filter @opencoo/ui test:e2e activity` (live Heartbeat fired against compose stack, observed in feed within 2s) | ~38 |
| C | Review Dashboard UI — source-binding review + Lint findings + Surfacer candidates (3 of 5 item types) | PR-B (SSE + tab pattern) | `review-source-bindings.test.ts` (consumes `GET /api/admin/source-bindings` with new `pending_events_count` field — needs server-side addition; approve/reject writes through existing audited endpoints with CSRF token); `review-lint-findings.test.ts` (consumes existing `GET /api/admin/lint-findings`; ack action wires `lint_finding.acknowledge` audit verb already in the allowlist); `review-surfacer-candidates.test.ts` (consumes existing `GET /api/admin/automation-candidates`; flips `status: 'proposed' → 'approved'` via state-machine endpoint) | New `Review` 6th tab with three sub-views (or stacked cards). Three of five item types ship here: source-binding review, Lint findings, Surfacer candidates. Skill candidates (phase-b) and marketplace updates (phase-c) explicitly noted as "5th and 6th item types ship later" in the tab's empty-state. Sovereignty-diff confirmation on any source-binding review action that changes the binding's effective LLM policy (THREAT-MODEL §3.13). All state-changing actions go through existing PR #28 server-side endpoints — no new state-machine code. | `pnpm --filter @opencoo/engine-self-operating test review` + `pnpm --filter @opencoo/ui test:e2e review` | ~25 |
| D | Reports tab — Heartbeat reader + Redaction events | PR-B | `heartbeat-reader.test.ts` (latest `agent_runs.output` per `definition_slug='heartbeat'` per domain; markdown render through existing pipeline; renders the same compiled bytes that the OutputAdapter delivers — no LLM re-call); `redaction-events-list.test.ts` (new `GET /api/admin/redaction-events`; metadata-only — never includes `matched_byte_ranges` content nor any reconstruction; per-pipeline + per-guard + per-category filter); `redaction-events.security.test.ts` (THREAT-MODEL §3.3 — content cannot be reconstructed from the response, no source bytes returned) | New `Reports` 7th tab. Two views: Heartbeat (read-only mirror of OutputAdapter delivery, grouped by domain, latest first; deep-link to the underlying `agent_runs.id`); Redaction events (last N rows with category, source binding, run_id, timestamp; *content is never logged or rendered* per THREAT-MODEL §3.3 — only `matched_byte_ranges` count). | `pnpm --filter @opencoo/engine-self-operating test reports` + `pnpm --filter @opencoo/ui test:e2e reports` | ~14 |
| E | Badge legibility — font size + glyph swap + locale normalize | — (independent) | `badge.snapshot.test.ts` (renders all five tones at 12px; visual diff vs current 10px); `glyph-status-pill.test.ts` (`GlyphRingWithDot` for healthy, `GlyphOpenArc` for advisory, `GlyphFilledDisc` for alert; size 16px; `currentColor` cascades from tone) | `Badge.tsx` `fontSize: 10 → 12`. Status pills in tables (Sources, Activity, Review, Reports) use the trio glyphs. `en.json` + `pl.json` `sources.status.ok: "ok" → "OK"` (CSS uppercase becomes harmless redundancy). No design-system token changes. | `pnpm --filter @opencoo/ui test` + visual review against `design_system/preview/` | ~6 |

## Sequencing

PR-A and PR-E land first (week 1 — both small, both unblock visual confirmation). PR-B is the critical path (week 2–3 — pioneers SSE + token streaming + the Activity tab). PR-C and PR-D land in parallel after PR-B's SSE infrastructure ships (week 3–4). The `0.1.0-a` tag follows once all five are green and §1.3 phase-a exit gate clears.

## THREAT-MODEL coverage

- **§2 invariant 8** (append-only): every observed table is read-only at the API layer; no UI write to `agent_runs`, `llm_usage`, `redaction_events`, `webhook_events`. Acks/approvals write to dedicated audit-log + state-machine tables only.
- **§2 invariant 11** (no raw prompts in info-level logs): SSE channel and Run detail view both gate prompt text behind `LLM_DEBUG_LOG=1`. Tool-call args/results are surfaced; LLM input/output strings are not, unless the gate is on. Visible debug-mode banner in the UI (already exists per PR #28).
- **§3.3** (redaction events are metadata-only): PR-D's redaction-events route returns `matched_byte_ranges` count, never the matched content, never source bytes. UI cannot reconstruct.
- **§3.6 invariant 11** (no credential bytes in errors): PR-A's `last_error` truncation runs through the existing PAT-scrub helper before rendering.
- **§3.13** (server-side authorization): every UI action goes through `verifyAdmin` + `requireCsrf` + audit-log on existing PR #28 endpoints. No client-side authorization.

## Out of scope (deliberate)

- **In-app wiki page browser.** Architectural — Gitea owns rendering, MCP is the agent surface. Operators tab to Gitea.
- **Skill-candidate Review Dashboard item type.** Depends on phase-b SkillMiner output. Ships when SkillMiner does (phase-b PR #37 — scoped down accordingly in `IMPLEMENTATION-PLAN.md` §2.2).
- **Marketplace-update Review Dashboard item type.** The endpoint exists, but the live-fetch loop that populates it is phase-c. UI ships in phase-c PR #44.
- **Live LLM token streaming for completed runs.** PR-B streams only for `status='running'`. Replay of a completed run shows final text from `agent_runs.output` + `llm_usage_debug.response_text`.
- **Cost dashboards / charts.** `llm_usage` rows are surfaced in Run detail; aggregate spend dashboards are v0.2 territory unless a partner asks.

## Plan-document edits required

Single coordinated commit alongside each PR's merge:

- **PR-A merge** — tick `IMPLEMENTATION-PLAN.md` §1.3 row "real source-binding probes green."
- **PR-B merge** — tick §1.3 row "observability surface shipped." Update progress snapshot (PR count + post-32 list).
- **PR-C merge** — tick §1.3 row "Review Dashboard UI shipped (3 of 5 item types)." Scope down §2.2 PR #37 row to skill-candidate item type only.
- **PR-D merge** — tick §1.3 row "Reports tab shipped." Drop or shrink §2.2 PR #39 row (most of its scope absorbed here).
- **PR-E merge** — tick §1.3 row "badge legibility shipped."

## Critical files referenced (read-only context, not edited by this doc)

Schemas (no migrations): `packages/shared/src/db/schema/{agent-runs,llm-usage,llm-usage-debug,ingestion-intake,webhook-events,redaction-events,automation-candidates,page-citations}.ts`.

Admin-API (extend, don't fork): `packages/engine-self-operating/src/admin-api/{index.ts,auth.ts,csrf.ts,audit-log.ts,routes/*.ts}` — `lint-findings.ts`, `automation-candidates.ts`, `marketplace-updates.ts`, `audit-log-read.ts`, `source-bindings.ts` already exist. New endpoints needed: `redaction-events.ts`, `agent-runs.ts` (list + detail), `events.ts` (SSE), `pipelines.ts`, `source-binding-status.ts` (or extend `source-bindings.ts`).

Queue events: `packages/shared/src/engine-scaffold/queue.ts` + `packages/engine-ingestion/src/queue.ts` — wire `QueueEvents` listeners; expose stats via the new `pipelines.ts` route.

LLM streaming: `packages/shared/src/llm-router/` — extend the existing `streamText` path to publish per-token events on the SSE bus.

UI: `packages/ui/src/{App.tsx,components/Chrome.tsx,routes/*.tsx,components/Badge.tsx,components/Glyph.tsx,types.ts,locales/{en,pl}.json}`. Three new routes (`Activity.tsx`, `Review.tsx`, `Reports.tsx`); `Badge.tsx` patched in PR-E; `Sources.tsx` updated in PR-A.

---

## Additional scope (added 2026-04-29): Asana state ingestion + webhook adapters

> **Status:** scoping addendum · 2026-04-29 · five additional PRs (F–J) · ~2.5–3 weeks · **also blocks `0.1.0-a` tag** (pilot cutover parity).

### Why this exists (additional)

`source-asana` (PR #24) shipped as a webhook-mode skeleton: HMAC verifier + `parseEvents` that emits the raw event JSON as `contentBytes`, `sourceDocId = '${gid}:${action}'`. What that means in production: the Compiler receives change-notifications (`user X changed due_on on task 1234`) — never the task body, never assignees, never the section, never subtasks. The PoC's working pattern (`estyl-asana-event-listener` TZLsyt2i4OkqwhqQ + `estyl-asana-wiki-updater` tW2LQOoMeru3ih1q in n8n.estyl.team) goes further: derives a 6-element `event_type` enum from raw payloads (filtering ~60% of webhook traffic as noise), summarizes significant events with a Light-tier LLM call, then on cadence fetches a live Asana snapshot via REST (`opt_fields=name,assignee.name,completed,due_on,modified_at,memberships.section.name`) and Worker-merges it with the existing wiki page through a 5-rule Polish system prompt. None of that semantic layer ships in the current adapter.

The user's framing (2026-04-29): opencoo is a knowledge engine, not an executor — so the campaign-state-as-narrative belongs in the wiki, but the work of executing the campaign stays in Asana + n8n + humans. Closing this gap also surfaces a parallel decision: every external system that doesn't have a dedicated adapter (Copper, Thulium, GMail, Stripe, BaseLinker, future Dify/paperclip-class executors) needs a clean integration path that doesn't require a new TypeScript package per integration. A generic webhook SourceAdapter (n8n flow does pull+digest, POSTs to opencoo) and a generic webhook OutputAdapter (opencoo pushes signals to any external receiver) close that family in one shot. They also rule the "Dify as executor harness" question out architecturally — Dify (or anything else) plugs in as a webhook peer, not a control-plane participant, preserving the §2.4 / §2.11 / §2.12 load-bearing decisions in `docs/ARCHITECTURE.md`.

Pilot cutover parity requires F–H: the partner's wiki has to compile project pages from Asana state, not just from event metadata. PR-I and PR-J are not strictly cutover-blocking but ship in this appendix because they emerge from the same refactor (webhook receiver + HMAC verifier + `OutputAdapter` retry shape are touched in F/G/J anyway).

### Ground truth (verified 2026-04-29)

- **`source-asana` PR #24 ships HMAC verifier + `parseEvents` only.** No handshake helper, no `event_type` derivation, no project-monitoring filter, no Asana REST client. README `packages/adapters/source-asana/README.md` line 22-28 explicitly defers handshake to "PR 30," but PR #34 (`@opencoo/cli`, commit `a215eb1`) is the CLI surface; the engine-ingestion webhook receiver does not yet implement Asana's `X-Hook-Secret` echo. **Verified by reading `packages/adapters/source-asana/src/adapter.ts:141-225` against the merged engine-ingestion receiver.**
- **PoC reference workflows live in n8n.estyl.team under tag `estyl-coo-system`:** `estyl-asana-event-listener` (TZLsyt2i4OkqwhqQ, 13 nodes), `estyl-asana-wiki-updater` (tW2LQOoMeru3ih1q, 20 nodes), `estyl-asana-webhook-register` (Ox19mixecneGrG5Z) + `estyl-asana-webhook-manager` (PKkGmNEDBaBlXGp4) — these are the canonical reference for what the adapter should emit. The handshake echo, `deriveEventType` function, monitored-project filter, Light-tier summary, and snapshot+merge prompt are all in those workflow JSONs.
- **`shared/CONTENT_KINDS` const exists** (PR #29 / commit `8c09365`); adding `'asana-project'` is a one-line registration plus a Compiler template entry, mirroring the `'n8n-workflow'` pattern from PR #26.
- **`output-asana` (PR #24, commit `f02c964`) is the OutputAdapter contract reference.** It includes the 9-assertion `outputAdapterContract` suite + the no-raw-credentials-in-result invariant. PR-J (output-webhook) implements the same contract; PR-J does **not** invent a new contract.
- **No schema migrations needed for F/G/H.** `webhook_events`, `ingestion_intake`, and the existing source-binding shape carry every column needed. Light-tier per-event summary persists into `webhook_events.payload` jsonb (or a new column if cleaner — decision deferred to PR-F implementer).
- **Schema migrations probably needed for I/J:** `source_webhook_bindings.field_to_content_kind_map` jsonb + `output_webhook_bindings.{target_url, signing_secret_credential_id, retry_policy}` columns + `output_deliveries` audit table for retry/DLQ tracking. Confirm in PR-I/PR-J implementer scope-out before opening the PR.
- **No new ESLint rules.** All five PRs respect the existing four boundary rules + `no-update-append-only`.
- **Light-tier LLM hook exists** in `packages/shared/src/llm-router/` (per PR #7 commit `7be9252`); per-event summary in PR-F adds a calling pattern, not a new tier.
- **The PoC's `Filter Monitored` pattern** (only events with `project_gid` in `asana_monitored_projects` get persisted) maps directly onto opencoo's source-binding scope: one binding = one project gid. Multi-project bindings stay out of scope.

### Deliverables (additional)

| PR | Title | Depends on | Test-first artifact | Acceptance | Verify | Files est. |
|---|---|---|---|---|---|---|
| F | source-asana v2 — handshake + event_type derivation + Light per-event summary | PR #24 (`source-asana` baseline), PR #14 (webhook receiver), PR #7 (llm-router Light tier) | `asana-handshake.test.ts` (X-Hook-Secret echo + persists secret to CredentialStore via `webhookSecretCredentialId`); `asana-derive-event-type.test.ts` (6 enum values + null-for-noise across the 5 fixture payload categories from the PoC); `asana-monitored-filter.test.ts` (events for unbound project_gids drop silently to no-op, never reach intake); `asana-light-summary.test.ts` (≤25-word PL one-liner persisted as event metadata; max_tokens 120; XML-spotlit per §3.4) | `parseEvents` derives `event_type ∈ {created, completed, commented, assignee_changed, due_date_changed, updated}` and drops null (deletions, removals, non-comment stories, task_added_to_project) before emitting `SourceWebhookEvent`; webhook receiver gains a handshake branch that echoes `X-Hook-Secret` + persists to CredentialStore; Light-tier summary attached as `metadata.summary` on the SourceEvent for downstream Compiler consumption; THREAT-MODEL §2 invariant 11 (no raw event payload at info level), §3.4 (Light-summary prompt wraps event content in `<source_content>`) | `pnpm --filter @opencoo/source-asana test` + `pnpm --filter @opencoo/engine-ingestion test webhook-receiver -- handshake` | ~14 |
| G | source-asana v2 — `AsanaClient` + snapshot enrichment | PR-F | `asana-client.test.ts` (REST GET tasks with `opt_fields=name,assignee.name,completed,due_on,modified_at,memberships.section.name&limit=100`; rate-limit retry with jitter; 429-aware backoff; PAT never logged on error per §3.6 invariant 11); `asana-snapshot-emit.test.ts` (on `snapshotMode: 'on-event'`, post-event fetch emits a second SourceEvent with `content_kind: 'asana-project'` containing `{project_gid, snapshot, incomplete_count, overdue_count, fetched_at}`); binding-config schema test (`snapshotMode: 'on-event' \| 'periodic' \| 'off'`, default `'on-event'`); `asana-client.scan.test.ts` (`scan()` returns snapshot rows when `snapshotMode='periodic'`, no-op otherwise) | `AsanaClient` lives in `packages/adapters/source-asana/src/asana-client.ts`; `binding-config.ts` extends with `snapshotMode` + `optFields` (default to the PoC's six fields); adapter emits two SourceEvents per webhook event when `snapshotMode='on-event'`: one for the raw event (PR-F shape) and one for the freshly-fetched snapshot. Asana credentials use the existing `asanaApi` credential pattern via the `credentialStore.getById()` resolution from PR #7 | `pnpm --filter @opencoo/source-asana test:contract` | ~16 |
| H | Compiler template for `content_kind: 'asana-project'` | PR-G, PR #16 (Compiler atomic write), PR #29 (`CONTENT_KINDS` const) | `compiler-asana-project.test.ts` — round-trip test (snapshot → compiled page → re-parsed sections deep-equal expected); preserves YAML frontmatter + `## Notes` section verbatim; rewrites `## Current state` / `## Open tasks` (top 10 incomplete) / `## Recent activity` (last 10 events from `metadata.summary`) / `## Risks`; new-page path creates frontmatter `{title, type: 'asana-project', last_updated, asana_project_gid, status}`; cross-link rewriter respects strategy/ targets; output ≤40k chars or fails closed | New file `packages/engine-ingestion/src/compiler/templates/asana-project.ts`; Polish system prompt + user prompt mirror the PoC `Build Merge Prompt` Code node (5 rules, "ZWROC TYLKO pelny markdown"); Worker tier; per-domain LLM policy enforced; XML-spotlight wraps both the existing-page content and the snapshot JSON per §3.4; `CONTENT_KINDS` registers `'asana-project'` alongside `'document'` and `'n8n-workflow'`. Does NOT bypass DocumentConverter — the compile happens directly from JSON snapshot, like `'n8n-workflow'`. THREAT-MODEL §3.4 (spotlighting on snapshot data), invariant 2 (one wikiWrite per Compiler run) | `pnpm --filter @opencoo/engine-ingestion test compiler -- asana-project` | ~12 |
| I | `source-webhook` — generic webhook SourceAdapter | PR #14 (webhook receiver), PR #15 (Classifier), shared `sourceAdapterContract` | `source-webhook.contract.test.ts` (passes the 9 polling + 3 webhook-mode shared assertions in webhook-mode); `source-webhook-binding-config.test.ts` (zod schema: `pathSegment`, `signingSecretCredentialId`, `eventIdField` jsonpath, `contentKindMap` (jsonpath → CONTENT_KIND), `defaultContentKind`, `reviewMode` default `'review'` per §3.7); `source-webhook-replay.test.ts` (HMAC + replay-stable `event_id` derivation from `eventIdField` + receiver dedupes via `webhook_events` UNIQUE on `(binding_id, event_id)`); `source-webhook-payload-cap.test.ts` (1 MiB ceiling fail-closed, mirrors `source-asana`) | New package `packages/adapters/source-webhook/`; HMAC-SHA256 verifier reused from `@opencoo/shared/webhook-verifier`; binding config supports per-binding mapping of payload fields to `content_kind` so one binding can carry multiple shapes (e.g. an n8n flow that POSTs both "campaign-snapshot" and "lint-finding" payloads to the same URL maps each to a different content_kind); receiver gates on `signature_ok` + `replay_event_id`; `review_mode: 'review'` is the default — operator must explicitly approve a binding to run `auto`. THREAT-MODEL §3.1 (HMAC + replay), §3.7 (review-mode default), §3.6 invariant 11 (no signing-secret bytes in errors) | `pnpm --filter @opencoo/source-webhook test:contract` | ~14 |
| J | `output-webhook` — generic webhook OutputAdapter | PR #24 (`output-asana` baseline + `outputAdapterContract`), PR-I (verifier symmetry) | `output-webhook.contract.test.ts` (passes the 9-assertion `outputAdapterContract`); `output-webhook-signing.test.ts` (outgoing requests carry `X-OpenCoo-Signature: <hex>` HMAC over the body, plus `X-OpenCoo-Delivery-Id: <deterministic uuid>` for receiver-side idempotency); `output-webhook-retry.test.ts` (exponential backoff with jitter, max 5 attempts, `output_deliveries` audit row per attempt; on terminal failure the row carries `status: 'dlq'` and emits an alert event consumable by the Activity tab from PR-B); `output-webhook-no-creds-in-payload.test.ts` (THREAT-MODEL §3.6 invariant 11 — sending credentials from caller never serializes credential bytes into the outbound body) | New package `packages/adapters/output-webhook/`; binding config: `targetUrl`, `signingSecretCredentialId`, `retryPolicy: { maxAttempts: number, baseDelayMs: number }`, `headers: Record<string, string>` (operator-configurable but `Authorization` rejected at config-validate time — credentials route through signing-secret only); new schema migration `0008_output_deliveries.sql` (append-only audit table: `id, output_binding_id, delivery_id, attempt, status, status_code, response_body_excerpt, sent_at, completed_at`); reader agents (Heartbeat / Lint / Chat) MAY trigger `output-webhook` per §2.6 (Output is not wikiWrite, so reader-only invariant holds) — explicit ADR comment in the adapter README to prevent confusion | `pnpm --filter @opencoo/output-webhook test:contract` | ~16 |

### Sequencing (additional)

PR-F and PR-E (badge legibility, observability scope) ship in week 1 — both small, both unblock immediate operator pain (event noise reduction + visual confirmation). PR-G in week 2 alongside PR-B (observability core) — independent code paths, no merge conflicts expected. PR-H in week 3 immediately after PR-G (Compiler template needs the snapshot SourceEvent shape from PR-G). PR-I and PR-J independent of F/G/H — can land any time after PR-A (PR-A's source-binding status surface is what shows them as healthy/advisory/alert in the Sources tab); land in weeks 3–4 in parallel with PR-C and PR-D.

The `0.1.0-a` tag follows once all ten PRs (A–J) are green and §1.3 phase-a exit gate clears. Pilot cutover specifically depends on F + G + H being green; I and J are valuable but not cutover-blocking if Estyl uses `source-asana` exclusively for its Asana state ingestion.

### THREAT-MODEL coverage (additional)

- **§2 invariant 2** (atomic wikiWrite per Compiler run): PR-H's `asana-project` template emits exactly one `wikiWrite` per snapshot compile; round-trip test asserts no double-write path.
- **§2 invariant 8** (append-only): PR-J's `output_deliveries` audit table is append-only; retry attempts insert new rows, never UPDATE prior rows. Status transitions ride the DELIVERY-id-scoped state column.
- **§2 invariant 11** (no raw prompts / credentials in info-level logs): PR-F's Light summary call wraps event content in `<source_content>`; the prompt itself is logged at `debug` only when `LLM_DEBUG_LOG=1`. PR-G's `AsanaClient` scrubs PAT from all error paths via the existing PAT-scrub helper. PR-J's `output-webhook` enforces the no-credential-bytes-in-outbound-payload assertion at the contract level.
- **§3.1** (webhook intake): PR-F's handshake follows the spec (echo `X-Hook-Secret`, persist to CredentialStore). PR-I's generic adapter requires HMAC + replay-stable event_id.
- **§3.4** (XML spotlighting on untrusted content): PR-F Light summary, PR-H Worker merge — both wrap Asana payload data in `<source_content>` before LLM call. PR-G snapshot data going into PR-H prompt is treated as untrusted (Asana task names can carry adversarial content).
- **§3.5** (memory poisoning / cross-domain write): PR-H Compiler template validates `target_path` against the source binding's `allowed_paths` AND lives inside the binding's target domain (existing path-allow-list pattern from PR #15).
- **§3.6 invariant 11** (no credential bytes in errors): PR-G `AsanaClient` + PR-J `output-webhook` HTTP error paths run through the existing scrub helper.
- **§3.7** (review mode defaults): PR-I `source-webhook` defaults `reviewMode: 'review'` for any new binding — untrusted external systems land in the Review queue (PR-C surface) before flowing to compile. Operator explicitly flips to `'auto'` after manual sanity-check.
- **§3.13** (server-side authorization): PR-I and PR-J binding-create flows ride existing `POST /api/admin/source-bindings` / new `POST /api/admin/output-bindings` — both gated by `verifyAdmin` + CSRF + audit-log writer.

### Out of scope (deliberate, additional)

- **`estyl-asana-mcp` port (Asana as MCP tool surface for agents).** Separate decision: would live as a `packages/asana-mcp-server/` analog to `gitea-wiki-mcp-server`. Useful for Heartbeat / Wiki Chat to read live Asana, but distinct from this appendix's "ingest state to wiki" goal. Defer to v0.2 unless a partner asks.
- **`estyl-asana-project-discovery` port.** Weekly REST-list-and-notify pattern; this is a Surfacer-class job (proposes "enable monitoring on project X?" candidate). Belongs in phase-b alongside SkillMiner — same agent shape, different content. The `source-webhook` adapter from PR-I is enough to bridge it from n8n in the meantime.
- **`estyl-asana-reader` port.** Trivial REST wrapper; subsumed into PR-G's `AsanaClient` as a method. No separate package.
- **Multi-project Asana bindings.** One binding = one project gid stays. Multi-project would force the `Filter Monitored` step into the adapter, complicating the contract.
- **Custom Compiler templates per webhook `content_kind`.** PR-I assumes `content_kind: 'webhook-event'` as the default emitted shape; specific templates (`'campaign-snapshot'`, `'lint-finding'`, etc.) are operator-configurable via the binding's `contentKindMap` but the *Compiler* templates for those kinds are separate work — PR-I ships only the generic `'webhook-event'` template.
- **Bidirectional bridge (webhook-in receives → output-webhook fires).** Common pattern but not always desired (loop risk). Operators wire it explicitly per binding pair via the Management UI; no automatic coupling in this appendix.
- **Output retry policy live-tuning from UI.** Retry policy lives in binding config (DB) per §2.5 (UI-first config) — but the live-edit UI for retry policy ships in v0.2. v0.1 operator edits the binding row through the existing source-binding admin form.

### Plan-document edits required (additional)

Single coordinated commit alongside each PR's merge:

- **PR-F merge** — tick `IMPLEMENTATION-PLAN.md` §1.3 row "source-asana v2 ships state-aware ingestion." Update §1.2.12 row title to reflect F–J inclusion. Update progress snapshot.
- **PR-G merge** — tick §1.3 row "Asana snapshot fetcher integrated."
- **PR-H merge** — tick §1.3 row "asana-project Compiler template ships."
- **PR-I merge** — tick §1.3 row "source-webhook generic adapter ships." Add `source-webhook` to `IMPLEMENTATION-PLAN.md` §1.2.6 SourceAdapters list (post-fact, not a new PR row in §1.2.6).
- **PR-J merge** — tick §1.3 row "output-webhook generic adapter ships." Update `architecture.md` §7 OutputAdapter table to list `output-webhook` alongside `output-asana`.

### Critical files referenced (additional, read-only context)

Source-asana baseline (extend, don't fork): `packages/adapters/source-asana/src/{adapter.ts,binding-config.ts,index.ts,testing/}` — adapter.ts:141-198 is `parseEvents` (extend); adapter.ts:201-225 is the factory (extend with optional `AsanaClient` injection).

Webhook receiver (extend for handshake): `packages/engine-ingestion/src/intake/` — receiver gains an Asana-specific handshake branch (or generalizes to per-adapter `handshakeFn` exported by the adapter; pick at PR-F implementation time).

LLM router (Light tier hook for PR-F): `packages/shared/src/llm-router/` — already supports tier='light' from PR #7. PR-F adds a calling pattern (helper for "summarize one event"), not a new tier.

OutputAdapter contract (mirror in PR-J): `packages/shared/src/adapter-contract-tests/output-adapter-contract.ts` (9 assertions). `packages/adapters/output-asana/` is the implementation reference for retry shape.

Compiler templates (add `asana-project.ts`): `packages/engine-ingestion/src/compiler/templates/{document.ts,n8n-workflow.ts}` — `n8n-workflow.ts` is the closer analog (frontmatter-merge from JSON snapshot, no DocumentConverter). PR-H adds `asana-project.ts` as the third template.

Shared CONTENT_KINDS const: `packages/shared/src/content-kinds.ts` (PR #29, commit `8c09365`) — register `'asana-project'`.

PoC reference workflows (READ-ONLY — production traffic on n8n.estyl.team, do not modify during port): `tW2LQOoMeru3ih1q` (snapshot+merge prompt), `TZLsyt2i4OkqwhqQ` (handshake + deriveEventType + monitored filter + Light summary), `Ox19mixecneGrG5Z` + `PKkGmNEDBaBlXGp4` (webhook setup pair). Copy logic, not credentials.
