# Phase-a appendix #15 — Management UI completeness · operator self-service

> **Status:** scoping doc landing as PR-W0; W1–W12 follow.
> **Wave shape:** 12 implementation PRs across 4 sub-waves (A schema · B prompt overrides · C UI completeness · D shell polish), plus W12 closeout.
> **Predecessor:** wave-14 (`docs/plan-appendix/phase-a-14-meaningful-heartbeat.md`) shipped `0.1.0-a.12` on 2026-05-13. The autonomous heartbeat now lands meaningful content on populated AND empty wikis; `allowed_paths` is a first-class binding property; operators can retry failed compile jobs and see intake-state breakdown from the UI. Wave-15 ships as `0.1.0-a.13.*`.

---

## Context

Wave-14 closed the autonomous-heartbeat usefulness gap, but the operator's framing of the running deployment is broader: **the management UI is not a product yet.** A read-only Prompts tab in v0.1 was a deliberate scope-cut — `packages/ui/src/routes/Prompts.tsx:39-75` renders a manifest grid only; `packages/engine-self-operating/src/admin-api/routes/prompts.ts:23-36` returns a (name, locale, version) tuple list with no body and no edit path. Without override capability the tab is a directory listing — the operator cannot adapt agent behaviour to a domain without a code change and a release. Meanwhile every form on the box (Domains, Sources, Agents, Outputs) is **read-mostly with surgical write affordances** — operators flip `enabled`, bind output channels, rotate creds, but cannot edit `retention_days`, `governance_cadence`, `worldview_enabled`, `llm_budget_monthly_cap_usd` on a `domains` row; cannot edit `scope_domain_ids` on an `agent_instances` row (the schema column at `packages/shared/src/db/schema/agent-instances.ts:36-39` has **zero admin-API exposure**); cannot edit `retention_days_override` or `notes` on a `sources_bindings` row; cannot **create** an agent instance from the UI at all (no `POST /api/admin/agent-instances` exists; `Agents.tsx` documents the "+ New" button as a stub). Reports is a third axis: the operator reports it broken, yet the read path at `packages/engine-self-operating/src/admin-api/routes/heartbeat.ts:46-62` is structurally correct (`DISTINCT ON (instance_id)` over `agent_runs.output IS NOT NULL`). Most likely the box has zero matching rows and the UI silently shows "no heartbeats yet" without surfacing real fetch errors or naming the missing precondition. Wave-15 ships empty-state UX + diagnostic surface regardless of whether there's a real bug, so the next operator who looks at Reports knows whether the chain is empty or broken.

Three orthogonal gaps converge into one wave because they share patterns and an information-architecture move. Per-domain overrides for the LLM-policy surface (`packages/engine-self-operating/src/admin-api/routes/domains-llm-policy.ts:128-246`) are **the existing template** for per-(scope) overrides anywhere else — preview-with-server-canonical-diff, sovereignty token bound to scope + payload-hash, 5-min TTL, explicit `confirmDiff:true` apply step, audit-write-before-mutate. The prompt-override surface mirrors this token-by-token, with one additive shape change: prompt overrides admit two scopes (domain AND agent_instance), resolution order `instance > domain > shipped baseline`. The "edit every schema field through the UI" cleanup is a series of small PATCH branches extending the existing single-branch state machine at `domains.ts:85-91` / `agent-instances.ts:90-91, 202-428` / `source-bindings.ts`. The shell polish — shared `TextField` / `Table`, i18n cleanup, sidebar IA — uses an audit pass to retire ad-hoc `<input>` and `<table>` instances against the existing `Field.tsx` foundation (`packages/ui/src/components/Field.tsx:76-166` already handles controlled + uncontrolled + secret modes). After wave-15 every column on every operator table has a UI editor, every prompt can be overridden per-domain AND per-instance with sovereignty-token safety, the operator can create + scope an agent instance without CLI, Reports either works or names what it's waiting for, and the chrome reads as a coherent product rather than a survey of tabs.

---

## Wave roster

