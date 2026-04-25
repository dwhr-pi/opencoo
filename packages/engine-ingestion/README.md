# @opencoo/engine-ingestion

Engine scaffold for the ingestion side of opencoo. Concrete pipelines (Scanner, Compiler, Lint, Heartbeat) ship in PRs 14-17 and plug in via the `PipelineDefinition` surface this package exports.

This package is the **harness, not the workload** — it owns:

- **Boot config** (`loadEngineConfig`): env validation, `_FILE` Docker-secrets convention, fail-fast on misconfig.
- **HTTP probes** (`buildServer`): Fastify v5 `/health` (always 200) + `/ready` (200 when every probe passes, 503 otherwise). Reverse proxy gates traffic via `/ready`.
- **Probe primitives** (`postgresProbe`, `redisProbe`): `SELECT 1` + `PING` against injected clients; never throw — fail-closed by contract.
- **Pipeline registry** (`PipelineRegistry`): insertion-ordered Map; rejects duplicate names; concrete pipelines `register(definition)` at boot.
- **Queue factory** (`buildIngestionQueue`): one BullMQ Queue per pipeline at the convention `ingestion.<slug>` (architecture.md §6.5 DLQ convention).
- **Engine entrypoint** (`start`): wires the above into a running process; returns immediately, lets the proxy gate traffic on `/ready`.

It does **not** own:

- Concrete pipeline logic — that's PRs 14-17 (Scanner, Compiler, Lint, Heartbeat).
- DB schema — `pgTable` definitions live in `@opencoo/shared/db/schema` (CLAUDE.md schema-ownership rule).
- LLM calls — pipelines accept an `LlmRouter` via DI from `@opencoo/shared/llm-router`. The engine harness never imports `@ai-sdk/*` directly.
- Wiki writes — pipelines accept a `WikiAdapter` via DI; the runtime composition root (PR 30 CLI) wires up `@opencoo/wiki-gitea`.
- A `bin/` shim — startup orchestration is the CLI's job (PR 30).

## Quickstart (concrete pipeline author, PR 14+)

```ts
import {
  start,
  PipelineRegistry,
  type PipelineDefinition,
} from "@opencoo/engine-ingestion";

const scanner: PipelineDefinition = {
  name: "scanner",
  schedule: "0 */4 * * *", // every 4 hours
  concurrency: 1,
  async run(ctx) {
    const { db, redis, logger, wikiAdapter } = ctx;
    // pipeline body — domain queries, source pulls, etc.
    logger.info("scanner.run", { /* … */ });
  },
};

const registry = new PipelineRegistry();
registry.register(scanner);

const engine = await start({ registry });
// engine.app — Fastify instance (already listening)
// engine.db — pg.Pool
// engine.redis — ioredis client
// engine.config — typed config
// engine.close() — tear down everything

// process.on('SIGTERM', () => engine.close());
```

## Configuration

| Env var | Required? | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes (or `_FILE`) | — | Postgres connection string. |
| `REDIS_URL` | yes (or `_FILE`) | — | BullMQ connection. |
| `GITEA_URL` | yes (or `_FILE`) | — | Wiki transport target (validated as URL). |
| `PORT` | no | `8080` | HTTP port for `/health` + `/ready`. |
| `LOG_LEVEL` | no | `info` | One of `debug`/`info`/`warn`/`error`. |
| `NODE_ENV` | no | `development` | One of `development`/`test`/`staging`/`production`. |

`_FILE` variants (`DATABASE_URL_FILE`, `REDIS_URL_FILE`, `GITEA_URL_FILE`) read the value from disk, stripping a single trailing newline run. **The `_FILE` form wins when both are set** — Docker-secrets convention, matching `.env.example` and `loadEncryptionKey` in `@opencoo/shared`. Setting both is a misconfig, but in production the safe answer is to honour the file-mounted secret over a possibly-stale inline.

