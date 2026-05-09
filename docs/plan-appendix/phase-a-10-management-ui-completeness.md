# Phase-a appendix #10 — management-UI completeness (operator-only product)

> **Status:** scoping doc · 2026-05-09 · seven PRs (R1–R7) across four waves · ~30 hours of agentic work · pointer in `IMPLEMENTATION-PLAN.md` §1.2.18 (added at wave-1 entry).
> Read after `docs/plan-appendix/phase-a-9-live-test-gaps.md` (closed wave) and `IMPLEMENTATION-PLAN.md` §1.3 (exit gate).

---

## Why this exists

After appendix #9 closed on 2026-05-09, an operator following `pilot-runbook.md §1–§4` can drive a fresh `compose down -v` through to `agent_runs.status='success'` without a single shell out to psql. The management UI now covers **bootstrap and first-binding-create**.

But the UI is still **read-mostly** for steady-state operations. Once a domain or binding is created, every later edit — rename, rotate credentials, change locale, change schedule, run an agent right now, look up audit history, see what this is costing — falls off the UI into CLI + psql. The user's instruction (2026-05-08, after the live Chrome session that motivated appendix #9) is to close that gap and make the UI **the only console an operator ever needs**.

The research pass for this appendix surveyed `packages/ui/src/routes/`, `packages/engine-self-operating/src/admin-api/routes/`, `architecture.md` §6 / §7 / §9 / §10 / §13 / §14, `PRD.md` §5, `design_system/`, and `DECISIONS.md`. The headline gaps:

- **No domain edit / soft-delete.** Operator can't fix a typo'd slug, change locale, or retire a domain via UI (`packages/ui/src/routes/Domains.tsx:53–115`).
- **No source-binding edit.** Once created, bindings are locked except enable/disable + review-mode flip; credential rotation needs psql.
- **No on-demand agent execution.** Activity surfaces *what ran*, but no "Run Lint now" or "Re-run this Heartbeat" button.
- **No audit log viewer.** `audit-log-read.ts` admin route exists; nothing consumes it.
- **No cost surface.** `llm_usage` is queryable only as Activity-tab side-info; no "what is this costing me per domain / per agent / this month" view. Budget hard-cap exists but is invisible until it pauses queues.
- **No scheduler editor.** Agent cadences are config-only.
- **PRD §5 criterion 9 is amber** — `source forget` runs, but no impact preview ("3 pages re-compile, 1 deletes, daily cap 7/10").

Wave-10 is the **operator-completeness wave**. Every PR targets a specific cliff where today the operator falls off the UI into psql/CLI. Nothing new in product surface is added — every feature already exists in admin-API or schema; we just expose it in the UI under design-system rules.

## Ground-truth deltas vs assumptions (verified 2026-05-09 against `main @ 8c0c115` — the PR #81 closeout merge)

Each delta cites the file the gap was found in plus one fact that the implementer should not re-investigate.

