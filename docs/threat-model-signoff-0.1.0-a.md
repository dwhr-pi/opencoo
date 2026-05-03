# THREAT-MODEL §5 sign-off — `0.1.0-a` candidate

> Versioned per release tag. Pre-filled by `pnpm threat-model:preflight`
> against the candidate closing commit; the maintainer reviews each
> item, spot-checks the cited `path:line` refs for the 8 maintainer-
> judgment items remaining after the 5 automatable checks (items 2,
> 3, 4, 5, 6, 7, 8, 11), and signs the closure block at the bottom.
>
> Companion docs: `THREAT-MODEL.md` (the source-of-truth checklist),
> `IMPLEMENTATION-PLAN.md` §1.3 (phase-a exit gate), `CHANGES-v0.1.md`
> (residual advisories for context).

---

## Header

| Field | Value |
|---|---|
| Closing commit | `2deccd1` (`docs(plan,changes): record phase-a appendix #7 close (PR-O1, PR-O2, PR-O3)`) |
| Run timestamp | `2026-05-03` |
| `THREAT-MODEL.md` SHA at run | `6df3581` (`feat(cli,self-op,ui): doctor webhook enum + output-webhook onDlq SSE wiring (PR-L) (#52)`) |
| Pre-flight script run | `bash scripts/threat-model-preflight.sh` (output captured below) |
| Maintainer | _to be filled at sign-off_ |
| Tag-recommendation | _GO / STOP / MORE-WORK — to be filled at sign-off_ |

---

## §5 12-item checklist (against `2deccd1`)

The §5 checklist (`THREAT-MODEL.md:317-332`) holds 12 line-bullet
items. Each is annotated below with its status, evidence, and a
sign-off line.

Status legend:
- ✓ VERIFIED — automated check or pre-cited evidence covers the item.
- ⚠ NEEDS MAINTAINER JUDGMENT — pre-cited at `path:line` for spot-check.
- ✗ BLOCKED — fails the check; maintainer must decide whether to add a §7 entry or fix-then-re-run.

---

### Item 1 — "No invariant from §2 violated (or a §7 entry exists + reviewer ack)."

`THREAT-MODEL.md:321`

**Status**: ✓ VERIFIED

**Evidence**:
- Automated (Check 1 of pre-flight) — `pnpm lint` clean. The five ESLint boundary rules cover invariants 2 / 5 / 8 / 9 / 10:
  - `opencoo/no-direct-gitea-write` (invariant 2) — see `eslint.config.js:38`.
  - `opencoo/no-direct-llm-sdk` (invariant 5) — see `eslint.config.js:39`.
  - `opencoo/no-update-append-only` (invariant 8 + the `recorder.completeRun()` carve-out) — see `eslint.config.js:41`.
  - `opencoo/no-feature-env-vars` (invariant 9) — see `eslint.config.js:40` + the rule's allow-list at `tools/eslint-plugin-opencoo/src/rules/no-feature-env-vars.ts:12-102`.
  - `opencoo/no-cross-engine-import` (invariant 10) — see `eslint.config.js:37`.
- Invariants 1 / 3 / 4 / 6 / 7 / 11 are convention-enforced; spot-check coverage:
  - Invariant 1 (no cross-domain writes) — classifier path validation at `packages/engine-ingestion/src/classifier/`.
  - Invariant 3 (XML spotlighting) — corpus tests under `packages/shared/prompts/__fixtures__/injection/` (Check 2 of pre-flight).
  - Invariant 4 (Zod structured output on classifier+compiler) — `packages/engine-ingestion/src/classifier/schema.ts`, `packages/engine-ingestion/src/compiler/`.
  - Invariant 6 (credentials by ID, not value) — `packages/shared/src/credential-store/`.
  - Invariant 7 (Gate 3 stays manual) — four-layer enforcement landed in PR 24 / `b522215` (type / schema / runtime / source-grep).
  - Invariant 11 (no raw prompts at info) — `Logger` interface contract in `packages/shared/src/logger/`.

**Sign-off**: __________ / __________