These are the only env vars the engine reads. Everything else (per-domain LLM policy, source bindings, schedules) lives in Postgres and is edited via the management UI (UI-first principle). The `no-feature-env-vars` ESLint rule enforces this — adding a new env read requires a rule allowlist update.

## HTTP surface

```
GET /health   → 200 { "status": "ok" }                    # always
GET /ready    → 200 { "status": "ready",     "probes": { "postgres": {"ok": true},  "redis": {"ok": true} } }
              | 503 { "status": "not_ready", "probes": { "postgres": {"ok": false, "reason": "..."}, "redis": {"ok": true} } }
```

`/ready` runs every probe per request — no caching in v0.1. Probes execute concurrently, so latency is bounded by the slowest probe, not their sum. If `/ready` latency becomes a problem under load, v0.2 can add a short TTL cache.

## Pipeline definition surface

```ts
interface PipelineDefinition {
  readonly name: string;             // queue suffix; stable slug
  readonly schedule?: string;        // cron, optional
  readonly concurrency?: number;     // BullMQ worker concurrency, defaults to 1
  run(context: PipelineContext): Promise<void>;
}

interface PipelineContext {
  readonly db: pg.Pool;
  readonly redis: ioredis.Redis;
  readonly logger: Logger;
  readonly wikiAdapter: WikiAdapter;     // from @opencoo/shared/wiki-write
  readonly llmRouter?: LlmRouter;        // optional — Compiler needs it; Scanner doesn't
}
```

`llmRouter` is intentionally optional. Scanner and the static-analysis half of Lint don't need to call models; they walk DB rows and source manifests. Compiler / Heartbeat do — they receive `llmRouter` from the harness when the runtime composition root has wired one up.

## Queue naming

`buildIngestionQueue("scanner", { connection: redis })` → BullMQ Queue named `ingestion.scanner`.

The DLQ convention (architecture.md §6.5) suffixes `.dead`: `ingestion.scanner.dead`. The factory rejects slugs containing `.` so a typo can't accidentally produce a queue that collides with the DLQ namespace.

The intake DLQ (PR 14) uses a separate name shape: `ingestion.dlq.intake`. It's constructed directly via `new Queue(...)` in the runtime composition root (PR 30 CLI), bypassing `buildIngestionQueue` since the prefix has multiple dots.

## Intake module (PR 14)

The intake module turns an inbound webhook delivery (or a Scanner-discovered source change in PR 15+) into a row in `webhook_events` / `ingestion_intake` and a job on the Scanner BullMQ queue. It owns:

- **`recordIntake(args)`** — INSERT-or-skip into `ingestion_intake`, idempotent per `(binding_id, source_doc_id, source_revision)`. Used by both the webhook receiver below and the Scanner pipeline (PR 15+).
- **`recordWebhook(args)`** — INSERT-or-bump into `webhook_events`. Per Q12 of the approved plan, a duplicate `(provider, event_id)` UPDATEs `delivery_count = delivery_count + 1` rather than creating a new row. The `webhookEvents` table is intentionally NOT in the `no-update-append-only` ESLint rule's allowlist (only the 6 audit-trail tables are).
- **`buildWebhookReceiver(deps)`** — a Fastify plugin that mounts a single route, `POST /webhooks/:bindingId`, with a 5MB body cap.
- **`InMemoryAdapterRegistry`** — engine-ingestion looks up the source adapter for an inbound binding by `adapter_slug`. v0.1 stub holds just `{slug}`; PR 23+ widens to the full SourceAdapter contract.

### Webhook receiver flow

```
POST /webhooks/:bindingId
  → resolve binding by id            (404 if unknown, no DB writes)
  → require adapter for binding.adapter_slug
                                     (500 + DLQ if not registered)
  → credentialStore.read(binding.credentials_id)
                                     (audit log fires; 500 + DLQ if missing)
  → webhookVerifier.verify({body, secret, signature})
  → recordWebhook(...)                (Q12 dedupe)
  → on signature_ok + fresh insert: scannerQueue.add(...)
  → on signature mismatch:           401 + dlqQueue.add(...)
  → on duplicate event-id:           200 with delivery_count:N — NO scanner enqueue
```