- **W0** — scoping doc (this PR). No code.
- **W1** — `prompt_overrides` table + `loadPromptForScope()` runtime resolution with `instance > domain > baseline` precedence. The data + engine layer everything in sub-wave B sits on. No UI.
- **W2** — Per-(domain, instance) prompt-override admin-API: list / preview-diff / apply-with-sovereignty-token / delete, scope-discriminated. Mirror of `domains-llm-policy.ts`. No UI.
- **W3** — Domain row edit-fields completeness: extend `PATCH /api/admin/domains/:id` to cover `retention_days`, `governance_cadence`, `review_role`, `worldview_enabled`, `llm_budget_monthly_cap_usd`. UI fields land in `DomainDetail.tsx`.
- **W4** — Agent-instance CRUD + scope editor: new `POST /api/admin/agent-instances` + PATCH branches for `scope_domain_ids`, `name`, `locale`, `memory_clear`. New "Create agent instance" modal. Highest-impact UI gap.
- **W5** — Source-binding edit-fields completeness: PATCH branches for `retention_days_override`, `notes`, `webhook_secret_credentials_id` rotation. UI fields land in `SourceBindingDetail.tsx`.
- **W6** — Output-channel bulk operations: multi-select + bulk-delete on the Outputs tab. `POST /api/admin/output-channels/bulk-delete`.
- **W7a** — Prompts UI: per-domain override editor with shipped-baseline diff, lagging-overrides banner (replaces hardcoded `lagging=[]` at `Prompts.tsx:49`), domain picker, "what was actually sent" drawer reading `llm_usage_debug`.
- **W7b** — Per-instance override editor: surface in `AgentInstanceDetail.tsx` for the prompts the instance's definition uses. Resolution stack explains the precedence (`Instance override (vN.M)` | `Domain override (vN.M) — wiki-exec` | `Shipped baseline (vN.M)`).
- **W8** — Reports diagnostic surface: empty-state panel naming the missing precondition (no heartbeat instance? no completed run? `output_channel_ids` not bound? `output IS NULL`?), real-error surfacing instead of `setError(t("common.error"))`, regression test against `routes/heartbeat.ts:46-62` query shape.
- **W9** — Shell shared primitives + i18n cleanup: `TextField.tsx` and `TextArea.tsx` lifting inline-input pattern onto `Field.tsx`; `Table.tsx` replacing three open-coded tables on `Reports.tsx:395-496`, `Cost.tsx`, `Audit.tsx`; Reports redaction column headers (`Reports.tsx:406`) and Audit "ip:"/"ua:" prefixes become i18n keys; `formatUsd()` at `Cost.tsx:143-157` accepts `i18n.language`.
- **W10** — IA polish: sidebar groups (Operate / Knowledge / Governance / Diagnostics), breadcrumb header replacing the bare `TopBar` title at `Chrome.tsx:135-165`, `Cmd-K` command palette (jump-to-domain / jump-to-binding / jump-to-prompt-edit / open-run-by-id). Top-level routes preserved.
- **W11** — Design-system audit pass: sweep every screen for gradient / drop-shadow / blur / pill / emoji / marketing-voice violations against `design_system/README.md`. Fix the worst in-place. Verifies accent-color budgets.
- **W12** — Wave-15 closeout: append to `CHANGES-v0.1.md`, update `IMPLEMENTATION-PLAN.md` §1.1 snapshot, add §1.2.25 wave row.

### Ordering / parallelization map

- **Serial:** W0 → W1 → W2. W12 closeout last.
- **Parallel batch 1 (after W2 lands):** W3, W4, W5, W6 — four orthogonal PATCH branches. Dispatch as 4 simultaneous implementer agents.
- **Parallel batch 2 (after batch 1):** W7a, W7b, W8, W9 — W7a/W7b consume W1+W2, W8 depends on W4 (uses `NewAgentInstanceModal`), W9 refactor over batch-1 surfaces. Dispatch as 4 simultaneous.
- **Serial:** W10 depends on W9's `Table.tsx`. W11 audit runs over post-W10 build. W12 last.

Eight serialized steps; two widen to four parallel implementers.

---

## Sub-wave A — Data + engine layer (no UI)

### PR-W1 — `prompt_overrides` schema + `loadPromptForScope()` runtime resolution

**Branch:** `phase-a-appendix-15/w1-prompt-overrides-schema`
**Size:** ~10 files · ~600 lines

Schema column for per-(domain, instance, prompt-name, locale) override bodies + an additive runtime resolver that reads from DB and falls back to shipped baseline. Schema follows the wave-12 `output_channels` shape (`packages/shared/src/db/schema/output-channels.ts`):