---

### Item 2 — "The matching §3 section's 'must do / must not do' items are satisfied."

`THREAT-MODEL.md:322`

**Status**: ⚠ NEEDS MAINTAINER JUDGMENT (per-PR spot-check)

**Evidence**:
- Every PR in the §1.2.1–§1.2.15 set carried an inline §5 checklist in its commit body — recent examples to spot-check:
  - PR-O3 #60 commit body lines 95-114 (`951aae7` — Surfacer activation).
  - PR-N3 #57 (`aa64e10` — `HttpMcpToolClient` + `AgentRunnerRegistry`).
  - PR-O2 #61 (`26126f1` — `agents fire <slug>`).
- Cross-cutting §3 surfaces touched in phase-a + appendices and where to spot-check the contract:
  - §3.1 SourceAdapter — `packages/adapters/source-{drive,asana,fireflies,n8n,webhook}/src/adapter.ts` (each declares `credentialSchema` + uses `webhook_secret_credentials_id` for the HMAC-shaped split).
  - §3.4 Classifier+Compiler — `packages/engine-ingestion/src/{classifier,compiler}/` (atomic per-run `wikiWrite`, `page_citations`, `Worldview-Impact` trailer at `packages/shared/src/wiki-write/wiki-write.ts:46`).
  - §3.5 `wikiWrite` — `packages/shared/src/wiki-write/wiki-write.ts:67` (sole sanctioned write path; commit-message tags `[compiler]` etc.).
  - §3.13 Review Dashboard — `packages/engine-self-operating/src/admin-api/index.ts:119,132-145` (`verifyAdmin` + CSRF issue endpoint).
  - §3.14 `gitea-wiki-mcp-server` — `packages/gitea-wiki-mcp-server/src/resources/{worldview,wiki}.ts` (PR-O1 added `wiki://` URI registration; PAT-scoped reads).
  - §3.15 CLI — `packages/cli/src/commands/doctor.ts:102-124` (`INTERNET_FACING_PATHS` enumeration).

**Sign-off**: __________ / __________

---

### Item 3 — "New adapter? `credentialSchema` with `x-credential-field: { secret: true }` on secrets."

`THREAT-MODEL.md:323`

**Status**: ⚠ NEEDS MAINTAINER JUDGMENT (one new schema since `HEAD~30`)

**Evidence**:
- Automated (Check 4 of pre-flight) — adapters with `credentialSchema`-touching changes since `HEAD~30`:
  - `packages/adapters/output-webhook/src/adapter.ts:127` (PR-J, generic `output-webhook` adapter).
- Reference shape — `packages/adapters/output-asana/src/adapter.ts:74` is the established pattern; `output-webhook` follows it.
- Maintainer spot-check: confirm every secret field in the `output-webhook` schema marks the field for management-UI masking + at-rest encryption per §3.1.

**Sign-off**: __________ / __________

---

### Item 4 — "New LLM call? Through `llm-router`. Tokens + cost + latency recorded. Spotlighting on inputs."

`THREAT-MODEL.md:324`

**Status**: ⚠ NEEDS MAINTAINER JUDGMENT

**Evidence**:
- Automated — the `opencoo/no-direct-llm-sdk` rule (covered by Check 1) prevents `@ai-sdk/*` imports outside `packages/shared/src/llm-router/` — every LLM call goes through the router by construction.
- Router records `llm_usage` row per call: see `packages/shared/src/llm-router/router.ts` for the metadata persist path.
- New LLM call sites added in appendix #4–#7:
  - PR-F (`source-asana` Light per-event summary) — `packages/adapters/source-asana/src/light-summary.ts` (`summarizeAsanaEvent`).
  - PR-N3 + PR-O3 real-LLM gated tests under `packages/engine-self-operating/tests/agents/*.real-llm.test.ts`.
- Spotlighting verified in the prompt-injection corpus (Check 2 of pre-flight — 10/10 deterministic tier passes).
- Maintainer spot-check: any new `generateText` / `streamText` invocation in the diff against `0.1.0-a` precursor must show the router on the call path AND wrap untrusted content in `<source_content>` per §3.4.

