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

## Pinned versions

Pinned at branch start (2026-04-25):

- `fastify@5.8.5`
- `bullmq@5.76.1`
- `ioredis@5.10.1`
- `pg@8.20.0`
- `ioredis-mock@8.13.1` (devDep)

## Boundary rules enforced

- **`no-feature-env-vars`**: only the 16 default-allowlisted env vars. Adding a read requires a rule update.
- **`no-direct-llm-sdk`**: the engine never imports `@ai-sdk/*`. Any LLM call goes through `@opencoo/shared/llm-router`.
- **`no-direct-gitea-write`**: the engine never imports from `packages/adapters/wiki-gitea/**`. The runtime composition root (PR 30 CLI) wires `wikiGiteaAdapter()` into `start()`'s context.
- **`no-cross-engine-import`**: the engine cannot import from `packages/engine-self-operating/**` (PR 18+).
- **No `pgTable` calls**: schema lives in `@opencoo/shared/db/schema` only (CLAUDE.md schema-ownership).

## Testing

```bash
pnpm --filter @opencoo/engine-ingestion test
```

Eleven test files, 79 assertions across two tiers: scaffolding (config 13, types 5, registry 6, probes-postgres 5, probes-redis 4, queue 4, server 8, start 5) and intake (adapter-registry 8, record-intake 5, record-webhook 8, webhook-receiver 8). All hermetic — `vi.fn` mocks for the postgres probe, `ioredis-mock` for Redis, `@electric-sql/pglite` (in-process Postgres, real semantics) for the DB-write tests, no external services required.