```
prompt_overrides
  id                  UUID PK
  domain_id           UUID NOT NULL FK domains(id) ON DELETE CASCADE
  instance_id         UUID NULL     FK agent_instances(id) ON DELETE CASCADE
  prompt_name         TEXT NOT NULL CHECK (prompt_name IN (PROMPT_NAMES…))
  locale              TEXT NOT NULL CHECK (locale IN ('en','pl'))
  body                TEXT NOT NULL CHECK (length(body) <= 100000)
  overrides_version   TEXT NOT NULL    -- semver, bumped on every apply
  baseline_version    TEXT NOT NULL    -- *_PROMPT_VERSION at apply-time
  updated_by_user_id  UUID
  created_at          TIMESTAMPTZ
  updated_at          TIMESTAMPTZ
  UNIQUE (domain_id, instance_id, prompt_name, locale) NULLS NOT DISTINCT
```

`NULLS NOT DISTINCT` (Postgres 15+) treats NULL `instance_id` as a value, so a single domain-scoped row coexists with multiple instance-scoped rows for the same `(domain, prompt, locale)`. If the engine's Postgres minimum is <15 (check `compose.yml`), fall back to the COALESCE-with-zero-UUID pattern.

`loadPrompt()` (`packages/shared/src/prompts/loader.ts:161-174`) gets an additive overload:

- `loadPrompt({name, locale}): LoadedPrompt` — synchronous, baseline-only. **Stays for the injection corpus runner** (`packages/shared/src/prompts/__fixtures__/injection/_runner.ts`).
- `loadPromptForScope({name, locale, domainId, instanceId?, db}): Promise<LoadedPromptWithOverride>` — async, resolves `instance > domain > baseline`. Returns `{ ...LoadedPrompt, override: { scope: 'instance'|'domain'|null, overridesVersion, baselineVersion, isStale } }` where `isStale = override.baseline_version !== current_shipped_version`. The `page_citations.prompt_version` writer records `override.overridesVersion ?? baseline.version` so triage flows still work.

Every existing `loadPrompt` call site that has a `domainId` in scope migrates to `loadPromptForScope`. The corpus runner stays on `loadPrompt`. Tests pin: corpus calls `loadPrompt`, run-time calls `loadPromptForScope`.

**Threat-model:** Body is operator-controlled config reaching the LLM verbatim — same trust class as `domains.llm_policy.system_prompt`. `body.length <= 100_000` capped at write-time (~2x longest shipped prompt). Append-only invariant unaffected — `prompt_overrides` is a state-machine table like `agent_instances`. Injection corpus stays version-pinned because corpus uses `loadPrompt` (no scope arg).

**Tests** (TDD, write first):
- Schema migration applies + UNIQUE allows (NULL instance) coexisting with (specific instance) rows.
- `loadPromptForScope` returns baseline when no override exists.
- `loadPromptForScope` returns domain override when only domain row exists.
- `loadPromptForScope` returns instance override when both domain and instance rows exist (precedence).
- `loadPromptForScope` returns `isStale: true` when `baseline_version` < current shipped.
- `loadPrompt({name, locale})` returns baseline regardless of DB state (corpus invariant).
- Locale fallback (auto → en) preserved.

### PR-W2 — Per-(domain, instance) prompt-override admin-API

**Branch:** `phase-a-appendix-15/w2-prompt-overrides-api`
**Size:** ~7 files · ~550 lines

Routes scope-discriminated by `:scope` ∈ `{domains, agent-instances}`:

- `GET /api/admin/{scope}/:id/prompts` — `{ overrides: [{name, locale, scope, overridesVersion, baselineVersion, isStale, updatedAt, updatedByUsername}], baselines: [{name, locale, version, body}] }`. Baselines bodies inline; override bodies require the per-name GET.
- `GET /api/admin/{scope}/:id/prompts/:name/:locale` — `{ name, locale, body, version, source: "override" | "baseline", scope }`.
- `POST /api/admin/{scope}/:id/prompts/:name/:locale/preview` — body `{proposedBody: string}`. Returns line-level `diff`, sovereignty `token` binding `{scope, scopeId, name, locale, proposedBodyHash, baselineVersion}`, `expiresAt`.
- `POST /api/admin/{scope}/:id/prompts/:name/:locale/apply` — body `{proposedBody, token, confirmDiff: true}`. Token verify: signature + expiry + payload-match + baseline-version-match. 422 `baseline_version_drifted` if shipped rev'd between preview and apply. UPSERT, audit-write-before.
- `DELETE /api/admin/{scope}/:id/prompts/:name/:locale` — clears override (reverts to next-most-specific scope).

