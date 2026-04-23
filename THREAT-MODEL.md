# opencoo — Security Implementation Guide

> Developer-facing checklist for building opencoo safely. Consult **before** starting a new package, **before** opening a PR, and **before** tagging a release. Scoped to the OSS v0.1 implementation described in `docs/ARCHITECTURE.md` (contributor-facing) / `architecture.md` (internal design-of-record; local, gitignored).
>
> Supersedes the earlier STRIDE-style threat model. Git history preserves the prior structure if you want the academic framing. This doc is the one you keep open while coding.

---

## 1. How to use this document

- **Before writing code** in a new package, read §2 (non-negotiables) and the matching §3 section.
- **Before opening a PR**, run the §5 PR checklist.
- **Before tagging a release**, run the §6 release checklist.
- **When you touch a new threat surface** (new adapter type, new agent tool, new auth path, new internet-facing route), update the matching §3 section in the same PR. If you're leaving residual risk, add an entry to §7.

This document is incomplete by design — no static threat model survives real code. Its job is to keep the invariants visible and make sure mitigations aren't silently dropped. Trust it as a checklist, not an exhaustive audit.

---

## 2. Non-negotiables

Architectural invariants. Any PR violating one without a §7 entry and explicit acknowledgement is reverted.

1. **No cross-domain writes.** Classifier's `target_pages[].path` must validate against the source binding's `allowed_paths` AND live inside the binding's target domain. (architecture.md §6.6 layer 2)
2. **`wikiWrite` is the sole sanctioned write path** for compiled pages, worldview, index, log, and `schema.md`. Direct Gitea API writes from engine code are forbidden except in the one-time provisioning job. (§16.2)
3. **XML spotlighting on every LLM call that includes untrusted or LLM-generated content.** Ingested source bytes, wiki re-reads, worldview, external-content memory — all wrapped in `<source_content>` / `<worldview>` before reaching any prompt. (§6.6 layer 1, §7.5)
4. **Structured output only from Classifier + Compiler.** Zod-typed JSON with schema validation on response. No free-form prose field. (§6.6 layer 2)
5. **No LLM request bypasses `packages/shared/llm-router/`.** Every provider call goes through the router so per-domain `llm_policy` is enforced and `llm_usage` metadata is recorded. (§8.2, §11)
6. **Credentials referenced by ID, never by value, in adapter payloads.** Applies to every adapter that emits payloads the engine persists. (§12)
7. **Gate 3 (automation activation) stays manual and non-configurable.** No admin toggle, no env var, no CLI override. (§7.2.4)
8. **Append-only tables** (`page_citations`, `redaction_events`, `erasure_log`, `miner_suppressions`, `agent_runs`) are never UPDATEd or DELETEd by engine code. Retention pruning in Cleanup is the only exception.
9. **`.env` never contains feature config.** Only `DATABASE_URL`, `ENCRYPTION_KEY`, `PORT`, `ADMIN_BOOTSTRAP_TOKEN` and their `_FILE` variants. Everything else lives in Postgres + UI. (§4.7, §15.4)
10. **`packages/engine-ingestion/` and `packages/engine-self-operating/` never import each other.** Enforced by ESLint boundaries. Coordination via Postgres, BullMQ, or Gitea. (§2.5)
11. **Never log raw prompts or responses at `info` level.** Metadata only. Content goes to `llm_usage_debug` if `LLM_DEBUG_LOG=1`; that table has a 7-day TTL. (§6.7, §11)

---

## 3. Per-subsystem implementation guides

### 3.1 `packages/adapters/source-*` (SourceAdapter)

**Must do:**
- Declare `credentialSchema` as JSON Schema with `x-credential-field: { secret: true }` on every secret field. The UI masks/encrypts based on this.
- Reference credentials by vault ID in every `SourceEvent` — never inline raw tokens/keys even in metadata.
- For webhook-mode adapters: HMAC-verify every request against a provider-specific shared secret from the credentials vault. Validation failure throws `ValidationError` (ErrorClass = Validation → immediate DLQ, no retry per §6.5).
- Enforce `max-bytes` on `fetch()` returns. Default 25 MB; override with rationale in the adapter's README. Return `SourceAdapterError` above the ceiling, not OOM.
- Set `source_kind` on every `SourceEvent`. Use reserved values (§6.2); emit `unclassified` only if genuinely unknown.
- Set `content_kind` explicitly on every event. Default `document`; structured payloads (`n8n-workflow`, `skill-bundle`) take the bypass path (§6.3.1) and must travel with their `payload` field.
- Synthesize a deterministic `source_revision` for sources without stable revisions — the intake idempotency key depends on it (§6.5).