The receiver captures the **raw request body** via Fastify's `addContentTypeParser({parseAs: 'buffer'})` so HMAC verification operates on the exact bytes the sender hashed (JSON parsing happens downstream). Required headers:

- `X-Signature` — `sha256=<hex>` (Gitea/GitHub style) or raw 64-char hex.
- `X-Event-Id` — provider's idempotency key (optional). Without it, every delivery becomes a new row.
- `X-Provider` — short slug for the upstream provider (`gitea`, `github`, `drive`, …). Defaults to `binding.adapter_slug`.

`payload` is stored as `null` by default for privacy (Q13). PR 23+ adapters opt in to retaining the payload by setting an explicit retention policy on the binding.

### Wiring

```ts
import {
  buildWebhookReceiver,
  InMemoryAdapterRegistry,
} from "@opencoo/engine-ingestion";
import { HmacSha256Verifier } from "@opencoo/shared/webhook-verifier";

const adapterRegistry = new InMemoryAdapterRegistry();
adapterRegistry.register({ slug: "drive" });

const app = buildWebhookReceiver({
  db,                     // drizzle(pg.Pool, { schema })
  credentialStore,        // DrizzleCredentialStore in prod
  adapterRegistry,
  verifier: new HmacSha256Verifier(),
  scannerQueue,           // BullMQ Queue: ingestion.scanner
  dlqQueue,               // BullMQ Queue: ingestion.dlq.intake
});
```

## Classifier (PR 15)

The classifier subsystem is the first LLM-driven pipeline stage. `classify()` wires four fail-closed guards from `THREAT-MODEL.md` §3.4:

1. **Binding-guard** — `assertBindingNotWildcardOnly` refuses bindings whose `allowed_paths` is empty, `["**"]`, or any `**/foo` shape. Fires BEFORE the LLM is invoked so a config bug doesn't waste a token.
2. **Spotlight** — `spotlight()` wraps the source body in `<source_content source="..." fetched_at="...">…</source_content>`. Escapes `&` first, then `<`/`>`, then neutralises six sentinel families (`source_content`, `system`, `assistant` × open/close) case-insensitively. Documented order is the security property: amp-first prevents pre-encoded `&amp;lt;system&amp;gt;` from self-decoding.
3. **Strict Zod** — `CLASSIFIER_OUTPUT_SCHEMA` is `.strict()`, so any extra field the model invents (e.g. `{"execute_arbitrary_code":"..."}`) is rejected by `LlmRouter.generateObject<T>()`.
4. **Domain + path guards** — every `target_domains[].domain_slug` must be in `allowedDomains`; every `page_paths[*]` must pass both the `@opencoo/shared/wiki-write` shape guard (no `..`, no `wiki-` prefix, lowercase) and a `picomatch` glob match against the binding's `allowed_paths`.

Failure in any layer throws a `validation`-class typed error (`BindingConfigError`, `LlmProviderError`, `ClassifierValidationError`, `ClassifierPathError`) so the Scanner pipeline (PR 16+) can DLQ uniformly. There is no retry — adversarial signals get DLQ'd, not re-prompted.

### Injection corpus

`tests/classifier/injection-corpus/` contains five EN + five PL adversarial fixtures plus matching `expected/*.json` outcome files. The driver test (`tests/classifier/injection.test.ts`) runs each fixture against a deterministic `MockLlmClient` whose response is the worst-case (fully-pwned) model output and asserts the orchestrator routes to DLQ via the recorded typed error.

Adding a corpus entry: drop a `.txt` fixture in `injection-corpus/{en,pl}/` and a matching `expected/<locale>-<basename>.json` file. The discovery walk picks it up; no driver edits required.

To run only the corpus:

```bash
pnpm test:injection
```

To run the corpus against a real LLM (OpenRouter, gated to keep CI cheap):

```bash
RUN_REAL_LLM=1 OPENROUTER_API_KEY=sk-or-... pnpm test:injection
```