For instance scope, the route resolves `domain_id` from `agent_instances.scope_domain_ids` and stores the override row with the instance's primary scope domain — UNIQUE constraint `(domain_id, instance_id, prompt_name, locale)` ensures multiple instances scoped to the same domain remain distinct.

New audit verbs in `admin-api/audit-log.ts` allowlist: `prompt_override.apply`, `prompt_override.delete`. Metadata: `{scope, scope_id, name, locale, payload_hash}`. **Body bytes never enter the audit table.**

**Threat-model:** CSRF + admin-team + audit-write-before-mutate on preview AND apply. Sovereignty token non-replayable across `(scope, scopeId, name, locale, proposedBodyHash)`. Body length capped at 100KB. Diff computation server-side — a client cannot smuggle a fake diff into apply.

---

## Sub-wave B — Schema-completeness PATCH branches (parallel, no inter-dependency)

### PR-W3 — Domain row edit-fields completeness

**Branch:** `phase-a-appendix-15/w3-domain-fields`
**Size:** ~5 files · ~350 lines

Extend `updateDomainSchema` (`packages/engine-self-operating/src/admin-api/routes/domains.ts:85-91`) with `retention_days` (int 1–365), `governance_cadence` (enum from `packages/shared/src/db/schema/enums.ts`), `review_role`, `worldview_enabled` (boolean — flipping `true → false` cancels in-flight worldview compile jobs), `llm_budget_monthly_cap_usd` (numeric ≥0 ≤100_000). UI: `DomainDetail.tsx` "Configuration" section with `Field.tsx` controls. Reuse `changedFields` real-diff pattern at `domains.ts:78-91` (no-op PATCHes write no audit row).

**Threat-model:** CSRF + admin-team. Audit `domain.update` records changed field NAMES + new values (operator-controlled config, never credentials).

### PR-W4 — Agent-instance CRUD + scope editor (highest-impact UI PR)

**Branch:** `phase-a-appendix-15/w4-agent-instance-crud`
**Size:** ~10 files · ~800 lines

`POST /api/admin/agent-instances`: body `{definition_slug, name, scope_domain_ids: string[], locale, schedule_cron?, output_channel_ids?: string[], enabled: boolean}`. `definition_slug` validated against `PROMPT_NAMES`. `scope_domain_ids` validated against `SELECT id FROM domains WHERE id IN (...)`; unknown UUID → 422 with missing list (mirror `agent-instances.ts:298-324`). `name` unique within `(definition_slug, name)` per schema constraint at `agent-instances.ts:59-62` — 409 on collision.

New PATCH branches: `scope_domain_ids`, `name`, `locale`, `memory_clear: true` (zeroes `memory` jsonb).

UI: new `NewAgentInstanceModal.tsx` mirroring `NewDomainModal.tsx` shape. Scope picker reuses the multi-select pattern from `AgentInstanceDetail.tsx`'s output-channel binder. Lift into shared `MultiSelectDomains` component if file diff stays under 400 lines.

**Threat-model:** Every branch CSRF + admin-team + audit. New verbs: `agent_instance.create`, `agent_instance.set_scope`, `agent_instance.set_name`, `agent_instance.set_locale`, `agent_instance.memory_clear`. Scope removal is privilege-reduction (takes effect next dispatch). Memory-clear audit logs `prior_memory_byte_count` not contents.

### PR-W5 — Source-binding edit completeness

**Branch:** `phase-a-appendix-15/w5-source-binding-fields`
**Size:** ~4 files · ~280 lines

Extend the existing PATCH on `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts` with three new branches: `retention_days_override` (1–365 or `null` to clear), `notes` (TEXT, capped at 4096 chars), and `webhook_secret_credentials_id` rotation (mirror the existing `credentials_id` rotation flow already wired in wave-10 PR-R2 — same audit-verb pattern namespaced as `webhook_secret_rotate`). UI: `SourceBindingDetail.tsx` gains the three fields. The notes field is a `<textarea>` via a new `TextArea.tsx` companion to `Field.tsx`.