**Must not do:**
- Do not bypass the DocumentConverter for document sources. The `content_kind ≠ 'document'` branch is an exception gated by the architecture, not a default.
- Do not log payload bytes at `info` level. Debug only.
- Do not persist credentials or fetched content outside the caller-provided lifecycle (no adapter-local caches without explicit design review).
- Do not trust filename or MIME type from the source provider for security decisions — always re-detect.

**Contract tests (shared suite all SourceAdapters must pass):**
- `HMAC missing → ValidationError` (webhook mode)
- `HMAC invalid → ValidationError` (webhook mode)
- `payload > max_bytes → SourceAdapterError` — no OOM, no silent truncate
- `fetch() return contains no raw credential values` (linted via fixture)
- `dedupe on replayed event_id → no second intake row`

**Architecture already handles:** spotlighting of returned bytes (§6.6 layer 1), normalization (§6.3), classifier structured-output validation (§6.6 layer 2), per-binding `review_mode` defaulting to `approve` for transcription (§6.4).

### 3.2 `packages/adapters/converter-*` (DocumentConverterAdapter)

**Must do:**
- Fail closed on malformed input — return `ConversionError`, never partial output that silently loses structure.
- Trigger `extraction_degraded` routing when you detect structure loss (XLSX with no GFM pipes in output, PPTX with zero headings). (§6.3 "three failure modes")
- Apply `packages/shared/text-normalize/` before emitting Markdown — NFC + control-strip + whitespace-collapse, exactly once, at the router edge.
- If the adapter is a sidecar (`docling-serve`, MarkItDown, Marker partner-wired): document the required network posture — prefer `network_mode: none` + shared volume. If egress is required, document why.

**Must not do:**
- Do not embed arbitrary HTML / JS from source content into the output stream. Strip script/style/iframe before Markdown emission.
- Do not follow external references (image URLs, OLE embeds, XSLT) during conversion without a per-adapter opt-in.
- Do not execute macros, scripts, or formulas from source documents under any circumstances.

**Architecture already handles:** per-domain sovereignty gating — a local-pinned domain rejects cloud converters at the router (§6.3). Marker / MinerU explicitly not bundled (license).

### 3.3 `packages/adapters/guard-*` (GuardAdapter)

**Must do:**
- Declare `role` (`injection` / `content_safety` / `redaction`) and `categories` in the adapter export. The engine routes based on these.
- For `role: 'redaction'`: return `transformed_text` alongside scores. The engine mutates payload in place from this field. Every hit writes a `redaction_events` row — populate `category`, `pattern_version`, `matched_byte_range`.
- For `role: 'injection'` / `'content_safety'`: never modify input text; return scores only.
- Honor `fail_mode` from the instance config (`block` / `review` / `log_only` / `transform`). Default `review` for injection/safety, `transform` for redaction.

**Must not do:**
- Do not log the matched content itself in `redaction_events` — only metadata (category, byte range, pattern version).
- Do not share state across calls. Guards are stateless per `classify()` invocation.

**Architecture already handles:** default pattern list seeded on catalog-class domain creation (§6.6). Upgrade banners for new defaults. Per-domain pattern config (not instance-wide).

### 3.4 Classifier + Compiler (`packages/engine-ingestion/pipelines/`)

**Must do:**
- Validate Classifier output with Zod. Every `target_pages[].path`:
  - Must match source binding's `allowed_paths` (glob).
  - Must resolve inside the binding's target domain (no `../`, no cross-domain).
  - Rejection is silent DLQ, not retry — the Classifier is not allowed to "try again" to escape the allow-list.