**Sign-off**: __________ / __________

---

### Item 5 — "New wiki write? Through `wikiWrite`. Frontmatter provenance populated. Worldview-Impact trailer set."

`THREAT-MODEL.md:325`

**Status**: ⚠ NEEDS MAINTAINER JUDGMENT

**Evidence**:
- Automated — the `opencoo/no-direct-gitea-write` rule (covered by Check 1) prevents non-provisioning code from importing the Gitea API client; only `wikiWrite` writes.
- Provisioning carve-out (the one allow-listed exception) — `packages/engine-self-operating/src/composition/gitea-provisioning.ts` (named function `provisionDomainRepo`); allow-list in `eslint.config.js`.
- Frontmatter provenance fields populated by `packages/engine-ingestion/src/compiler/frontmatter.ts:79-80` (`compiled_at`, `prompt_version`, `schema_version`).
- `Worldview-Impact` trailer recognised at `packages/shared/src/wiki-write/interface.ts:75` and emitted from the compiler at `packages/shared/src/wiki-write/wiki-write.ts:46`.
- New write-side adapters in appendix #4: `source-asana` snapshot enrichment writes `asana-project` content_kind via the existing compiler pipeline (PR-G, PR-H — `packages/engine-ingestion/src/compiler/asana-project.ts:220`).
- Maintainer spot-check: any NEW path under `packages/engine-ingestion/src/compiler/` since `0.1.0-a` precursor that doesn't already populate the four frontmatter fields above is a violation.

**Sign-off**: __________ / __________

---

### Item 6 — "New webhook? HMAC verified. Rate-limited. Payload-size capped."

`THREAT-MODEL.md:326`

**Status**: ⚠ NEEDS MAINTAINER JUDGMENT

**Evidence**:
- Automated — the production webhook receiver mounts at `packages/engine-ingestion/src/intake/webhook-receiver.ts:211` (`app.post<{...}>`) — see Check 5 of pre-flight.
- HMAC verifier shape — `HmacSha256Verifier` constructed in `packages/cli/src/provision/production-composition.ts` and threaded into the receiver per PR-N1.
- Payload-size cap — `BuildServerOptions.bodyLimit` 5 MB ingestion-side cap; PR-N1 extended `engine-scaffold` to thread this through.
- Webhook adapters touched in appendix #4: `source-asana` v2 (PR-F: `X-Hook-Secret` handshake + `deriveEventType` + monitored-project filter); generic `source-webhook` (PR-I).
- Doctor enumerates webhook surfaces dynamically per binding at `packages/cli/src/commands/doctor.ts:333-337` (`computeWebhookPath`).
- Maintainer spot-check: every new `/webhooks/*` route must show HMAC verification through the receiver's `webhookVerifier` field; a custom verifier must scrub bytes via `scrubPat` per `packages/shared/src/scrub/pat-scrub.ts:62`.

**Sign-off**: __________ / __________

---

### Item 7 — "New admin UI action? CSRF token. Server-side authz recheck. Audit log row."

`THREAT-MODEL.md:327`

**Status**: ⚠ NEEDS MAINTAINER JUDGMENT

**Evidence**:
- Automated (Check 5 of pre-flight) — admin-API routes touched since `HEAD~30`:
  - `packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:235,418` (POSTs).
  - `packages/engine-self-operating/src/admin-api/routes/lint-findings.ts:163` (POST acknowledge).
  - `packages/engine-self-operating/src/admin-api/routes/{agent-runs,events,heartbeat,pipelines,redaction-events,scheduler}.ts` (read-only GETs).
- CSRF gate primitive — `verifyAdmin` + `requireCsrf` wrapped per route by the `wrapAdmin` helper at `packages/engine-self-operating/src/admin-api/index.ts:147+` (state-changing handlers get `verifyAdmin + requireCsrf`; read-only listing routes get `verifyAdmin` only — see admin-API index.ts:14-17 contract comment).
- Audit log — `admin_audit_log` table (append-only); audit row inserted on every state-changing action per PR 28 (`#31 / 3aa9b56`).
- Maintainer spot-check: every new `args.app.post(...)` under `packages/engine-self-operating/src/admin-api/routes/` must thread through `wrapAdmin` (or attach `verifyAdmin` + `requireCsrf` directly) AND insert an `admin_audit_log` row.