1. **`POST /api/admin/domains`** exists; `PATCH` and `DELETE` do not (`packages/engine-self-operating/src/admin-api/routes/domains.ts`). The `domains` table has no `disabled_at` column today — wave-10 PR-R1 adds the migration. Hard-delete must refuse with 409 `fk_restricted` if any `sources_bindings` rows reference the domain (mirror PR-Q10b's `isPgForeignKeyViolation` narrowing).
2. **`PATCH /api/admin/source-bindings/:id`** (Q10) accepts only `enabled` toggles. The `config` and `credentials` paths are POST-only (in `createBindingSchema` at `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:109–116`). Extending PATCH to those is the cleanest extension — re-uses Q9's binding-config validator and the existing CredentialStore re-encrypt-on-rotate path.
3. **`POST /api/admin/agents/:slug/dispatch`** does not exist. The CLI verb (`opencoo agents fire <slug>`) does — it routes through `packages/cli/src/provision/agent-runners.ts` (Q2 wrapped this with drizzle). The HTTP dispatch route should call the SAME registry entry, not duplicate it. Rate-limit lives at the route layer (token bucket, in-memory; not a new table).
4. **`GET /api/admin/audit-log`** route exists (`audit-log-read.ts`), is paginated, sanitised at write time, and has 0 UI consumers today. Building the `Audit` route is pure UI — no backend changes.
5. **`llm_usage` rows carry tokens / model / tier / domain / agent / timestamp** (PR 07 schema; ESLint-enforced ownership). Cost summary is one CTE plus a JSON shape. Budget pause state lives in `domain_llm_budgets` (also PR 07); operator-facing burn-down is `(month_to_date_usd, cap_usd, projected_eom_usd)`.
6. **`PUT /api/admin/scheduler/:agent`** does not exist; `GET /api/admin/scheduler` does (`scheduler.ts`). BullMQ's `addRepeatableJob` is idempotent on `(jobId, pattern)` — replacing the schedule is "remove old + add new" inside one Redis transaction. No restart required.
7. **`source forget`** CLI exists (PR #33). It does NOT have a dry-run HTTP route today. The dry-run *logic* lives in `packages/cli/src/commands/forget.ts` — wave-10 PR-R7 lifts the planning step into a route handler and surfaces it via a confirmation modal. The daily cap state for `wikiAdapter.delete` lives in the BullMQ delete-queue counter (`wiki-write` package).
8. **`design_system/preview/` already has Modal, Card, Btn, StatusPill, Badge, CredentialForm-style fields, DiffPreviewDialog, and a heartbeat-pulse glyph.** New UI work in wave-10 must reuse those — do not invent new component shapes. The cost-dashboard's only new component is a stacked-segment bar (which can be a flat composition of `Card` + `<div style="background: var(--ink-2); height: …"`).

## PR roster + sequencing (7 PRs across 4 waves)

### Wave 1 — domain + binding lifecycle (parallel-safe; foundations for wave 2-4)

#### PR-R1 — Domain edit + soft-delete
**Branch**: `phase-a-appendix-10/domain-lifecycle`
**Size**: ~5 files + 1 migration · ~250 lines

**Scope**:
- New migration: `domains.disabled_at TIMESTAMPTZ NULL` + index `(disabled_at, slug)`.
- New `PATCH /api/admin/domains/:id` accepting `{ name?, display_name?, locale?, aggregator? }`. Validates locale against the existing locale enum. Forbids changing `slug` (downstream Gitea repo path is keyed off it; rename is a re-create). Forbids changing `class` once set (catalog vs knowledge is structural).
- New `DELETE /api/admin/domains/:id` — soft-deletes by setting `disabled_at = now()`. Hard-delete (`?hard=1`) refused with 409 `fk_restricted` if any `sources_bindings` reference the domain.
- New `DomainDetail` modal opened on row click in `Domains.tsx`: editable fields + "Disable" + "Delete" with impact-preview (refuses delete with FK count + suggests Disable).
- `Domains.tsx` listing query gains `WHERE disabled_at IS NULL` default + `?include_disabled=1` opt-in (mirror Sources tab pattern).
- Audit kinds: `domain.update`, `domain.disable`, `domain.delete`.
- THREAT-MODEL §5 touch: admin-API write surface +2 verbs.

**Acceptance**: An operator with a typo'd domain slug rebuilds via Disable → create new → Delete-old (refused with binding count) → migrate bindings → Delete-old (succeeds). All steps via UI, no psql.

**Tests**:
- `packages/engine-self-operating/tests/admin-api/domain-update.test.ts` — locale validation, slug-change rejected with 422, class-change rejected with 422, audit row written.
- `packages/engine-self-operating/tests/admin-api/domain-delete.test.ts` — soft-delete sets `disabled_at`; hard-delete with FK = 409; hard-delete without FK = 200; both write audit; concurrent-delete TOCTOU mirrors PR-Q10b's pattern.
- `packages/ui/tests/unit/domain-detail.test.tsx` — edit form submit, delete confirmation, FK warning shape.

#### PR-R2 — Source-binding edit (config + credential rotation)
**Branch**: `phase-a-appendix-10/binding-edit`
**Size**: ~6 files · ~350 lines

**Scope**:
- Extend `PATCH /api/admin/source-bindings/:id` (currently `enabled`-only) to accept `config` (validated against the adapter's `bindingConfigSchema` — same path as POST, so Q9's validator is reused) and `credentials` (writes a NEW credential row, rotates `credentials_id` on the binding, never logs plaintext).
- Old credential row stays (audit trail) — it's marked `superseded_at = now()`. Cleanup pipeline (existing) prunes after retention TTL.
- `SourceBindingDetail` (Q10) gains an "Edit" mode toggle: re-uses Q9's binding-config wizard step + Q11's CredentialForm grouped labels for the existing creds. Edit-mode banner advises "Rotating credentials does not pause the binding — in-flight events finish on the old key, new events use the new key."
- New audit kinds: `source_binding.config_update`, `source_binding.credentials_rotate`.

**Acceptance**: An operator can fix a wrong `projectGid` on an Asana binding and rotate its PAT entirely via UI; the binding's BullMQ workers pick up the new config on the next scheduled tick (or next webhook-triggered event); no event-loss; no psql.

**Tests**:
- `packages/engine-self-operating/tests/admin-api/source-binding-update-config.test.ts` — config PATCH validates against bindingConfigSchema, partial update preserves untouched keys, audit row written.
- `packages/engine-self-operating/tests/admin-api/source-binding-rotate-credentials.test.ts` — rotation increments `credentials.encryption_version`; old plaintext is unreachable; audit redacts plaintext.
- `packages/ui/tests/unit/source-binding-detail.test.tsx` — Edit mode toggle, partial-config update flow, credential-rotation flow with PatEntryModal reuse.

### Wave 2 — observability completion (after R1/R2 merge so detail modals reuse the patterns)

#### PR-R3 — On-demand agent execution
**Branch**: `phase-a-appendix-10/agents-run-now`
**Size**: ~5 files · ~280 lines

**Scope**:
- New `POST /api/admin/agents/:slug/dispatch` — body `{ domainSlug, instanceSlug?, dryRun? }`. Wraps the same BullMQ enqueue path the scheduler uses (DRY against `packages/cli/src/provision/agent-runners.ts`). Returns `{ runId }` so the UI can deep-link to the new run.
- Rate-limit (5 dispatches/hour/agent/user) — token bucket in-memory, no new table. 429 with `Retry-After` header on bucket-empty.
- "Run now" buttons appear on:
  - `Activity > Pipelines` per-agent card (queue a fresh run scoped to current domain selector).
  - `Reports > Heartbeat` "Refresh now" (same dispatch, instanceSlug = the heartbeat instance backing this report).
  - `Review > Lint findings` "Re-run lint" (dispatches lint scoped to the domain whose findings are visible).
- Button states: idle → "Run now" · pending → "Queued · 12s" with the heartbeat-pulse glyph (the only allowed motion loop) · running → SSE feed updates the run card · done → reverts to idle.
- THREAT-MODEL §5 touch: admin-API write surface +1.
- Audit kind: `agent.dispatch_now` with `{ slug, domainSlug, runId }`.

**Acceptance**: An operator notices a misconfiguration in Lint findings, fixes it (R2 rotation), clicks "Re-run lint" — within ~30s sees the new run in Activity feed and the Review tab refreshes with the corrected findings.

**Tests**:
- `packages/engine-self-operating/tests/admin-api/agents-dispatch.test.ts` — happy path returns runId; rate-limiter trips at 6th call within an hour; unknown slug = 404; missing domain = 422; `dryRun: true` enqueues the BullMQ job with the dry-run flag.
- `packages/ui/tests/unit/agents-run-now-button.test.tsx` — button state transitions; SSE-driven status updates; rate-limit feedback shape.

#### PR-R4 — Audit-log viewer
**Branch**: `phase-a-appendix-10/audit-log-viewer`
**Size**: ~4 files · ~220 lines

**Scope**:
- New `Audit` route + tab at `/Audit`. Consumes existing `GET /api/admin/audit-log` (already paginated). No new admin-API.
- Filter chips: action type (multi-select from enum, populated from audit row distinct values cached client-side), actor user (free-text), resource type, ISO date range. Sticky pagination (50/page).
- Row click → expandable JSON payload (sanitized — pat/secret values pre-redacted by the audit writer).
- JetBrains Mono for the JSON view; Geist for chrome.
- No motion; no spinners (skeleton rows during fetch).

**Acceptance**: An operator investigating "who changed the LLM policy on wiki-pilot last Wednesday?" filters by `action=llm_policy.apply` + `resource=wiki-pilot` + date range, finds the row, reads the diff payload — without psql.

**Tests**:
- `packages/ui/tests/unit/audit-log-viewer.test.tsx` — filter combinations (single, multi-select, date-range), pagination, deep-link to specific audit row, large-payload truncation (>50KB collapses with "show full" toggle), empty-state.

### Wave 3 — cost + cadence (parallel-safe)

#### PR-R5 — Cost analytics dashboard
**Branch**: `phase-a-appendix-10/cost-dashboard`
**Size**: ~6 files · ~400 lines

**Scope**:
- New `GET /api/admin/cost-summary?period=month|week|day&groupBy=domain|model|tier|agent` — aggregates `llm_usage` rows. CTE-based; the read query is one Drizzle expression; no new table. Returns `{ totalUsd, byBucket: [{ key, totalUsd, tokensIn, tokensOut, runs }], budgetState: [{ domainSlug, capUsd, usedUsd, projectedEomUsd, paused }] }`.
- New `Cost` route at `/Cost`. Top: this-month total, projected month-end (linear extrapolation from days-elapsed), budget burn-down per domain (with a Healthy-Green / Advisory-Amber / Alert-Red threshold mapping at 50% / 80% / 100% of cap).
- Below: stacked-segment bar by tier (Thinker / Worker / Light), table by `domain × agent` with cost + runs columns.
- Heartbeat-pulse glyph on the "live spending" indicator (the only allowed motion loop per design-system).
- `--advisory` accent for projected-overrun warnings (under 10% of screen, agent-layer only — operator advisory). `--alert` only on actually-paused (cap met) state.
- THREAT-MODEL §5: read surface only; no new write paths.

**Acceptance**: An operator opens `/Cost` and sees that `wiki-pilot`'s month-to-date is on track for $42 vs $50 cap; clicks the bar to drill-down; sees that 78% of the spend is Thinker tier on `compiler` agent; can decide whether to pin a cheaper model on the LLM-policy editor.

**Tests**:
- `packages/engine-self-operating/tests/admin-api/cost-summary.test.ts` — aggregate math against fixture rows; linear-projection edge cases (first day of month, last day, mid-month); budget-pause integration; groupBy combinations.
- `packages/ui/tests/unit/cost-dashboard.test.tsx` — burn-down threshold transitions; stacked-segment math; empty-state for no usage.

#### PR-R6 — Scheduler / cadence editor
**Branch**: `phase-a-appendix-10/scheduler-editor`
**Size**: ~5 files · ~240 lines

**Scope**:
- New `PUT /api/admin/scheduler/:agent` — payload `{ cron: string }` validated via per-agent cron schema (cron-parser library; node-cron format). Restart-free: BullMQ `removeRepeatableJob(jobId, oldCron)` + `addRepeatableJob(jobId, newCron)` inside one Redis transaction. The agent's next tick fires on the new schedule.
- `Activity > Pipelines` per-agent card gains an "Edit schedule" inline form: human-readable cadence picker (every weekday at HH:MM / every Sunday at HH:MM / first-of-month / custom cron). Custom-cron mode shows a "next 5 fires" dry-preview using cron-parser locally.
- Audit kind: `scheduler.update` with `{ agent, oldCron, newCron }`.
- Tests: cron parse round-trip; "next 5 fires" matches BullMQ's actual schedule (via `BullMQ.Job.repeatOptions`); invalid cron rejected with friendly message; concurrent edit serialised by the Redis transaction.

**Acceptance**: An operator changes Lint cadence from weekly Sunday 03:00 to bi-weekly first-Sunday 03:00; the next-5-fires preview shows the right dates; the change persists across an engine restart; the audit log records the change.

**Tests**:
- `packages/engine-self-operating/tests/admin-api/scheduler-update.test.ts` — happy path, cron-parse rejection (422), unknown agent slug (404), audit row written, BullMQ schedule reflects.
- `packages/ui/tests/unit/scheduler-editor.test.tsx` — cadence-picker → cron round-trip, custom-cron preview, invalid-cron friendly error, schedule-applied feedback.

### Wave 4 — close PRD §5 criterion 9 + polish

#### PR-R7 — `source forget` impact preview
**Branch**: `phase-a-appendix-10/forget-impact-preview`
**Size**: ~4 files · ~200 lines

**Scope**:
- New `POST /api/admin/source-bindings/:id/forget?dryRun=1` — returns `{ pagesRecompiled: string[], pagesDeleted: string[], citationsRemoved: number, dailyDeleteCapState: { used: number, cap: number } }`. Field names match the audit payload below (single canonical shape — past-tense, plural for the affected-set arrays). Lifts the dry-run logic from `packages/cli/src/commands/forget.ts` into the route handler (DRY against the CLI verb).
- `?dryRun=0` (or omitted) does the actual forget — BullMQ-enqueues the recompile + delete jobs, audited.
- Sources row drill-down (Q10) "Delete" path now opens an `ImpactPreviewDialog` showing the impact + an explicit `<input type="checkbox">` ("I understand X pages will recompile and Y will delete") that must tick before the destructive button enables. Mirrors the design-system rule: destructive items get `--alert`, never `--advisory`.
- Closes PRD §5 criterion 9 (currently amber).
- Closes architecture.md §6.4 page-citation impact-preview commitment.
- Audit kind: `source_binding.forget` with `{ pagesRecompiled, pagesDeleted, citationsRemoved, capUsedBefore, capUsedAfter }`.

**Acceptance**: An operator forgets a no-longer-needed Drive source; the dialog shows "3 pages re-compile, 1 deletes (today's cap: 1/10)"; checkbox + confirm; within minutes the listed pages re-compile (visible in Activity) and the deleted page is gone from Gitea.

**Tests**:
- `packages/engine-self-operating/tests/admin-api/source-binding-forget.test.ts` — dry-run does NOT enqueue compile jobs; daily cap reflects today's prior deletes; idempotent dry-run; non-dry-run audits with full impact rows.
- `packages/ui/tests/unit/impact-preview-dialog.test.tsx` — checkbox-gates-destructive-button; cap-exhausted shows different copy; dialog reuses Modal.tsx shape.

## Cross-cutting design system commitments

Every PR must obey:

- **`--advisory` (Advisory Amber) only on agent-layer advisories** (R3 dispatch CTAs, R5 over-budget projection) — under 10% per screen.
- **`--alert` (Alert Red) only on destructive items** (R1 disable/delete, R2 credential rotate, R7 forget). Never for "field invalid"; that's `--ink-3` (the muted-text color in the type system).
- **`--healthy` (Healthy Green) for ok/compiled state** (R5 burn-down under 50%, R6 schedule-applied feedback).
- **`--wiki` (Wiki Teal) only on compiled-knowledge chrome** — R7's "pages re-compile" list uses it for path badges; nowhere else in this wave.
- **JetBrains Mono for IDs, paths, cron strings, audit-log JSON, cost figures.** Geist for prose chrome. Instrument Serif italic *only* if we add an empty-state lede (probably not in this wave).
- **No spinners** on the run-now button — flip the button to "Queued · 12s" with the heartbeat-pulse glyph and let the SSE feed update it. The heartbeat pulse on the operate glyph is the *only* motion loop in the entire app.
- **Border + background shift for depth**, never drop shadows. New modals reuse `Modal.tsx`'s sheet shape (radius cap 10px). No backdrop-blur / frosted glass.

## Per-PR agent-team workflow

Same 8-stage pipeline as appendices #4–#9: implementer in worktree → `code-simplifier:code-simplifier` (skip for R4, R6 — light surface area) → `superpowers:code-reviewer` → triage → open PR → CI + Copilot triage loop → merge.

**Drive cadence**:
- Wave 1 (R1, R2): both parallel; merge any order.
- Wave 2 (R3, R4): R3 depends on R2's PATCH cookie/CSRF flow being stable; R4 is pure read so parallel-safe with everything.
- Wave 3 (R5, R6): independent.
- Wave 4 (R7): solo, after R1+R2 (uses both audit + PATCH paths).

**Cross-PR file overlap**:
- `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts` — R2 + R7 (R7 lands after R2).
- `packages/ui/src/routes/Activity.tsx` — R3 + R6.
- `packages/ui/src/components/SourceBindingDetail.tsx` — R2 + R7 (R7 reuses the detail modal).

**Chrome QA**: All 7 PRs are UI-visible. Every PR ships a Chrome screenshot pair (before / after) attached to the PR body.

## Critical files to be modified (cross-PR map)

| File | Touched by |
|---|---|
| `packages/shared/drizzle/00XX_*.sql` (new — disabled_at) | R1 |
| `packages/engine-self-operating/src/admin-api/routes/domains.ts` | R1 |
| `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts` | R2 + R7 |
| `packages/engine-self-operating/src/admin-api/routes/agents-dispatch.ts` (new) | R3 |
| `packages/engine-self-operating/src/admin-api/routes/audit-log-read.ts` | R4 (no edit; UI consumer) |
| `packages/engine-self-operating/src/admin-api/routes/cost-summary.ts` (new) | R5 |
| `packages/engine-self-operating/src/admin-api/routes/scheduler.ts` | R6 |
| `packages/ui/src/routes/Domains.tsx` | R1 |
| `packages/ui/src/routes/Sources.tsx` | R2 + R7 |
| `packages/ui/src/routes/Activity.tsx` | R3 + R6 |
| `packages/ui/src/routes/Audit.tsx` (new) | R4 |
| `packages/ui/src/routes/Cost.tsx` (new) | R5 |
| `packages/ui/src/routes/Reports.tsx` | R3 (run-now wiring) |
| `packages/ui/src/components/DomainDetail.tsx` (new) | R1 |
| `packages/ui/src/components/SourceBindingDetail.tsx` | R2 + R7 |
| `packages/ui/src/components/CredentialForm.tsx` | R2 (reuse, no logic change) |
| `packages/ui/src/components/ImpactPreviewDialog.tsx` (new) | R7 (and shared with R1's hard-delete confirmation) |
| `packages/ui/src/locales/{en,pl}.json` | R1, R2, R3, R4, R5, R6, R7 (every PR adds its operator-facing strings) |
| `docs/pilot-runbook.md` | R1, R2, R3, R5, R6 (operational sections) |
| `IMPLEMENTATION-PLAN.md` (§1.2.18 added at wave-1 entry) | first PR of wave-1 |
| `CHANGES-v0.1.md` (Appendix #10 section) | last PR of wave-4 |

## Reuse — existing utilities the implementers should call, not reinvent

- `packages/shared/src/scrub/safe-error.ts:safeErrorMessage` — for any new error-bubble path (PR-P3 from appendix #8).
- `packages/ui/src/components/CredentialForm.tsx` — R2 reuses for credential rotation.
- `packages/ui/src/components/Modal.tsx` + `PatEntryModal.tsx` patterns — R1's DomainDetail + R7's ImpactPreviewDialog mirror this shape.
- `packages/ui/src/components/SourceBindingDetail.tsx` — Q10's drill-down; R2 toggles into Edit mode, R7 wires the Forget impact dialog from its destructive-action path.
- `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:isPgForeignKeyViolation` (PR-Q10b) — R1's hard-delete path mirrors the 23503-narrowing pattern.
- `packages/cli/src/commands/forget.ts` — R7 lifts its dry-run logic; do NOT duplicate. Either move the logic into `packages/shared` or have the route handler call the CLI's exported planner.
- `packages/cli/src/provision/agent-runners.ts` (Q2 drizzle-wrapped) — R3's HTTP dispatch route calls the SAME registry entry, not a parallel path.
- `packages/shared/src/audit/` — every new write surface emits an audit row using the existing helper. No new audit table.

## Verification per PR + overall

**Per-PR gates** (every PR before merge):
- `pnpm lint && pnpm typecheck && pnpm test` green at root
- New tests cover the failure mode the PR closes (every gap above must have a regression test in the same PR)
- THREAT-MODEL §5 PR checklist run + linked
- Copilot inline triage cleared before merge
- Chrome screenshot pair (before / after) attached to the PR body

**Wave-end gate**:
- `RUN_REAL_PILOT=1 pnpm test:live-pilot` (Q14 nightly) green at the closing commit. Wave-10's new write surfaces should not regress the appendix-#9 chain.
- A full Chrome walkthrough mirroring `pilot-runbook.md §1–§4` plus the new operations: rename a domain → rotate a binding's credentials → run heartbeat now → view audit log → view cost dashboard → change Lint cadence to biweekly → forget a source with impact preview. All steps must be UI-only.

## Out of scope (deliberate defer)

- **Bulk import / export** — useful for new deployments, rare for steady-state operators; defer to v0.2.
- **Adapter marketplace UI** — phase-c PR #43 ships live-fetch + Review-Dashboard item type 5; ship there.
- **Skill candidate review** — phase-b PR #35 (SkillMiner). Wave-10 stays out of `catalog_candidate` table.
- **User / team / permission management** — Gitea-team-based by design (architecture.md §13); not relitigating in v0.1.
- **Worldview drill-down + on-demand compile** — useful, but the architectural debate around aggregator-vs-domain refresh boundaries is unsettled (DECISIONS.md candidate); push to v0.2 unless a partner asks for it.
- **Per-domain prompt overrides** — `PromptsDiffBanner` is mounted with empty data awaiting v0.2 override-store schema; not in this wave.

## Skills the main thread will invoke during execution

Same suite as appendices #4–#9: `superpowers:subagent-driven-development`, `superpowers:dispatching-parallel-agents`, `superpowers:requesting-code-review`, `superpowers:verification-before-completion`, `superpowers:using-git-worktrees`. Implementer agents discover + invoke `superpowers:test-driven-development` and `superpowers:systematic-debugging` from their own skill list.

## Estimated scope

~2300 lines across 7 PRs / 4 waves / ~30 hours of subagent-driven implementation work. Same shape as appendix #9 (~2500 lines / 15 PRs / ~36 hours) but 7 PRs each carrying more weight. Expect similar drive cadence: a wave merges every 4–6 hours of wall-clock once dispatched; CI + Copilot triage adds ~1 hour per PR.