- Compiler commits per classifier run are **atomic** — all pages in one `wikiWrite` call, one Gitea commit, or the whole run DLQs. No partial state. (§6.5)
- Every page write must populate frontmatter compile provenance: `schema_version`, `prompt_version`, `compiled_at`, `compiled_by_run_id`. (§15.6, §16)
- Assign `Worldview-Impact` per commit (`high` / `medium` / `low`) on the git trailer. Classifier prompt owns the assignment rule. (§9.4)
- On every page write, insert `page_citations` rows for every `source_ref` cited. Required for `opencoo source forget` (§6.7).

**Must not do:**
- Do not call `wikiWrite` more than once per classifier run — batch all writes into one call.
- Do not permit `allowed_paths: ["**"]` to silently succeed. The Management UI rejects on creation, but engine code also refuses at runtime with a clear error.
- Do not route `worldview.md` or `schema.md` writes through the document Compiler. Those have dedicated pipelines / provisioning.

**Architecture already handles:** BullMQ queue-per-domain at `concurrency: 1` (§16.2). Stale-SHA pull-retry. Append-only citations table.

### 3.5 `packages/shared/wiki-write/`

**Must do:**
- Enumerate modes in the exported type: `'replace' | 'append' | 'delete'`. Deleting is a first-class sanctioned operation (§6.7 uses it); currently underspecified in §16.2.
- Tag commit messages by caller: `[compiler]`, `[lint]`, `[builder]`, `[review-applied]`, `[schema-edit]`, `[catalog-rename]`, `[catalog-unarchive]`, `[skill-supersede]`. Downstream audit depends on these.
- Use service-account git author (`opencoo-compiler@<instance>`, etc.) for machine commits; human-approved commits use the reviewer's Gitea user with `Co-authored-by: opencoo-compiler@<instance>` trailer. (§16.1)
- Respect the per-domain BullMQ queue (`concurrency: 1`). Never open a second queue or a per-file lock.
- **Delete-mode per-domain daily cap.** Fail-closed above threshold (default 10/day) unless the caller is `opencoo source forget` with admin authorization. Prevents compromised-Compiler mass-delete.

**Must not do:**
- Do not short-circuit the queue for "urgent" writes. There is no urgent write.
- Do not permit writes outside the domain's Gitea repo — paths are pre-validated at caller; `wikiWrite` re-validates as belt-and-suspenders.

### 3.6 `packages/shared/credential-store/`

**Must do:**
- Implement the `CredentialStore` interface so v0.1's app-layer AES-256-GCM is swappable for KMS/Vault later without schema changes. (§17 Resolved "Credentials vault")
- AAD binds ciphertext to credential ID. Never reuse an IV.
- Maintain `encryption_version` column. Reads tolerate old versions; writes always use current.
- Source `ENCRYPTION_KEY` via the `_FILE` convention first, env var second, error third. No defaults. (§15.4)
- Log credential *access* (not value) to the Execution Log — who resolved which credential when, for audit.

**Must not do:**
- Do not log decrypted values. Not at any level. Not even in error messages.
- Do not return plaintext from public APIs that cross a package boundary unless the caller is the adapter that will use it in the same function call.
- Do not accept `ENCRYPTION_KEY` shorter than 32 bytes. Validate at boot.

### 3.7 `packages/shared/llm-router/` + `cost-tracker/`

**Must do:**
- Enforce per-domain `llm_policy` at every call. A domain pinned to local Ollama hard-rejects cloud-provider calls — return a typed error, don't silently fall back.
- Record metadata on every call: `timestamp, engine, tier, model, pipeline/agent, document/run_id, tokens_in, tokens_out, cost, latency`. Write to `llm_usage`.
- When `LLM_DEBUG_LOG=1`: write prompt + response to `llm_usage_debug` (7-day TTL enforced by Cleanup). Otherwise never.
- **Per-domain monthly spend cap** (nullable `llm_budget_monthly_cap_usd` on `domains`): on breach, pause the domain's queues and emit an admin alert. Fail-closed.
- Prompt-version metadata comes from `packages/shared/prompts/{locale}/...` file tag — read once, pass through.

**Must not do:**
- Do not include full prompt/response in `llm_usage`. Metadata only.
- Do not allow adapter code to instantiate Vercel AI SDK clients directly. Router owns provider instantiation; lazy per-provider imports.
- Do not pick a fallback model silently if the policy-pinned model is unreachable. Surface the error.