**Threat-model:** New audit verbs `source_binding.set_retention_override`, `source_binding.set_notes`, `source_binding.webhook_secret_rotate`. `notes` is operator-controlled freeform — explicitly **not** logged into the audit metadata per §3.13 (audit records only `binding_id + caller_username + notes_changed: true`).

### PR-W6 — Output-channel bulk operations

**Branch:** `phase-a-appendix-15/w6-output-channel-bulk-delete`
**Size:** ~3 files · ~200 lines

`POST /api/admin/output-channels/bulk-delete` body `{ids: string[]}`. Per-id audit row (`output_channel.delete` already exists at `audit-log.ts:181`) written before each DELETE. The dispatcher's run-time skip-on-missing-channel behaviour already covers the "deleted channel still referenced in an instance's `output_channel_ids[]`" case. UI: multi-select checkboxes on the Outputs tab grid + "Delete N" button with confirmation modal (reuses the destructive-confirm checkbox pattern from `DomainDetail.tsx`).

**Threat-model:** CSRF + admin-team. One audit row per id (never one row per batch — the audit trail must show each deletion as a discrete event).

---

## Sub-wave C — UI completeness (consumes A + B)

### PR-W7a — Prompts UI · per-domain override editor

**Branch:** `phase-a-appendix-15/w7a-prompts-domain-editor`
**Size:** ~7 files · ~900 lines

Rebuilds `packages/ui/src/routes/Prompts.tsx` (currently 76 lines, read-only grid). New shape:

- **Left rail** — 9 prompts grouped by role (Knowledge: classifier, compiler, worldview-domain, worldview-company; Operate: heartbeat, lint, chat, surfacer, builder).
- **Right pane** — picked prompt: domain picker, side-by-side baseline-vs-override diff textarea, baseline-version chip with `isStale` highlight.
- **Save** → preview opens `DiffPreviewDialog.tsx` (`packages/ui/src/components/DiffPreviewDialog.tsx:1-80` — drop-in reuse, the dialog is generic over diff shape).
- **Lagging-overrides banner** replaces hardcoded `Prompts.tsx:49` with the real list from W2's `isStale` field.
- **"What was actually sent" drawer** — new tiny `GET /api/admin/llm-usage-debug?promptName=&domainId=&limit=5` returns most-recent 5 `prompt_text` rows (truncated to 50KB each). Drawer renders as collapsible JetBrains-Mono cards. Empty banner when `LLM_DEBUG_LOG=1` env is off.

Top-level Prompts tab survives. Domains tab drill-down adds a "Prompts" affordance routing to Prompts with domain pre-selected.

**Threat-model:** Apply via W2's sovereignty token. New `/llm-usage-debug` route admin-team-gated. Body bytes reach the LLM verbatim — operator-controlled by design.

### PR-W7b — Per-instance override editor

**Branch:** `phase-a-appendix-15/w7b-prompts-instance-editor`
**Size:** ~5 files · ~400 lines

Adds an "Agent prompts" section to `AgentInstanceDetail.tsx`. Lists the prompts the instance's definition uses (from a small `definition_slug → prompt_names[]` map in shared — e.g., `heartbeat → ['heartbeat', 'worldview-domain']`). For each prompt:

- Shows the **resolution stack**: `Instance override (vN.M)` | `Domain override (vN.M) — wiki-exec` | `Shipped baseline (vN.M)`. The stack makes "where is this prompt coming from?" answerable at a glance.
- "Edit" button opens the same editor as W7a but with `scope=agent-instances`, `:id=instance.id`. Save uses W2's instance-scoped routes.
- "Clear instance override" button reverts to next-most-specific scope.

Same `DiffPreviewDialog` + sovereignty-token flow.

**Threat-model:** Same as W7a — gated routes already shipped in W2.

### PR-W8 — Reports diagnostic surface + empty-state UX

**Branch:** `phase-a-appendix-15/w8-reports-diagnostics`
**Size:** ~4 files · ~280 lines

Three changes:

1. **Empty-state panel** replaces the silent "no heartbeats yet" notice with a structured precondition check. New `GET /api/admin/heartbeat/preconditions` queries `agent_instances` for `definition_slug='heartbeat'` and `agent_runs` for runs against those instances; lists missing preconditions. Panel renders:
   - "No heartbeat instance configured. [Create heartbeat instance]" → opens W4's `NewAgentInstanceModal` pre-filled.
   - "Heartbeat instance exists but has no `output_channel_ids` bound. [Bind output channel]" → links to `AgentInstanceDetail.tsx`.
   - "Heartbeat instance has 0 completed runs. Last dispatch: <T>. [Run heartbeat now]" → reuses `AgentsRunNowButton.tsx`.
   - "Heartbeat run completed but `output IS NULL`. Most recent run: <T>. [View run details]" → links to Activity tab with the run ID highlighted.
2. **Real-error surfacing** — fix `Reports.tsx:101-113` to surface the underlying fetch error via `safeErrorMessage` from `@opencoo/shared/scrub` instead of swallowing into `setError(t("common.error"))`. Operator sees "401 Unauthorized" or "504 Gateway Timeout" with one line of help text.
3. **Diagnostic shape verification** — read `routes/heartbeat.ts:46-62` end-to-end with a regression test against a fixture dataset that includes (a) heartbeat runs with `output IS NULL`, (b) instance with multiple runs (DISTINCT ON test), (c) orphaned runs (`instance_id IS NULL`). If any fail, ship the fix.

**Threat-model:** Empty-state panel reads `agent_instances` + `agent_runs` counts already exposed by admin-API. No new admin surface beyond the precondition computations done server-side.

### PR-W9 — Shared primitives + i18n cleanup

**Branch:** `phase-a-appendix-15/w9-shared-primitives-i18n`
**Size:** ~13 files · ~650 lines

New `TextField.tsx` — thin wrapper on `Field.tsx`'s discriminated union (`Field.tsx:43-74, 76-166`) providing the controlled-string-input shorthand. `TextArea.tsx` companion for multi-line (consumed by W5's notes field). `Table.tsx` — props-driven (`columns: Array<{key, label, render?, mono?, align?}>` + `rows`, `rowKey`), replaces three open-coded tables on `Reports.tsx:395-496` (redaction events), `Cost.tsx:579+` (bucket breakdown), `Audit.tsx` (log table). Each consumer migrates in this PR.

**i18n cleanup:**
- Reports redaction column headers `Reports.tsx:406` → 6 i18n keys × 2 locales.
- Audit "ip:" / "ua:" prefixes (`Audit.tsx:649-650`) → 2 keys × 2 locales.
- `formatUsd()` at `Cost.tsx:143-157` accepts `i18n.language`; switches `toLocaleString` locale (en-US separators vs pl-PL). Currency stays USD per the existing comment.

**Test plan:** the three migrated pages render byte-identically pre/post-refactor under `en`; the locale-aware bits render with `'pl-PL'` separators under `pl`. Zero behaviour change beyond locale awareness.

**Threat-model:** Pure refactor. Audit verifies no `dangerouslySetInnerHTML` introduced; every cell renders via React text nodes.

---

## Sub-wave D — Shell polish (depends on C)

### PR-W10 — IA polish · sidebar groups · breadcrumbs · Cmd-K palette

**Branch:** `phase-a-appendix-15/w10-ia-polish`
**Size:** ~6 files · ~600 lines

**Sidebar groups** — split flat 11-tab list at `Chrome.tsx:29-50` into four named groups:
- **Operate** — Agents · Outputs · Activity
- **Knowledge** — Domains · Sources · Prompts
- **Governance** — Review · LlmPolicy · Cost · Audit
- **Diagnostics** — Reports

Each group renders a mono-uppercase micro-label above its tabs (reuse `Chrome.tsx:67-86` pattern). Operate first (primary operator task). URL fragments preserved.

**Breadcrumbs** replace bare `TopBar` title at `Chrome.tsx:135-165`. Format: `<group> / <tab>` or `<group> / <tab> / <row-name>` when a drill-down modal is open. JetBrains Mono per type rules.

**Cmd-K palette** — `Modal.tsx`-backdrop overlay; `Cmd-K` / `Ctrl-K` listener at `Chrome.tsx` root. Result sources: domains (`GET /api/admin/domains`), bindings, agent-instances, prompt names. Picking navigates + opens the drill-down with the row pre-selected. Hand-rolled substring + prefix matcher (~80 lines plain JS, no fuzzy lib).

**Threat-model:** Palette is read-only (navigation only). All result lists already admin-gated via underlying GETs.

### PR-W11 — Design-system audit pass

