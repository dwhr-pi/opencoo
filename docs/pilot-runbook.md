# pilot runbook

## What this document is

This runbook walks an operator from a fresh checkout to a working pilot deployment with real-data webhook ingestion confirmed end-to-end. it is the only checklist the operator needs to follow before declaring the deployment "pilot-ready". scheduled-agent autonomy (Heartbeat / Lint / Surfacer firing on cron) is partially deferred — see §8 — so the v0.1 ready signal is "webhook → wiki write end-to-end on the binding the operator just configured", not "every agent fires unattended".

The doc is operator-facing and follows the same voice rules as the management UI: lowercase `opencoo`, no marketing language, technical and precise. when something does not work, §6 names the recovery path; when something does not exist yet, §8 names the gap.

Companion docs: `docs/ARCHITECTURE.md` (architectural shape), `THREAT-MODEL.md` (security invariants the operator gates the deployment against), `IMPLEMENTATION-PLAN.md` (phase-a ledger).

## 1. Pre-flight checklist

Bring the deployment substrate up first. opencoo does not ship its own substrate — it talks to existing Postgres / Redis / Gitea instances.

- **PostgreSQL 16+** reachable on a TCP socket. one database per opencoo instance; no separate read-replica needed in v0.1.
- **Redis 7+** reachable on a TCP socket. used as the BullMQ backing store; persistence settings are operator-owned (BullMQ recovers from `aof` on its own, but a snapshot loss costs in-flight ingestion jobs).
- **Gitea** reachable from the opencoo host. any recent Gitea release works; pin by image digest in operator-owned compose. opencoo writes to one repo per knowledge domain via a service-account PAT.
- **Ports**: `8080` free on the opencoo host (the engine binds Fastify here); `5432` / `6379` / `3000` free if the operator runs Postgres / Redis / Gitea on the local-dev `compose.yml` shipped in the repo. all three are operator-overridable.

### Required env vars

opencoo's env-var allow-list is short by design (THREAT-MODEL §2 invariant 9 — `no-feature-env-vars` ESLint rule enforces it). everything else is in Postgres + the management UI.