### 3.8 Agent harness (`packages/engine-self-operating/harness/`)

**Must do:**
- Inject worldview + wiki reads into every agent call wrapped in `<worldview>` / `<source_content>`. (§7.5)
- Enforce `AgentDefinition.budget` per invocation — hard cap tokens + cost, not advisory.
- Write every run to `agent_runs` with tool calls, inputs, outputs, tokens, cost, latency, status. This table is the audit substrate AND the memory substrate (§7.4).
- Resolve `skills: SkillRef[]` through the skill-loader, honoring `skills_budget_tokens` and precedence (`overlay > marketplace > builtin`). Record resolved `[{slug, version, sha, source}]` to `agent_runs.skills_used`.
- **Harness-level deny-list for destructive MCP tools** — block `delete-repo`, `delete-branch`, force-push, even when the agent's Gitea PAT would permit them. Architecture gap today; close it in the harness.
- Instance-scope memory loads (`agent_runs.instance_id = self`) by default.

**Must not do:**
- Do not resolve tools via a registry at runtime — tools are imported directly at definition time. Prevents custom-agent elevation.
- Do not load agent memory without spotlighting *external content* inside the memory. Memory of the agent's own reasoning is fine raw; external content it quoted is not. Memory-poisoning cascade is otherwise live.
- Do not silently proceed on stale worldview beyond `stale_threshold_hours` without a warning log.

### 3.9 First-party agents: Heartbeat, Lint, Chat

**Heartbeat must do:**
- Declare `memory: { type: 'previous_runs', count: 3 }` by default. Per-instance configurable.
- Declare `grounding: { worldview: [<own-domain>], company_worldview: true }` by default.
- Output-channel binding is per-instance — ceo-heartbeat cannot accidentally write to ops-heartbeat's Slack.

**Lint must do:**
- Detect contradictions, stale pages, orphans, missing cross-refs, stale projections, **automation drift** (§7.2.5), **redaction-pattern-disabled bindings**, **`allowed_paths: ["**"]` bindings**, **prompt-version drift**.
- Emit synthetic `Worldview-Impact: high` trailer when a contradiction points at a worldview-level fact.

**Chat must do:**
- Scope responses to the caller's Gitea PAT. Never read outside that scope, even if the user asks nicely ("ignore your scope" is prompt injection).
- Per-session memory only. Never persist across sessions.

**Must not do (all three):**
- Do not invoke `wikiWrite` — these agents are readers. Builder is the only write-side agent.
- Do not emit output containing raw wiki content from a domain outside the caller's scope, even if the prompt injection instructs it. Spotlighting is the mitigation, not the cure.

### 3.10 Surfacer + Builder (automation loop)

**Must do:**
- Surfacer writes `automation_candidates` rows with `status: 'proposed'`. Gate 1 is the state transition to `'approved'`; Surfacer never self-approves.
- Builder runs only on `status: 'approved'` candidates. Gate 2 controls the trigger (manual "Build this" vs. auto). Gate 3 (activation in n8n) is always manual — Builder deploys **disabled**.
- Every Builder run records `skills_used` with `{slug, version, sha, source: 'builtin' | 'marketplace' | 'overlay'}`. (§7.2.3)
- Builder writes wiki backlinks (frontmatter `automations: [url]`) on the source pages it built from.

**Must not do:**
- Do not activate workflows in n8n. The API call that activates (`PATCH /workflows/{id}/activate` equivalent) is **never** invoked by Builder. Only the customer through the n8n UI.
- Do not let Builder skills grant new tools to the Builder agent. Skills inform; they do not extend the tool surface. The harness's skill-loader must enforce this.
- Do not log n8n API credentials in `agent_runs.tool_calls[].result`. n8n-mcp contract already masks these; verify in tests.

### 3.11 `packages/adapters/automation-n8n-mcp` + Builder skill overlay