In real-LLM mode the assertion changes to "the output either conforms to the binding OR the orchestrator throws a validation error." Both outcomes are passing walls; the failure case is silent acceptance of an attacker-controlled path or domain. Default model is `moonshotai/kimi-k2.6` (the OpenRouter budget cap is calibrated for it); override with `RUN_REAL_LLM_MODEL=...` per run, or set `OPENROUTER_DEFAULT_MODEL=...` in a repo-root `.env` (auto-loaded by `tests/setup.ts`).

## Compiler (PR 16, plan #72)

The compiler is the second LLM-driven pipeline stage. After the Classifier returns the page paths a source belongs in, `compile()` runs a `tier:'thinker'` LLM merge per page and produces ONE atomic wikiWrite commit. Four phases:

1. **Phase 1 — gather (fail-fast).** For every page path, read the existing page and call `mergePage` to get `{ merged_body, worldview_impact }`. The strict Zod schema + sentinel/frontmatter scrub guards run here. Any rejection throws BEFORE `wikiWrite` is invoked, so the wiki repo is never left in a partial multi-page state (Q7).
2. **Phase 2 — partition.** Skip-write optimisation (Q6): when `merged_body` equals the existing page body (frontmatter stripped from the comparison so a regenerated `compiled_at` doesn't false-trigger), log `compiler.no-op` and emit no operation for that page. The page still gets a `page_citations` row — we processed the source.
3. **Phase 3 — write.** Build ONE `wikiWrite` call containing every non-no-op replace operation, with the aggregated `worldviewImpact` bullets passed through to the new wiki-write trailer (capped at the Zod max=20 with a warn log when we truncate).
4. **Phase 4 — citations (soft).** Append `page_citations` rows for every page processed (no-op + written alike). A failure here is logged + alerted but does NOT roll back the wiki commit (Q8) — a reconciliation pass (future PR) backfills missing citations.

The compiler reuses `spotlight()` from the sibling `classifier/` subdir, so the same XML envelope wraps the source content. The compiler prompt (loaded via `@opencoo/shared/prompts` with `name:'compiler'`) instructs the model to leave the frontmatter to the system, scrub `<source_content` literals from its output, and emit `worldview_impact` bullets as deltas (not body copies). `mergePage` re-checks both contracts as belt-and-suspenders.

`page_citations` real columns (verified during planning, plan #72): `(id, domain_slug, page_path, source_binding_id, source_ref, compiled_by_run_id, prompt_version, created_at)`. The opaque `source_ref` text + binding FK uniquely attribute a page to the source that produced it; `prompt_version` (sourced from the loader) lets a stale-output bug be triaged by querying which prompt revision compiled which page.

## Pipelines (PR 17, plan #77)

`src/pipelines/` implements the five v0.1 ingestion pipelines architecture §9 names. Each is a pure function the composition root (PR 30 CLI) wires to its BullMQ queue + scheduler via `Queue.upsertJobScheduler` (bullmq 5.76.1):

- **`runScanner`** (every 4h) — for each enabled binding, look up the `SourceAdapter` (new `@opencoo/shared/source-adapter` port), call `scan(cursor)` with the persisted `last_scan_cursor` (migration 0004), dedupe via `ingestion_intake` UNIQUE, enqueue `scanner.classify` jobs (1MiB inline payload cap), persist new cursor + `last_scanned_at`. At-least-once on enqueue failure: cursor stays unchanged so the next cron run retries; intake UNIQUE deduplicates the docs already enqueued.
- **`runIndexRebuilder`** (every 6h) — `wikiAdapter.listMarkdown` (new port method) → `buildIndexBody` groups by top-level directory and emits a sorted index → `wikiWrite` with the new `[index-rebuild]` tag. Skip-write when the regenerated body equals the existing one.
- **`runReviewDispatcher`** (event-driven) — consumes `ingestion.review.dispatch` jobs the Compiler emits via its `reviewDispatch` hook. Validates payload via Zod-strict, logs `review.dispatched` with the routing key. Treats `review_role` as opaque text (D4 / Q5) — log, don't dereference. v0.1 writes no row anywhere; PR 29+ Review Dashboard reads directly from the audit log.
- **`runCleanup`** (weekly) — two-pass DELETE of `llm_usage_debug` rows older than the per-domain horizon (`domain.retention_days ?? DEFAULT_DEBUG_RETENTION_DAYS=7`). Pass 1: per-domain. Pass 2: orphan pass for rows whose `llm_usage` parent has no `domain_id`. **The load-bearing invariant suite** (`tests/pipelines/cleanup.test.ts`) snapshots row counts on every append-only table (`page_citations`, `redaction_events`, `erasure_log`, `miner_suppressions`, `agent_runs`) AND the wiki HEAD SHA before and after the run, then asserts equality. Cleanup never touches anything except `llm_usage_debug`.
- **`runCompilationWorker`** — consumes `scanner.classify` jobs. Decode payload → `loadBindingMeta` → `classify` (Worker tier) → for each routed `(domain_slug, page_paths)`, `compile` (Thinker tier) atomically. Marks intake row classified on success. Multi-domain output → multiple `compile()` calls, each its own atomic wikiWrite per Q7. The Compiler's post-commit `reviewDispatch` hook fires from inside `compile()`, NOT here — atomicity per Q7 stays intact.

The compiler grew an optional `reviewDispatch` callback (extension 5): fires AFTER the wikiWrite + page_citations, only when a commit landed AND `domain.review_role` is non-null. Soft-fail same shape as page_citations on dispatch error.

## Port extensions (PR 17, plan #77)

- **`@opencoo/shared/source-adapter`** — minimal v0.1 port (`{slug, scan({cursor, now?})}`). PR 23+ adds concrete adapters (Drive, Asana, Fireflies, n8n, gitea-wiki).
- **`WikiAdapter.listMarkdown(domainSlug)`** — new method on the existing port. InMemory + Gitea both implement; the contract suite (`@opencoo/shared/adapter-contract-tests/wiki-adapter`) gained 2 new assertions covering empty domain → `[]` and *.md filtering + sort.
- **`WikiWriteTagSchema += '[index-rebuild]'`** — single enum addition for Index Rebuilder commits.
- **Migration 0004 (`sources_bindings.last_scan_cursor: text`, nullable)** — opaque pagination cursor the Scanner persists across runs.

## Pinned versions

Pinned at branch start (2026-04-25):

- `fastify@5.8.5`
- `bullmq@5.76.1`
- `ioredis@5.10.1`
- `pg@8.20.0`
- `picomatch@4.0.3` (classifier path-guard)
- `ioredis-mock@8.13.1` (devDep)

## Boundary rules enforced

- **`no-feature-env-vars`**: only the 16 default-allowlisted env vars. Adding a read requires a rule update.
- **`no-direct-llm-sdk`**: the engine never imports `@ai-sdk/*`. Any LLM call goes through `@opencoo/shared/llm-router`.
- **`no-direct-gitea-write`**: the engine never imports from `packages/adapters/wiki-gitea/**`. The runtime composition root (PR 30 CLI) wires `wikiGiteaAdapter()` into `start()`'s context.
- **`no-cross-engine-import`**: the engine cannot import from `packages/engine-self-operating/**` (PR 19+).
- **No `pgTable` calls**: schema lives in `@opencoo/shared/db/schema` only (CLAUDE.md schema-ownership).

## Testing

```bash
pnpm --filter @opencoo/engine-ingestion test
```

Eleven test files, 79 assertions across two tiers: scaffolding (config 13, types 5, registry 6, probes-postgres 5, probes-redis 4, queue 4, server 8, start 5) and intake (adapter-registry 8, record-intake 5, record-webhook 8, webhook-receiver 8). All hermetic — `vi.fn` mocks for the postgres probe, `ioredis-mock` for Redis, `@electric-sql/pglite` (in-process Postgres, real semantics) for the DB-write tests, no external services required.