| Variable | Purpose | Generate / source |
|---|---|---|
| `DATABASE_URL` | Postgres DSN. | operator-owned. e.g. `postgres://opencoo:opencoo@localhost:5432/opencoo` |
| `REDIS_URL` | Redis URL. | operator-owned. e.g. `redis://localhost:6379` |
| `ENCRYPTION_KEY` | 32-byte base64-encoded symmetric key for the `CredentialStore` vault. The loader base64-decodes the value and requires exactly 32 raw bytes; a hex string decodes to ~47 bytes and trips `ENCRYPTION_KEY must decode (base64) to exactly 32 bytes`. | `openssl rand -base64 32` |
| `GITEA_URL` | Gitea base URL the engine writes wikis against. | operator-owned |
| `GITEA_PAT` | Service-account PAT with write scope on the wiki repos. | created in Gitea UI |
| `PORT` | Fastify bind port. | optional; defaults to `8080` |
| `ADMIN_TEAM_SLUG` | Gitea team whose members get admin-API access. | required when running the management UI |
| `SESSION_HMAC_KEY` | 32-byte base64 HMAC key for admin sessions. | `openssl rand -base64 32` |
| `GITEA_BASE_URL` | Gitea URL the admin-API uses for `/whoami`. | usually equal to `GITEA_URL` |
| `MCP_BEARER_TOKEN` | Static bearer the engine uses to talk to the gitea-wiki-mcp-server (must match the server's own `MCP_BEARER_TOKEN`). When unset, scheduled Heartbeat / Lint / Surfacer agents do NOT fire — webhook → wiki path still works. | `openssl rand -hex 32` (same value the gitea-wiki-mcp-server is configured with) |
| `MCP_BASE_URL` | Full URL of the gitea-wiki-mcp-server's `/mcp` endpoint. | optional; defaults to `http://localhost:3000/mcp` |
| `N8N_MCP_BEARER_TOKEN` | Static bearer the engine uses to talk to the [n8n-mcp](https://github.com/czlonkowski/n8n-mcp) MCP server (must match that server's own bearer). Surfacer's template catalog is sourced via this server's `search_templates` tool. **If absent, Surfacer uses the vendored ~3-template baseline** bundled with the `automation-n8n-mcp` adapter; absent does NOT break Heartbeat / Lint. | n8n-mcp's own bearer; see the n8n-mcp project README for setup |
| `N8N_MCP_BASE_URL` | Full URL of the n8n-mcp server's `/mcp` endpoint. | optional alongside `N8N_MCP_BEARER_TOKEN`; both must be set together to activate the live template catalog |
| `OPENROUTER_API_KEY` | OpenRouter API key. **Optional** — set when domain LLM policy points at `provider=openrouter`. The multi-provider dispatcher threads this into `createProvider("openrouter")` lazily; absent does NOT break boot. PR-Q4 (phase-a appendix #9) added the `openrouter` arm to the closed `PROVIDERS` tuple. | operator-owned (https://openrouter.ai/) |

Optional:

- `OPENCOO_ADMIN_PAT` — Gitea PAT used by `opencoo doctor` to verify admin-team membership without `--admin-pat` on the command line.
- `LOG_LEVEL=debug` — verbose engine logs, useful for pilot triage. unset in steady-state production.
- `LLM_DEBUG_LOG=1` — surfaces full prompts + responses on the SSE bus and in `llm_usage_debug`. **never set in production** (THREAT-MODEL §2 invariant 11). the management UI displays a banner whenever the gate is on so reviewers know.
- per-provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`, `OPENROUTER_API_KEY`) — wired by the `LlmRouter` lazily; only required for the providers the operator actually selects in domain LLM policy. (`OPENROUTER_API_KEY` is documented in the table above; the others are infrastructure config and follow the same lazy-resolve pattern.)

The required `_URL`-style vars and `ENCRYPTION_KEY` accept a `_FILE` suffix variant (Docker secrets pattern) — namely `DATABASE_URL_FILE`, `REDIS_URL_FILE`, `GITEA_URL_FILE`, `GITEA_PAT_FILE`, `ENCRYPTION_KEY_FILE`, `SESSION_HMAC_KEY_FILE`, `GITEA_BASE_URL_FILE`, `OPENCOO_ADMIN_PAT_FILE`, `MCP_BEARER_TOKEN_FILE`, `MCP_BASE_URL_FILE`, `N8N_MCP_BEARER_TOKEN_FILE`, `N8N_MCP_BASE_URL_FILE`. `_FILE` wins when both are set; the loader at `packages/shared/src/engine-scaffold/config.ts:53-67` reads the file and trims a single trailing newline. Variables that are NOT URLs or secrets — `PORT`, `NODE_ENV`, `LOG_LEVEL`, `LLM_DEBUG_LOG`, `TELEMETRY_ENDPOINT`, and per-provider keys like `OPENROUTER_API_KEY` — do NOT have a `_FILE` form (they're never read through `readWithFile`).

## 2. First-boot sequence

Run from the repo root, with the env above present in `.env` or the shell:

```
pnpm install
pnpm build
opencoo migrate                                  # apply Drizzle migrations to the Postgres DSN
opencoo setup                                    # interactive: writes .env at mode 0600 if missing
opencoo agents seed --domain wiki-pilot          # idempotent INSERT of default Heartbeat/Lint/Surfacer rows scoped to <slug>; omit --domain when only one domain exists (auto-pick)
opencoo agents fire heartbeat --dry-run          # verifies the heartbeat runner is registered (dry-run reports the requested slug only)
opencoo agents fire lint --dry-run               # verifies the lint runner is registered (separate command — repeat the verb per slug)
opencoo doctor                                   # verifies env + Postgres + Gitea + enumerates ingress paths
pnpm opencoo                                     # boots the management UI + ingestion engine in one process
```

Per-command notes:

- `opencoo migrate` is idempotent — Drizzle tracks applied rows in `drizzle.__drizzle_migrations`. green output: `migrate: ok`.
- `opencoo setup` refuses to overwrite an existing `.env`. delete or rename first if rotating secrets.
- `opencoo agents seed --domain <slug>` inserts one `agent_instances` row per scheduled-class agent (Heartbeat, Lint, Surfacer), each scoped to the named domain. Chat + Builder are on-demand and intentionally not seeded. Re-running is a no-op (`ON CONFLICT (definition_slug, name) DO NOTHING`). When exactly one domain row exists the `--domain` flag may be omitted (auto-pick); when zero or multiple domains exist the verb fails fast with a clean stderr line. The seeded rows carry `memory: {"type":"none"}` and `scope_domain_ids: [<resolved-uuid>]` so the harness's first dispatch picks them up without a manual `psql UPDATE`.
- `opencoo agents fire <slug> [--dry-run] [--instance-id <uuid>]` manually triggers a scheduled agent's runner without waiting for cron. Resolves the slug to its `agent_instances` row + invokes the harness directly (bypasses BullMQ; no Activity-feed event — operator-side asymmetry by design). Exit codes: `0` dispatch ok / `1` operator error (slug not found, ambiguous slug, mismatched `--instance-id`, malformed UUID, runner missing) / `2` runtime error (`MCP_BEARER_TOKEN` unset, `DATABASE_URL` unset / Postgres unreachable, pg.Pool construction failure, runner threw before recording the row). The dry-run reports the **requested slug only** — re-run the verb per slug to verify each runner. With `MCP_BEARER_TOKEN` set, `agents fire heartbeat --dry-run` and `agents fire lint --dry-run` both report `runner: registered`; `agents fire surfacer --dry-run` reports `runner: NOT in registry` per appendix #6 (Surfacer is omitted by default until the template catalog is wired — see §8).
- `opencoo doctor` returns exit 0 with all-green checks on a healthy fresh install. one yellow line on the Activity feed surface is expected on first boot — there are no events yet to enumerate. yellow on `gitea_team` means `OPENCOO_ADMIN_PAT` is unset; pass `--admin-pat <pat>` to verify admin-team membership.
- `pnpm opencoo` boots both engines in a single Node process. expected stdout: `opencoo: starting...` → `opencoo: started`. SIGTERM / SIGINT drains both engines in parallel within ~30s.

If composition of the ingestion engine fails (most often: missing `GITEA_PAT` or `ENCRYPTION_KEY`), `pnpm opencoo` continues running the management UI in `mode: 'probes-only'` — the operator gets the UI, the webhook receiver is unavailable until restart. the stderr line names the missing ingredient.

## 3. Bind a real Asana source

The pilot's first real binding. all UI paths assume the engine is running on `http://localhost:8080`.

1. Open `http://localhost:8080` and sign in. the admin-API authenticates with a Gitea Personal Access Token (`Authorization: Bearer <gitea-PAT>` per `packages/engine-self-operating/src/admin-api/auth.ts:5`); the PAT must belong to a member of `ADMIN_TEAM_SLUG`. Generate one in Gitea → Settings → Applications → Generate New Token (scopes: `read:user`, `read:organization`); paste it into the management UI's login screen, which stores it via `setPat` in browser storage. There is no OAuth flow in v0.1.
2. Navigate to the **Sources** tab → click **+ New binding**.
3. Choose adapter **`asana`**. fill the form rendered from `asanaBindingConfigSchema`:
   - **Asana PAT** — service-account token with read access on the project. encrypted at rest via `CredentialStore`.
   - **Project gid** — the Asana project the engine watches.
   - **Workspace gid** *(optional)* — for cross-checks; leave unset for v0.1.
   - **Monitored project gids** *(optional but recommended)* — single-element array containing `Project gid`. when unset, every event for the bound credentials passes through; production deployments should set this.
   - **Snapshot mode** — defaults to `on-event`. produces a second `SourceEvent` per webhook with `content_kind: 'asana-project'`.
   - **Light summary enabled** — defaults to `false` (opt-in to avoid LLM cost on high-volume projects).
   - **Review mode** — defaults to `auto`. `auto` requires the redaction guard (default) wired into the ingestion path.
4. Click **Save**. the UI returns a webhook target URL of the shape `/webhooks/<binding-id>`.
5. Copy the URL into Asana's webhook configuration UI. Asana's webhook handshake (`X-Hook-Secret`) is handled automatically by the receiver (PR-F): the receiver echoes the secret back, persists it via `CredentialStore`, and updates `sources_bindings.webhook_secret_credentials_id`. The handshake depends on (a) the adapter exposing `webhook.handshakeFn` (Asana's `detectAsanaHandshake` at `packages/adapters/source-asana/src/adapter.ts:514`) AND (b) the inbound request matching the heuristic (presence of the `x-hook-secret` header — `ASANA_HOOK_SECRET_HEADER` constant at line 81 of the same file). If the binding's status pill stays `configuring` past 2 min, the handshake didn't fire — most often because Asana's first POST never reached the engine (firewall, reverse-proxy mis-routing). The `webhook.handshake.received` log line in the engine stdout (info level; from receiver.ts:199) is the success signal; absence means the handshake never ran.
6. Confirm via the Sources tab — the binding's status pill should transition `configuring → ok` within ~30s. `last_event_at` populates on the first real delivery; `last_error` populates if the receiver rejects (signature mismatch, body over the 5MB cap, etc.).

Optional verification — confirm the receiver is reachable from outside the host:

```
curl -i https://<host>:<port>/webhooks/<binding-id> -X OPTIONS
```

CORS is intentionally not enabled on this path; the operator should expect a 4xx on OPTIONS but a TCP-level acknowledgement. anything timing out at the network layer is a reverse-proxy / firewall issue.

## 4. Real-data smoke

The load-bearing operational test. does the deployment actually work end-to-end?

The Activity feed (`GET /api/admin/events` SSE bus) emits exactly five SSE channels in v0.1: `connected`, `agent_run`, `output_delivery_dlq`, `token` (only when `LLM_DEBUG_LOG=1`), and `ping` (15s keepalive). Every Worker run — webhook scanner, compiler, index-rebuilder, cleanup — surfaces as an `agent_run` event with one of the `definitionSlug` values: `ingestion.scanner`, `ingestion.scanner.classify`, `ingestion.review.dispatch`, `ingestion.index-rebuild`, `ingestion.cleanup`. There is no separate `source.event.received` or `compile.completed` channel; webhook receipt is confirmed via the `webhook_events` table; compile success is confirmed via the `agent_run` event with `definitionSlug = 'ingestion.scanner.classify'` and `status = 'success'`.

1. **Trigger an event.** in the bound Asana project, create or update a task. if `monitoredProjectGids` is set, the task must belong to one of the listed projects. project-level scope is enough for v0.1; tag filters are not yet wired.
2. **Confirm webhook receipt** via the database. the receiver writes the row inline before returning 200, so the row should be visible within sub-second:
   ```
   psql "$DATABASE_URL" -c "SELECT id, binding_id, signature_ok, received_at \
                            FROM webhook_events \
                            ORDER BY received_at DESC LIMIT 5;"
   ```
   `signature_ok = true` confirms HMAC verification succeeded. `false` rows mean the secret is stale (see §5 for recovery).
3. **Watch the Activity feed for compile completion.** in the management UI's **Activity** tab, within ~30s the operator should see an `agent_run` event with `definitionSlug = 'ingestion.scanner.classify'` and `status = 'success'`. (`status` cycles `running → success | failed`; the bridge writes one event per BullMQ Worker `active` / `completed` / `failed` transition.) the run's `errorMessage` field, when present, is scrubbed via `scrubPat` and capped at 200 chars.
4. **Confirm the `ingestion_intake` row** corresponds to the webhook event:
   ```
   psql "$DATABASE_URL" -c "SELECT id, binding_id, status, error_text, created_at \
                            FROM ingestion_intake \
                            ORDER BY created_at DESC LIMIT 5;"
   ```
   `status = 'compiled'` indicates the row reached the wiki write; `error_text` populates on the failure paths.
5. **Confirm the wiki page in Gitea.** navigate to `<GITEA_URL>/<org>/wiki-<domain-slug>/src/branch/main/<wiki-path>.md`. the page must show populated frontmatter (`schema_version`, `prompt_version`, `compiled_at`, `compiled_by_run_id`) and a `Worldview-Impact` git trailer on the commit. the engine logs `wiki.write` at `info` level on every successful write; a `wiki.write.stale` warn line in the engine stdout means a stale-SHA pull-retry was needed.
6. **Confirm output delivery** *(if a binding has an `OutputAdapter` configured — typically `output-asana` for the comment-back loop)*. permanent delivery failures surface on the Activity feed as `output_delivery_dlq` SSE events (the channel name on the bus is the underscore form, not `output.delivery.dlq`). the `output_deliveries` audit table records every attempt regardless of success:
   ```
   psql "$DATABASE_URL" -c "SELECT id, binding_id, status, http_status, attempt, duration_ms \
                            FROM output_deliveries \
                            ORDER BY created_at DESC LIMIT 5;"
   ```

When the webhook row, the `agent_run` success event, the `ingestion_intake` `compiled` row, and the wiki page are all in place, the smoke is green. proceed to the §9 sign-off checklist.

### Scheduled-agent smoke (manual fire of Heartbeat)

Independent of the webhook → wiki path: `opencoo agents fire heartbeat` triggers the Heartbeat runner directly via the harness, bypassing BullMQ. With `MCP_BEARER_TOKEN` set + Heartbeat seeded by `opencoo agents seed`, the verb produces an `agent_runs` row within ~30s. Verify the row landed:

```
psql "$DATABASE_URL" -c "SELECT id, definition_slug, status, started_at, ended_at, latency_ms \
                         FROM agent_runs ORDER BY started_at DESC LIMIT 1;"
```

Expected: one row with `definition_slug = 'heartbeat'`, `status = 'success'` (or `'failed'` with the harness-recorded error captured in `output`), and `started_at` within the last minute. The CLI prints `✓ heartbeat instance <uuid> dispatched; agent_runs row <uuid> recorded; status <status>` on stdout.

The CLI does NOT emit onto the SSE bus — Activity-feed events fire only for cron-dispatched runs. This asymmetry is by design: the CLI is operator-side, no UI listens. Operators who want feed visibility wait for the next cron tick (`agents fire` is the cutover-readiness verification, not the production trigger).

If the row's `status = 'failed'`, the harness still records the row + the `output.error` field carries the message (scrubbed via `scrubPat`). Common causes: no domain bound to the instance's `scope_domain_ids` yet (run §3 first), Gitea `wiki-<slug>` repo missing (run `opencoo setup`), MCP wiki resources not registered on the gitea-wiki-mcp-server (PR-O1 in this same appendix; needed for Heartbeat's wiki-read path). For a slug that has no runner registered (Surfacer in v0.1, per appendix #6), the verb exits 1 with the runner-omitted hint pointing back at §8 — no run row is recorded.

### Scripted probe (webhook → intake → classify-enqueue chain)

`scripts/smoke-real-data.ts` (registered as `pnpm smoke:real-data`) is a separate probe — it tests the **HTTP receiver + HMAC verify + DB persistence + direct-intake fast path** against the generic `source-webhook` adapter. With PR-N2 the smoke now also confirms an `ingestion_intake` row lands inline (the receiver's direct-intake branch fires when the bound adapter exposes `webhook.enrichEvents` AND the orchestrator wired `scannerClassifyQueue` — `source-webhook` satisfies both since PR-N2). The smoke does NOT verify compile → wiki write — that depends on the Compile worker, LLM router, GuardAdapter, and WikiAdapter all being composed and reachable; the §4 manual walk above remains the canonical end-to-end verification against a real Asana / Drive binding.

The smoke provisions a transient knowledge domain + a generic-webhook source binding, writes the webhook secret via `DrizzleCredentialStore.write` (same path the production receiver decrypts), posts an HMAC-signed fixture event to `/webhooks/<binding-id>`, polls for both the `webhook_events` and `ingestion_intake` rows, and tears down its scaffolding before exit. Useful as an "is the receiver-to-classify chain alive?" probe at any time after first boot:

```
pnpm opencoo                 # in terminal 1
pnpm smoke:real-data         # in terminal 2; exits 0 in <30s on green
```

The Asana walkthrough above (§4 steps 1–6) and the scripted smoke test different surfaces; running both gives independent signals — the smoke catches receiver / DB / direct-intake regressions, the Asana walk catches Compile + wiki regressions.

## 5. Common failures and how to recover

- **`doctor: ENCRYPTION_KEY` is `unset` or invalid.** regenerate via `openssl rand -base64 32` (NOT `-hex 32` — the loader base64-decodes the value and requires exactly 32 raw bytes; a hex string decodes to ~47 bytes), write to `.env`, restart `pnpm opencoo`. the vault refuses any other byte length — that protects every encrypted credential row from a weak-key downgrade.
- **Binding status stuck at `configuring` for > 2 min.** check Asana's webhook delivery panel — the `X-Hook-Secret` echo must match opencoo's response. without it, the receiver returns 200 but does not persist the secret, and subsequent event deliveries fail HMAC verification with no clear stderr line. delete the Asana webhook + recreate.
- **Activity feed empty after a webhook delivery.** check `webhook_events` directly: `psql "$DATABASE_URL" -c "SELECT id, binding_id, signature_ok, received_at FROM webhook_events ORDER BY received_at DESC LIMIT 5;"`. `signature_ok = false` rows mean HMAC failed; the receiver returns 401, writes the failed row, DLQ-enqueues, AND emits a structured `webhook_receiver.signature_invalid` log line at `debug` level (real key; from `packages/engine-ingestion/src/intake/webhook-receiver.ts`). Run `LOG_LEVEL=debug pnpm opencoo` and grep stdout for the key: the line carries `bindingId`, `provider`, `eventId`, `errorReason` (the verifier's reason string — `"signature mismatch (HMAC differs)"`, `"signature header missing"`, etc.) and `signatureHeaderName: "x-signature"`. THREAT-MODEL §2 invariant 11 + §3.6 are honored — the header NAME is logged but never the header VALUE, and the raw request body never appears. Most likely cause: the binding's `webhook_secret_credentials_id` points at a credential whose plaintext doesn't match what the upstream signs with — re-issue the webhook on the upstream side to trigger the handshake again.
- **No `agent_run` event with `definitionSlug = 'ingestion.scanner.classify'` after the intake row lands.** check Redis is reachable from the engine: `redis-cli -u "$REDIS_URL" ping`. check `pnpm opencoo` stderr for `ingestion_workers.close_failed` or `ingestion_workers.close_timeout` warn lines (real keys; emitted from `packages/engine-ingestion/src/workers/index.ts`). if Redis was reachable but the worker silently quit, the ingestion engine likely fell back to `mode: 'probes-only'` — re-read the boot stderr for the composition-failure line ("opencoo: ingestion workers disabled (...)"; emitted by `packages/cli/src/commands/serve.ts`).
- **`agent_run` success event but no wiki page in Gitea.** the engine writes `wiki.write` at `info` level on every successful Gitea commit (real key; from `packages/shared/src/wiki-write/wiki-write.ts:135`). If you see `wiki.write.stale` warn lines (real key; same file, line 144) the write hit Gitea's optimistic-concurrency error and the per-domain queue is retrying. If neither line appears, the compile didn't reach the wiki-write call — check `ingestion_intake.error_text` for the failure reason. confirm `GITEA_PAT` has write access on the target repo; if the PAT is admin-scoped but the repo doesn't exist yet, run `opencoo setup` to provision domain repos, or create them manually in Gitea and re-trigger.
- **`pnpm smoke:real-data` returns exit 2 with `webhook POST returned 401`.** since round-2 fix #1 the smoke writes the credential through the production `DrizzleCredentialStore.write` path, so a 401 here is a real product bug worth investigating: most likely `ENCRYPTION_KEY` was rotated mid-flight and the receiver can no longer decrypt the credential it just wrote. Confirm via the engine log for `credential.read_failed` lines (real key; from `packages/shared/src/credential-store/drizzle-store.ts:76`).

## 6. Rollback (design-partner cutover only)

When opencoo runs in parallel with an n8n pipeline that previously handled the same Asana project, the cutover surface is one binding at a time. to revert a single pipeline:

1. **Disable the binding.** Sources tab → click the binding → toggle `enabled` to `false`. inbound webhook events continue to be accepted (HMAC verified, `webhook_events` row written) but the scanner queue does not dispatch them, so no compile fires and no wiki write happens. this preserves audit and lets the operator inspect what would have ingested without commit.
2. **Re-enable the n8n parallel pipeline** that previously handled this Asana project. re-activation is operator-owned in the n8n UI; the workflow ID is named in the partner's deployment ledger. (per CLAUDE.md, do not name the partner's `docs/local/` workflow IDs in public artifacts; consult the partner-private ledger.)
3. **Verify n8n is processing** via the n8n execution log. typical recovery: < 5 minutes from the binding-disable click to the next n8n run.

Cutover policy: opencoo's binding stays enabled until the n8n equivalent is paused and reviewers sign off on opencoo's output quality. cutover is one pipeline at a time; never big-bang.

## 7. Verifying THREAT-MODEL invariants

Before declaring pilot-ready, the operator runs the following spot-check (mirrors THREAT-MODEL §5 PR checklist for the deployment surface):

- [ ] All `_FILE`-variant secrets resolve correctly: rename a value to its `_FILE` variant, point at a file, restart, verify `doctor` is still green.
- [ ] Admin-API requires Gitea team membership: log in as a non-`ADMIN_TEAM_SLUG` user, confirm `/api/admin/*` returns 403.
- [ ] Webhook 5MB body cap enforced: `curl -X POST` a 6MB payload at the binding URL, expect 413 from Fastify.
- [ ] CSRF cookie `opencoo_csrf` (real name; from `packages/engine-self-operating/src/admin-api/csrf.ts:43`) is `Path=/` and `SameSite=Strict`: open devtools → Application → Cookies on a logged-in admin session, find the `opencoo_csrf` row, confirm both attributes. The matching request header is `x-csrf-token` (line 44 in the same file).
- [ ] No prompt content in `info`-level logs: `LOG_LEVEL=info pnpm opencoo`, trigger a webhook, grep stdout for `prompt_text` — should return empty.
- [ ] `LLM_DEBUG_LOG` banner shown in the UI when set: with `LLM_DEBUG_LOG=1`, the management UI displays a yellow banner on every page.

## 8. Deferrals (v0.1 limitations)

These are deliberate phase-a / phase-b deferrals. tracking each in the appendix #5 follow-up issue:

- **Heartbeat / Lint scheduled agents fire on cron when `MCP_BEARER_TOKEN` is set.** PR-N3 (phase-a appendix #6) wires the production `HttpMcpToolClient` + `AgentRunnerRegistry`. `agents seed` writes the `agent_instances` rows with `schedule_cron` populated, the orchestrator composes the registry at boot, and the `AgentDispatcher` (PR-M2) registers the BullMQ recurring jobs. Per-dispatch domain slug resolution comes from `agent_instances.scope_domain_ids[0]` (no new env var). For pre-cutover verification without waiting for the next cron tick, `opencoo agents fire <slug>` (PR-O2, phase-a appendix #7) invokes the runner directly via the harness — see §3 for first-boot dry-run usage and §4 for the scheduled-agent smoke.

  **Boot-tolerance — when `MCP_BEARER_TOKEN` is UNSET (or its `_FILE` variant), or `HttpMcpToolClient` construction throws.** The orchestrator's `tryComposeAgentRunnersBundleFromEnv` returns `null` and emits `mcp_http.unavailable` at warn level. `engine-self-operating.start({...})` is then called WITHOUT `agentRunners` / `agentDefinitions` / `agentRouter`, so per `engine-self-operating/src/start.ts:340` the `AgentDispatcher` is NOT constructed at all — there are no recurring BullMQ jobs registered, no scheduled agents fire, no `agent_runs` rows are written by the scheduler path, and the `/api/admin/scheduler` route returns an empty list. The management UI stays alive and the webhook → wiki path still works. Set `MCP_BEARER_TOKEN` to the same static bearer the gitea-wiki-mcp-server is configured with to activate scheduling.

  **Surfacer activates by default** (PR-O3, phase-a appendix #7). The `availableTemplateSlugs` catalog now resolves through the `automation-n8n-mcp` adapter's `listAvailableTemplateSlugs` helper at boot:

  1. **Live n8n-mcp** — when `N8N_MCP_BASE_URL` + `N8N_MCP_BEARER_TOKEN` are both set, the orchestrator constructs a SECOND `HttpMcpToolClient` pointed at the n8n-mcp server and calls `search_templates` in `patterns` mode to enumerate the catalog (~10 stable category slugs in the live n8n-mcp index).
  2. **Vendored fallback** — when either env var is unset OR the n8n-mcp call fails (network, timeout, malformed response, empty result), the orchestrator falls back to the vendored `builderSkills.map(s => s.slug)` baseline bundled with the adapter. The baseline is non-empty (~3 entries), so Surfacer remains REGISTERED in either case.
  3. **Empty omission** (corner case) — Surfacer is omitted ONLY when the caller explicitly passes `availableTemplateSlugs: []` AND the vendored baseline is also empty. The orchestrator emits `surfacer.template_catalog_empty` at warn level if that path fires.

  Visible boot-time warns:
  - `n8n_mcp.unavailable` (warn) — N8N_MCP env vars unset; Surfacer using vendored fallback.
  - `surfacer.template_catalog_n8n_mcp_unreachable` (warn) — n8n-mcp call threw; Surfacer using vendored fallback.
  - `surfacer.template_catalog_n8n_mcp_empty` (warn) — n8n-mcp returned 0 parseable slugs; Surfacer using vendored fallback.

  v0.1 caveats: boot-time fetch only — if the n8n-mcp catalog changes, the operator restarts the engine. Live cache invalidation defers to v0.2. The catalog-workflows compiler-driven catalog also defers to v0.2.
- **DLQ retry workers for `output_deliveries` are not automated.** failed deliveries surface as `output_delivery_dlq` SSE events (underscore form per `packages/engine-self-operating/src/admin-api/routes/events.ts:122`) with the row in Postgres at `status = 'failed'`. manual operator recovery is the v0.1 path: re-enable the binding or re-deliver via psql.
- **Per-domain LLM-policy aware scheduling defers to v0.2.** if a domain's LLM policy points at an unavailable provider, the scheduler dispatches anyway; the LLM router error-bubbles via `LlmPolicyViolationError`. operators can pause the domain manually via the management UI's Domains tab.
- **Cron timezone awareness defers to v0.2.** every `defaultScheduleCron` is UTC. operators in non-UTC offsets adjust the cron expression manually until v0.2 lands.
- **Scheduler UI in the management console defers to phase-b.** `/api/admin/scheduler` (read-only) is the v0.1 surface; operators inspect via curl or psql.
- **Self-boot mode for `pnpm smoke:real-data`** (`--boot` flag spawning `pnpm opencoo` as a child) is not implemented in v0.1 — the script assumes the operator runs `pnpm opencoo` in another terminal first. the script returns exit 1 with a clear message if `--boot` is passed.

## 9. Pilot sign-off checklist

Operator ticks each box before declaring the deployment pilot-ready:

- [ ] All required env vars set; `opencoo doctor` returns exit 0 with all checks green (or only the expected `gitea_team` warn when `OPENCOO_ADMIN_PAT` is unset).
- [ ] At least one source binding created via the management UI; status pill shows `ok`; `last_event_at` populated.
- [ ] Real webhook event observed end-to-end against a real adapter (Asana / Drive). PR-N2 closes the source-webhook chain on the receiver side (the receiver's direct-intake branch produces an `ingestion_intake` row inline for any adapter exposing `webhook.enrichEvents`), but pilot sign-off still requires verification past compile + wiki write — that depends on the Compile worker, LLM router, GuardAdapter, and WikiAdapter all being composed and reachable, which is best exercised end-to-end against a real adapter that produces non-trivial document content. Markers: `webhook_events` row appears in Postgres within ~1s of upstream trigger; an `agent_run` SSE event with `definitionSlug = 'ingestion.scanner.classify'` and `status = 'success'` lands on the Activity feed within ~30s; the corresponding `ingestion_intake` row reaches `status = 'compiled'`. (See §4 for the full marker list.)
- [ ] Wiki page rendered in Gitea with populated frontmatter (`schema_version`, `prompt_version`, `compiled_at`, `compiled_by_run_id`) and a `Worldview-Impact` git trailer on the commit.
- [ ] Activity feed populated with at least 5 events; no console errors in the management UI; no red rows in `agent_runs`.
- [ ] PRD §5 success criteria 1, 2, 4, 6, 7, 8 verified manually:
  - **#1** — fresh `docker compose up -d` produces a bootable admin + a default domain without manual DB edits.
  - **#2** — an ingested PDF appears as a compiled wiki page with populated frontmatter and a `page_citations` row.
  - **#4** — per-domain LLM policy pinned to local Ollama rejects a cloud-provider call with a typed `LlmPolicyViolationError`.
  - **#6** — the prompt-injection corpus passes for every locale × agent.
  - **#7** — `wikiWrite` is the sole write path; ESLint boundary `no-direct-gitea-write` enabled.
  - **#8** — `engine-ingestion` and `engine-self-operating` do not import each other (`no-cross-engine-import`).
- [ ] Operator has read THREAT-MODEL §5 PR checklist + §7 residual risks list and signed off on the residuals as acceptable for the pilot's first weeks.
- [ ] Maintainer has signed `docs/threat-model-signoff-0.1.0-a.md` (the canonical pre-tag artifact). Pre-fill the §5 automatable items by running `pnpm threat-model:preflight` against the candidate closing commit; spot-check the 8 maintainer-judgment items (items 2, 3, 4, 5, 6, 7, 8, 11) at the cited `path:line` refs; record the GO / STOP / MORE-WORK recommendation in the closure block.
- [ ] Rollback path (§6) exercised at least once: a binding disabled, the n8n equivalent re-enabled, output verified, the binding re-enabled.

When every box is ticked, the deployment is pilot-ready. the partner's two-week soak begins; phase-b entry gate (`IMPLEMENTATION-PLAN.md` §2.1) opens after a sev-1-incident-free fortnight.