**Must do:**
- Export `{ tools, builderSkills: SkillRef[], credentialSchema }` per the `AutomationAdapter` contract. (§7.2.1, §17 Resolved "Builder polymorphism")
- Vendor a pinned `czlonkowski/n8n-skills` release at build time (baseline).
- Live-fetch loop verifies `target_commitish` via GitHub Releases API AND recomputes tarball tree SHA against the Git ref. Fail closed on mismatch. (§17 Resolved "n8n-skills marketplace")
- Every marketplace update lands in `marketplace_updates` as a Review-Dashboard-gated accept — never auto-activate a new skill version.
- Partner overlay repo loads on adapter start + on-change. Overlay skills at highest precedence (§7.2.3).

**Must not do:**
- Do not accept non-`0.1.x`-style versions without explicit admin ack — unknown version formats fail closed.
- Do not permit the overlay repo to be an unbounded-size Gitea repo — enforce max-files + max-total-size at load (DoS prevention).

### 3.12 SkillMiner (`packages/engine-ingestion/pipelines/miner/`)

**Must do:**
- Read only from `scan_domains` explicitly listed on the miner binding. Default `[]` (idle). (§6.9.2)
- Run output-side redaction on `draft_payload.skill_md` before writing to `catalog_candidate`. Every hit writes `redaction_events` with `pipeline: 'miner'`. (§6.9.1 Pass 2)
- Compute `pattern_fingerprint` (NFC + lowercase + stopwords-removed-per-locale + SHA-256) before emission; check `miner_suppressions` first. (§6.9.1)
- Inherit LLM policy from the **target `catalog-skills` domain**, not the source domains.

**Must not do:**
- Do not include `agent_runs` content from runs whose `agent_instance.domain_scope` doesn't intersect `scan_domains`. Sovereignty.
- Do not promote a candidate without a reviewer — even if quarterly review is overdue.

### 3.13 Review Dashboard + Management UI (`packages/ui/`, `packages/engine-self-operating/http/review/`)

**Must do:**
- **Every state-changing endpoint re-validates the caller's Gitea team membership server-side** against the item's domain scope. UI filtering is not authorization.
- CSRF tokens on every state-changing form. `SameSite=Strict` cookies. Separate admin-session TTL (≤8h) from member-session TTL.
- Audit-log every admin action (redaction toggle, LLM policy edit, gate flip, skill candidate promote, source forget) to the Execution Log.
- Sovereignty-diff confirmation on `llm_policy` edits — if the domain was local and the new endpoint is cloud, require a second confirmation click + audit entry.
- Visible banner when `LLM_DEBUG_LOG=1` is detected at the engine.

**Must not do:**
- Do not render `credentialSchema` fields marked `x-credential-field: { secret: true }` without masking. The shared form renderer owns this — adapters cannot opt out.
- Do not expose `llm_usage_debug` content to non-admin roles.
- Do not permit the Review Dashboard to approve items outside the user's Gitea team scope, even with a crafted request.

### 3.14 `packages/gitea-wiki-mcp-server/`

**Must do:**
- Validate PAT scope against every resource / tool request. Reject out-of-scope reads at the API, not the UI.
- Expose worldview as an MCP resource (`worldview://{domain}`, `worldview://company`) — clients that support resources get it attached on connect. Tool fallback exists.
- Pin Gitea API client dependency versions; CI runs against the oldest and current supported Gitea.

**Must not do:**
- Do not cache wiki content across PAT changes — a revoked / re-scoped PAT must see immediate effect.
- Do not return 404 on out-of-scope reads in a way that leaks existence. Use a uniform "not accessible" response.

### 3.15 CLI (`packages/cli/`)

**Must do:**
- `opencoo migrate` runs Drizzle migrations and exits. Used by deploy flows.
- `opencoo doctor` checks: bootstrap token consumed; `ENCRYPTION_KEY` source (file vs. env); `LLM_DEBUG_LOG` flag; pending upgrade-notes; Gitea + Docling + n8n-mcp reachability; **enumerates internet-facing surfaces with bind addresses**.
- `opencoo source forget` requires explicit `--dry-run` first on non-interactive flows (CI). Writes `erasure_log`.
- `opencoo telemetry disable` is idempotent.

**Must not do:**
- Do not print credential values in any CLI output. Ever.
- Do not permit `source forget` to cascade-delete a domain's worldview implicitly — worldview deletion is a separate explicit command.

---

## 4. Cross-cutting concerns