**Sign-off**: __________ / __________

---

### Item 8 — "New internet-facing route? Listed in §4.1. `opencoo doctor` updated to enumerate it."

`THREAT-MODEL.md:328`

**Status**: ⚠ NEEDS MAINTAINER JUDGMENT

**Evidence**:
- Automated (Check 5 of pre-flight) — route declarations changed since `HEAD~30` (full list in pre-flight output below).
- `INTERNET_FACING_PATHS` enumeration at `packages/cli/src/commands/doctor.ts:102-124` (currently 18 paths covering admin-API + scheduler + 3 named webhook adapters; lines 117-119 are comment lines describing the scheduler entry).
- Generic `webhook` adapter routes added per PR-I and surfaced dynamically via `computeWebhookPath` at `packages/cli/src/commands/doctor.ts:333-337` (covers the appendix #2 `webhook_secret_credentials_id` split too).
- §4.1 surfaces (THREAT-MODEL.md:272-276): webhook receiver + Management UI + `gitea-wiki-mcp-server`. No new internet-facing surfaces added in phase-a appendices #5–#7 — all the new routes are admin-API additions inside the existing UI surface.
- Maintainer spot-check: the route grep in Check 5 of pre-flight catches additions; cross-check each against `INTERNET_FACING_PATHS` and the §4.1 surface list.

**Sign-off**: __________ / __________

---

### Item 9 — "New env var for feature config? **Stop.** §2 invariant 9 — it goes in Postgres and UI."

`THREAT-MODEL.md:329`

**Status**: ✓ VERIFIED

**Evidence**:
- Automated (Check 1 of pre-flight) — `opencoo/no-feature-env-vars` clean. The rule's allow-list at `tools/eslint-plugin-opencoo/src/rules/no-feature-env-vars.ts:12-102` is the canonical inventory.
- Automated (Check 3 of pre-flight) — one residual `process.env.NODE_ENV` read at `packages/engine-self-operating/src/admin-api/cookie-attrs.ts:67`. `NODE_ENV` IS in the allow-list (line 21 of the rule); the read is the secure-by-default `Secure` cookie attribute toggle from PR #39 (appendix #3). Not a violation.
- Phase-a appendices added five infrastructure-config env vars (NEVER feature config), all allow-listed with rationale:
  - `MCP_BEARER_TOKEN` + `MCP_BASE_URL` (PR-N3) — gitea-wiki-mcp-server transport. Same shape as `GITEA_PAT`.
  - `N8N_MCP_BEARER_TOKEN` + `N8N_MCP_BASE_URL` (PR-O3) — n8n-mcp transport for Surfacer's template catalog. Same rationale.
  - `GITEA_PROVISION_ORG` (appendix #2) — Gitea org for domain repos.
- All five accept the `_FILE` Docker-secrets variant per the established convention.

**Sign-off**: __________ / __________

---

### Item 10 — "Tests: use-case in-memory (no Docker), adapter contract test, LLM calls through `MockLLMClient`. (§14.3)"

`THREAT-MODEL.md:330`

**Status**: ✓ VERIFIED

**Evidence**:
- Automated — the foundation checkpoint after PR 7 (per `IMPLEMENTATION-PLAN.md:130`) holds: `pnpm test` at root passes with every use-case test in-memory, no Docker, no network.
- Test counts at HEAD `2deccd1` (per `IMPLEMENTATION-PLAN.md:23`): 1660+ passed | 2 skipped (use-case + adapter-contract tiers), 88 prompt-injection deterministic-tier passed | 11 skipped (separate `pnpm test:injection` lane), 4 e2e specs.
- `MockLLMClient` recording workflow — `packages/shared/testing/record-llm.ts` shipped as part of PR 7 (per `IMPLEMENTATION-PLAN.md:130`).
- Real-LLM tier gated `RUN_REAL_LLM=1` via the `*.real-llm.test.ts` naming convention; ESLint carve-out at `eslint.config.js:154-159`.
- e2e tier (`pnpm test:e2e`) runs against compose-spun fixture Gitea + Postgres + Redis on the release-tag CI job; ≤10 min wall-clock budget per PR 32 (`#35 / f7eba78`).

**Sign-off**: __________ / __________

---

### Item 11 — "Credentials never appear in logs, even at `debug` level. Grep your new code."

`THREAT-MODEL.md:331`

**Status**: ⚠ NEEDS MAINTAINER JUDGMENT (the grep)

**Evidence**:
- Convention enforced via the shared scrub helper at `packages/shared/src/scrub/pat-scrub.ts:62` (`scrubPat`).
- Three current production sites for the local `safeError` pattern (each applies `scrubPat(...).slice(0, 200)`):
  - `packages/cli/src/provision/production-composition.ts:90-93`.
  - `packages/cli/src/commands/agents-fire.ts:79-82`.
  - `packages/engine-ingestion/src/workers/production-context.ts` (cited in production-composition's header comment).
  - PR-P3 (sibling of this PR in appendix #8) extracts these to `@opencoo/shared/scrub` to eliminate the drift target reviewers flagged across PR-N3 + PR-O2 + PR-O3.
- Negative-assertion test pattern established by PR-N3: 3 tests in `packages/engine-self-operating/tests/mcp-tool-client/http.test.ts` prove the bearer NEVER appears in any log payload or thrown error. Mirrored by PR-O3 for n8n-mcp client.
- Maintainer grep — recommended one-liner against the closing commit's diff:
  ```
  git diff 0.1.0-a..2deccd1 -- packages/ \
    | grep -E '^\+.*(log|console)\.' \
    | grep -vE 'scrubPat|safeError'
  ```
  Lines that survive both filters need eyeballing for raw secret-shaped values.

**Sign-off**: __________ / __________

---

### Item 12 — "If the PR introduces residual risk, §7 updated."

`THREAT-MODEL.md:332`

**Status**: ✓ VERIFIED (no §7 promotion needed — see "§7 delta" section below for rationale).

**Evidence**: §7 promotion question for the appendix-#7 advisories is settled in this doc's "§7 residual-risk delta" section. Decision: KEEP IN CHANGES Residual; rationale documented below.

**Sign-off**: __________ / __________

---

## §7 residual-risk delta since `0.1.0-a` baseline

`THREAT-MODEL.md:358-369` lists 12 §7 entries (data rows in the source table; the appendix-#8 plan's "14" was a bullet-line scan that double-counted the markdown header `|` and `|---|` separator rows). Phase-a appendices have closed three:

### Closed by appendices #4–#7 (no §7 entry was ever added; the gap was always architectural, not a residual)

- **gitea-wiki-mcp `wiki://` URI registration** — closed by PR-O1 (`ec3efb2` / #59). Heartbeat / Lint runners now resolve `wiki://{slug}/{path}` against the server's resource registry instead of `McpResourceNotFoundError`-ing on every dispatch.
- **Surfacer omitted from runner registry when `availableTemplateSlugs.length === 0`** — closed by PR-O3 (`951aae7` / #60). Vendored ~3-template baseline now registers Surfacer by default; live n8n-mcp activation gives ~10 category-level slugs.
- **No manual-trigger CLI for scheduled agents** — closed by PR-O2 (`26126f1` / #61). `opencoo agents fire <slug> [--dry-run]` ships.

### Current §7 entries (carry forward; `THREAT-MODEL.md:358-369`)

The 12 entries below remain accepted as-is for `0.1.0-a`. None
require fresh acknowledgement at tag time — each entry's "what
triggers revisit" column already names the conditions under which
maintainer action is required.

Current count: 12 active entries (entry #11 stale; flagged for
tag-time deletion per below).

1. Zero-day prompt injection slipping past spotlighting + guard.
2. `agent_runs.tool_calls[].result` not output-redacted.
3. Builder overlay repo tampering.
4. Insider-erasure via direct Postgres write on audit tables.
5. `ENCRYPTION_KEY` host-compromise defeats in-container posture.
6. Gitea CVE inheritance.
7. Stale worldview proceeds with warning, not block.
8. Chat session memory retains content within one MCP session.
9. Docling / Ollama / MarkItDown sidecar supply chain.
10. LLM provider ToS retention (partner-owned).
11. ~~No hard LLM spend cap today~~ — **CLOSED by PR 07** (`#8 / 7be9252`); `llm_budget_monthly_cap_usd` ships with fail-closed enforcement. Should be removed from §7 at `0.1.0-a` tag.
12. Custom-agent authoring UI threats.

### Landed-but-unrecorded residuals (advisory) — should they be promoted to §7?

Three advisories landed in `CHANGES-v0.1.md` Residual sections during
appendices #5–#7. Question: should any be promoted to a `THREAT-MODEL.md`
§7 entry?

- **Surfacer category-as-slug semantic regression** (CHANGES Appendix #7, line 447). _Decision_: KEEP IN CHANGES Residual. _Rationale_: this is a **product semantics gap** (Surfacer proposes per-category instead of per-template) — not a security residual risk. There's no unmitigated threat: Builder still gates on the catalog the operator activates, the workflow still deploys disabled, Gate 3 is still non-configurable. The fix is a product feature (n8n-mcp shipping a per-template `keyword`/`slugs` mode); it doesn't belong in a security checklist.
- **Duplicate `pg.Pool` + `LlmRouter` per process** (CHANGES Appendix #6 line 401, Appendix #7 line 448). _Decision_: KEEP IN CHANGES Residual. _Rationale_: this is an **operational efficiency target** — both pools close cleanly on SIGTERM and neither leaks at runtime. No security surface is exposed by the duplication. Refactor to shared instances is a follow-up; THREAT-MODEL.md isn't where it belongs.
- **Post-merge regression caught at appendix #7 close** (CHANGES Appendix #7 line 449). _Decision_: NO §7 ENTRY (already-fixed). _Rationale_: the missing `await` in `agents-fire.ts:191` was caught and patched in commit `153a198` before this sign-off doc. Not a residual; not even an open issue. PR-P2 (sibling appendix-#8 PR) installs a postmerge hook so the class doesn't re-occur.

**Net §7 delta for `0.1.0-a`**: zero new entries; one existing entry (#11, no LLM spend cap) is stale-and-should-be-deleted (closed by PR 07 in phase a).

---

## Pre-flight script output (run against `2deccd1`)

The output below was captured by running `pnpm threat-model:preflight`
in the worktree at HEAD `2deccd1`. The maintainer should re-run the
script if there is any drift from this run; otherwise, this fragment
is the evidence backing items 1, 2, 3, 8, 9 above.

(Note: the outer fence below uses 4 backticks because the captured
preflight output itself contains 3-backtick fences — a 3-backtick
outer would terminate at the first inner fence and break rendering.)

````
## §5 Automatable Checks (run 2026-05-03 against 2deccd1)

> Paste this fragment into `docs/threat-model-signoff-0.1.0-a.md` (or per-tag equivalent).
> Diff base for "new since" checks: `HEAD~30`.

### Check 1: pnpm lint passes (boundary rules covering §2 invariants 2/5/8/9/10)

  ✓ lint clean

### Check 2: pnpm test:injection passes (prompt-injection corpus, §4.2 phase-a ship-blocker)

  ✓ injection corpus passes

  ```
   Test Files  1 passed (1)
        Tests  10 passed (10)
  ```

### Check 3: No raw `process.env.X` reads in production code

  ⚠ found `process.env.X` reads in production code — verify each is allow-listed:

  ```
  packages/engine-self-operating/src/admin-api/cookie-attrs.ts:67:  if (process.env.NODE_ENV !== "development") parts.push("Secure");
  ```

  (Cross-check against `tools/eslint-plugin-opencoo/src/rules/no-feature-env-vars.ts` allow-list.)

### Check 4: New `credentialSchema` exports since `HEAD~30`

  ⚠ adapters with credentialSchema-touching changes — verify every secret field is masked:

  - `packages/adapters/output-webhook/src/adapter.ts` (verify schema marks every secret field as encrypted/masked per §3.1)

### Check 5: New internet-facing routes since `HEAD~30`

  ⚠ route declarations changed since `HEAD~30` — cross-check each against `packages/cli/src/commands/doctor.ts:INTERNET_FACING_PATHS`:

  packages/engine-ingestion/src/intake/webhook-receiver.ts:211:  app.post<{
  packages/engine-self-operating/src/admin-api/index.ts:133:  args.app.get(
  packages/engine-self-operating/src/admin-api/routes/agent-runs.ts:39:  args.app.get("/api/admin/agent-runs", async (req) => {
  packages/engine-self-operating/src/admin-api/routes/agent-runs.ts:84:  args.app.get("/api/admin/agent-runs/:id", async (req, reply) => {
  packages/engine-self-operating/src/admin-api/routes/events.ts:72:  args.app.get(
  packages/engine-self-operating/src/admin-api/routes/heartbeat.ts:39:  args.app.get("/api/admin/heartbeat", async () => {
  packages/engine-self-operating/src/admin-api/routes/lint-findings.ts:51:  args.app.get("/api/admin/lint-findings", async () => {
  packages/engine-self-operating/src/admin-api/routes/lint-findings.ts:163:  args.app.post(
  packages/engine-self-operating/src/admin-api/routes/pipelines.ts:51:  args.app.get("/api/admin/pipelines", async () => {
  packages/engine-self-operating/src/admin-api/routes/redaction-events.ts:41:  args.app.get("/api/admin/redaction-events", async (req) => {
  packages/engine-self-operating/src/admin-api/routes/scheduler.ts:60:  args.app.get("/api/admin/scheduler", async () => {
  packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:134:  args.app.get("/api/admin/source-bindings", async () => {
  packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:235:  args.app.post(
  packages/engine-self-operating/src/admin-api/routes/source-bindings.ts:418:  args.app.post(
  packages/shared/src/engine-scaffold/server.ts:51:  app.get("/health", async () => {
  packages/shared/src/engine-scaffold/server.ts:55:  app.get("/ready", async (_req, reply) => {

  Internal-only routes (BullMQ workers, in-process Fastify probes) are fine.
  External-reachable routes MUST be enumerated in `INTERNET_FACING_PATHS`.

---

End of automatable checks. These 5 checks reduce 4 of THREAT-MODEL §5's
12 line-bullet items to ✓ (items 1, 9, 10, 12). The remaining 8 items
need maintainer judgment beyond the script:

  - Items 3, 4, 5, 7 — touched by the automatable checks above but
    still need a maintainer eye (credentialSchema secret flag / LLM
    call through router + spotlighting / wiki write provenance /
    admin UI action CSRF + audit).
  - Items 2, 6, 8, 11 — pure per-PR §3 read (matching §3 section
    satisfied / webhook HMAC + cap / internet-facing route in
    INTERNET_FACING_PATHS / credentials never in logs grep).

All 8 are pre-cited at `path:line` in the sign-off doc.
````

---

## Closure block

| Field | Value |
|---|---|
| §5 status | _CLEAN / NEEDS WORK_ — to be filled |
| §7 status | _UP TO DATE / NEW ENTRIES NEEDED_ — to be filled |
| Recommendation | _GO / STOP / MORE-WORK_ — to be filled |
| Maintainer signature | __________ / __________ |

When the maintainer fills the closure block, this doc lands in a
follow-up commit on `main` and the `IMPLEMENTATION-PLAN.md` §1.3
"THREAT-MODEL §5 PR checklist" exit-gate item ticks. The remaining
open exit-gate item — partner cutover sign-off — is partner-side and
out of scope for this doc.