**Branch:** `phase-a-appendix-15/w11-design-system-audit`
**Size:** ~8 files · ~300 lines (mostly delete + replace)

Sweep every screen against `design_system/README.md` "Hard nos":
- No gradients (search `linear-gradient` / `radial-gradient`).
- No drop shadows (search `box-shadow:` outside the heartbeat-pulse keyframe).
- No backdrop-blur / frosted glass.
- No pills (search `border-radius:` ≥ 12px outside `Modal.tsx`).
- No emoji (regex sweep, especially in i18n bundles).
- No marketing voice ("AI-powered", "unlock", "seamless", "intelligent").

Verify accent-color budgets per screen (Advisory Amber under 10%, Wiki Teal only on compiled-knowledge chrome, Alert Red only on destructive/flagged). Lowercase `opencoo` everywhere (no `OpenCoo` / `OpenCOO` / `Open Coo` slips). Confirm heartbeat-pulse is the only motion loop.

Fix in-place. Document violations found + fixed in W12.

### PR-W12 — Wave-15 closeout

**Branch:** `phase-a-appendix-15/w12-closeout`
**Size:** ~2 files · ~180 lines

Append wave-15 closeout to `CHANGES-v0.1.md` (Added / Deferred / Risk-residual structure mirroring wave-14's PR-W7 closeout). Update `IMPLEMENTATION-PLAN.md` §1.1 status snapshot flip from in-flight to closed (this becomes the new authoritative head row). Add §1.2.25 wave row to `IMPLEMENTATION-PLAN.md` mirroring §1.2.24 shape. Ships under `0.1.0-a.13.<final>`.

---

## Verification (wave-end gate against `0.1.0-a.13.<final>`)

**Per-PR gates** (every PR before merge):
- `pnpm lint && pnpm typecheck && pnpm test` green at root.
- THREAT-MODEL §5 PR checklist run.
- GitHub Copilot inline triage cleared.
- Spec reviewer + code-quality reviewer approval.
- New tests pin new behaviour (TDD per `CONVENTIONS.md` §3).

**Wave-end gate:**

1. Pull the new image, restart compose, verify clean boot + migrations applied + `prompt_overrides` table present.
2. **Partner-deployment Chrome QA** — drive a real session against the running box. Verify:
   - Edit `retention_days` on the partner's wiki-domain. Audit row written, value persisted.
   - Create a new agent-instance via UI (heartbeat scoped to two domains). Instance appears, can be enabled, can be dispatched via Run Now.
   - Pick heartbeat in Prompts → pick partner's wiki-domain → edit empty-wiki branch text → Preview → see line-diff dialog + sovereignty-token countdown → Apply. Verify `prompt_overrides` row written, audit row landed.
   - Open `AgentInstanceDetail` for the heartbeat instance → "Agent prompts" section shows resolution stack → edit instance override → verify resolves to instance row on next dispatch.
   - Open "What was actually sent" drawer → most-recent partner-box heartbeat run's `prompt_text` renders.
   - Reports tab — verify empty-state panel names missing precondition (if box empty) OR renders existing reports.
3. **Empty-box Chrome QA** — spin a fresh compose box, no domains seeded. Walk: create domain → bind source → create heartbeat instance scoped to new domain → edit empty-wiki prompt → dispatch heartbeat. Every surface works with zero pre-existing data.
4. **i18n** — switch UI locale to `pl`, walk every tab. No English string literals visible.
5. **Cmd-K palette** — open from every tab, verify navigation, Esc closes, arrow-key scrolling.
6. **Design-system audit** — wave-end re-verifies W11's pass.
7. **THREAT-MODEL §5 maintainer walk** against the wave-15 closing commit. Verify: no PATCH/POST without CSRF; every new audit verb has allowlist entry with metadata doc; no operator-freeform-text in audit metadata; no `dangerouslySetInnerHTML` introduced.
8. **Injection corpus** — `pnpm test --filter @opencoo/shared -- injection` green. Corpus runs against shipped baselines via `loadPrompt({name, locale})`; overrides don't leak in.

---

## Out of scope (explicit, defer)

- **Rich-text / Monaco prompt editor.** Plain `<textarea>` in v0.1.
- **Slack / Email / Discord output adapters.** Wave-14 deferral stands.
- **Skill-marketplace UX.** `marketplace_updates` schema exists; operator accept/skip surface is wave-16 candidate.
- **Audit-log server-side filtering.** Client-side filtering stays per wave-10 PR-R4.
- **Mobile / narrow-viewport.** Desktop operator console; narrow-viewport graceful degradation is v0.2.
- **Real-time co-edit on prompt bodies.** Single-operator deployments today.
- **Worldview-compile preview.** v0.2 nicety; v0.1 ships with operator running `recompile-worldview` after applying and reading the result in Gitea.
- **Per-prompt rate-limit / budget knobs.** Budgeting stays at the domain layer (`domains.llm_budget_monthly_cap_usd`, exposed in W3).
- **3-way merge UI for stale overrides.** W7a's editor shows baseline-vs-override; "re-fork from new baseline" is a button that copies the new baseline into the editor for the operator to manually re-apply edits. Full 3-way visual merge is v0.2.

---

## Reuse — call these, do not reinvent

- **Sovereignty-token primitives** — `packages/engine-self-operating/src/admin-api/sovereignty-token.ts` (157 lines, drop-in for W2).
- **LLM-policy preview/apply pattern** — `packages/engine-self-operating/src/admin-api/routes/domains-llm-policy.ts:128-246` is W2's template token-by-token.
- **Diff-preview dialog** — `packages/ui/src/components/DiffPreviewDialog.tsx:1-80` generic over diff shape; W7a/W7b reuse with line-level diff array.
- **`loadPrompt()` synchronous signature** — `packages/shared/src/prompts/loader.ts:161-174` stays for corpus + non-domain callers; W1 adds additive `loadPromptForScope` overload.
- **`PROMPT_NAMES` / `PROMPT_LOCALES`** — `packages/shared/src/prompts/loader.ts:63-77` are W1's `prompt_overrides.prompt_name` CHECK source-of-truth.
- **Single-branch PATCH pattern** — `packages/engine-self-operating/src/admin-api/routes/agent-instances.ts:90-91, 202-428` is the shape W3/W4/W5 extend.
- **Audit-log allowlist + `writeAuditLog()`** — `packages/engine-self-operating/src/admin-api/audit-log.ts:34-212, 271-299`. Add new verbs in the same PR that uses them.
- **`requireCsrf` + `requireAdminContext`** — `packages/engine-self-operating/src/admin-api/csrf.ts`, `auth.ts:259+`. Apply to every state-changing route.
- **Real-diff `noOp` pattern** — `packages/engine-self-operating/src/admin-api/routes/domains.ts:85-91`. W3/W4/W5 inherit.
- **UUID validation before SQL cast** — `domains-llm-policy.ts:138-140`. Every new route applies.
- **`Modal.tsx` + destructive-confirm checkbox** — `packages/ui/src/components/Modal.tsx`, `packages/ui/src/components/DomainDetail.tsx`. W6 bulk-delete reuses.
- **`Field.tsx` discriminated union** — `packages/ui/src/components/Field.tsx:43-166` is W9's `TextField`/`TextArea` foundation (controlled/uncontrolled/secret/mono modes already exist).
- **`NewDomainModal.tsx` step machinery** — W4's `NewAgentInstanceModal.tsx` mirrors.
- **Multi-select-with-validation** — `agent-instances.ts:298-324` (output-channel resolve + 422 with missing list). W4's `scope_domain_ids` validation copies the shape verbatim.
- **`safeErrorMessage`** — `@opencoo/shared/scrub`. W8's SSE error path uses to surface real errors without leaking internals.
- **`formatUsd` / `formatTokens`** — `packages/ui/src/routes/Cost.tsx:143-157`. W9 makes locale-aware in place.
- **`intake_counts` aggregate** — wave-14 PR-W4 already in `/api/admin/source-bindings`. W8's empty-state panel pattern reuses.
- **`LLM_DEBUG_LOG=1` env + `llm_usage_debug` schema** — `packages/shared/src/db/schema/llm-usage-debug.ts:6-14`. W7a's drawer is the first read consumer.
- **`AgentsRunNowButton.tsx`** — W8's empty-state "Run heartbeat now" CTA reuses.
- **`AgentInstanceDetail.tsx`'s output-channel multi-select** — W4's scope-domain picker copies the shape.
- **`architecture.md` §3.5 invariant** — admin gate = CSRF + admin-team + audit-before-mutate. Every PR's threat-model names this triplet.