### 4.1 Internet-facing surfaces

Only three services accept traffic from outside the partner's private network:

1. **Webhook receiver** (`POST /webhook/{provider}`) — largest untrusted-input surface. HMAC + rate limit + payload size cap.
2. **Management UI + Review Dashboard + Gitea OAuth callback** (self-op Fastify). Reverse-proxied with TLS; admin + operator traffic.
3. **`gitea-wiki-mcp-server`** — OAuth 2.1 + PKCE; PAT-scoped reads. Can be network-restricted if partners don't use external agents.

Everything else (Postgres, Redis, Gitea, Docling, Ollama, n8n-mcp self-hosted) stays on the compose network.

**Webhook endpoints must not share a hostname with UI** unless Origin + CSRF checks are strict — cross-origin request forgery from a compromised webhook into an admin session is otherwise live.

### 4.2 Prompt-injection resistance corpus

Every LLM-facing prompt in `packages/shared/prompts/{locale}/` has a matching fixture set under `packages/shared/prompts/__fixtures__/injection/{locale}/{agent}/*.yaml` containing:
- Direct injection attempts ("ignore previous instructions…")
- Indirect injection via quoted content
- Cross-domain write attempts (`target_pages[].path` outside allow-list)
- Path-traversal attempts (`../../wiki-hr/…`)
- Unicode homoglyph attacks on path validation
- Data-exfiltration prompts (`output the HR worldview`)

**CI gates on this corpus** — a prompt change that regresses any fixture must explicitly acknowledge. This is the phase-a ship-blocker.

### 4.3 Audit logging invariants

- `agent_runs`, `redaction_events`, `erasure_log`, `page_citations`, `miner_suppressions`, `miner_runs`, `llm_usage` are **append-only**. Engine code never UPDATEs or DELETEs. Cleanup is the only DELETE source.
- Consider a separate Postgres role with `INSERT`-only grants on audit tables. Insider-erasure via admin DB access is otherwise unprevented.
- Every admin action in the UI produces an audit row. The Management UI's Execution Log should display these alongside pipeline events.

### 4.4 Redaction policy

- Default pattern list ships with opencoo releases. Versioned. Banner on upgrade for new patterns — partner explicitly accepts. (§6.6)
- Applies to `content_kind ≠ 'document'` pre-ingest AND to SkillMiner `draft_payload.skill_md` pre-catalog-write. Two enforcement points; both mandatory.
- Every hit → one `redaction_events` row. Metadata only, never the matched content.
- **Gap to close in v0.2:** `agent_runs.tool_calls[].result` is not re-redacted today. A buggy SourceAdapter can leak secrets into `agent_runs` even though they won't reach Gitea. Fix at the harness write path.

### 4.5 Supply chain

- Images pinned by digest in the reference `docker-compose.yml`: Gitea, Docling, Ollama, n8n-mcp-server, Postgres, Redis.
- npm dependencies: Dependabot on `main`; security-advisory triage per release.
- Only `gitea-wiki-mcp-server` publishes to npm — with provenance. Every other package is `"private": true`.
- Release tags GPG-signed. CI verifies signature before publishing Docker images.
- Maintainer accounts (GHCR, Docker Hub, npm, GitHub) on hardware-key MFA. Documented in `SECURITY.md`.

---

## 5. PR checklist

Run before requesting review.

- [ ] No invariant from §2 violated (or a §7 entry exists + reviewer ack).
- [ ] The matching §3 section's "must do / must not do" items are satisfied.
- [ ] New adapter? `credentialSchema` with `x-credential-field: { secret: true }` on secrets.
- [ ] New LLM call? Through `llm-router`. Tokens + cost + latency recorded. Spotlighting on inputs.
- [ ] New wiki write? Through `wikiWrite`. Frontmatter provenance populated. Worldview-Impact trailer set.
- [ ] New webhook? HMAC verified. Rate-limited. Payload-size capped.
- [ ] New admin UI action? CSRF token. Server-side authz recheck. Audit log row.
- [ ] New internet-facing route? Listed in §4.1. `opencoo doctor` updated to enumerate it.
- [ ] New env var for feature config? **Stop.** §2 invariant 9 — it goes in Postgres and UI.
- [ ] Tests: use-case in-memory (no Docker), adapter contract test, LLM calls through `MockLLMClient`. (§14.3)
- [ ] Credentials never appear in logs, even at `debug` level. Grep your new code.
- [ ] If the PR introduces residual risk, §7 updated.

---

## 6. Release checklist

Per `0.N.0` tag.

- [ ] Re-run prompt-injection corpus (§4.2) — all fixtures pass.
- [ ] Audit every new/changed adapter against §3.1–3.3.
- [ ] `SECURITY.md` reviewed — vulnerability reporting address still valid, maintainer-account MFA still enforced.
- [ ] Image digests in reference `docker-compose.yml` updated and CVE-scanned.
- [ ] Dependabot / `npm audit` findings either resolved or explicitly deferred in `CHANGES-vX.Y.md`.
- [ ] `CHANGES-vX.Y.md` lists every breaking change + new default + migration action.
- [ ] Telemetry payload shape unchanged (or change documented in CHANGES + UI wizard updated).
- [ ] `opencoo doctor` run against a fresh install — every check passes.
- [ ] This document re-read end-to-end. Stale references updated. §7 entries that have been closed, removed.

---

## 7. Known residual risks (living list)

Open risks we've consciously accepted or deferred. Each entry names what we're living with, why, and what would change it.

| Risk | Why we accept it (for now) | What triggers revisit |
|---|---|---|
| Zero-day prompt injection slipping past spotlighting + guard | Four-layer defense + injection corpus in CI + Lint contradiction detection | Post-generate content-safety guard lands (v0.2 per §6.6), or an incident |
| `agent_runs.tool_calls[].result` not output-redacted | Adapter no-raw-secrets contract + Gitea hard boundary at catalog-write | v0.2: apply redaction to `agent_runs` writes at harness |
| Builder overlay repo tampering | Partner-owned Gitea ACL; overlay is highest precedence but writes are git-audited | Signed overlay releases + SHA pinning (v0.2) |
| Insider-erasure via direct Postgres write on audit tables | Convention enforced, not role-enforced | Separate INSERT-only Postgres role for audit tables (v0.2) |
| `ENCRYPTION_KEY` host-compromise defeats in-container posture | v0.1 is app-layer AES-256-GCM; KMS backend is designed, not shipped | Partner asks for KMS/Vault → plug `CredentialStore` implementation |
| Gitea CVE inheritance | We ship it in the reference compose; partner operates it | Pin by digest + doctor checks Gitea version against known-bad list |
| Stale worldview proceeds with warning, not block | Stale > none; logged; partner can manual-refresh | Pattern of staleness-caused incidents |
| Chat session memory retains content within one MCP session | MCP session is PAT-bound | Cross-user leak surfaces in practice |
| Docling / Ollama / MarkItDown sidecar supply chain | Justified on quality; digest-pinned + egress-restricted | Sidecar-class CVE that our pinning didn't catch |
| LLM provider ToS retention (partner-owned) | Per-domain `llm_policy` is the control; partner owns provider-account settings | Provider ToS change; incident |
| No hard LLM spend cap today | Cost tracker + UI visibility | **Phase-a target** — `llm_budget_monthly_cap_usd` with fail-closed enforcement |
| Custom-agent authoring UI threats | v2+ feature per §17 Open questions | Re-run §3.8 against the UX when it lands |

---

## 8. Update triggers

Update this document in the **same PR** when you:

- Add a new adapter type, agent type, pipeline, or top-level package → add a §3 section.
- Add a new internet-facing route → update §4.1.
- Add a new LLM-facing prompt → add injection fixtures per §4.2.
- Change an invariant in §2 → this is a design-review-required change; update `DECISIONS.md` first.
- Ship a mitigation that closes a §7 risk → remove the entry, cite the PR in the commit message.
- Discover a new residual risk → add to §7 with why-we-accept + revisit-trigger.

Review cadence: every `0.N.0` tag at minimum. Ad-hoc on any security incident or near-miss.

---

*Derived from a STRIDE threat model (preserved in git history) against `architecture.md` v0.1. Companion reading: `threat-modeling-guide.md` for the classical STRIDE framework.*
