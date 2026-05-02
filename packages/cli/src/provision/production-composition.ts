/**
 * Production composition root for the CLI's `serve` verb (PR-M2,
 * phase-a appendix #5).
 *
 * Reads env once, constructs the heavy ingredients (pg.Pool,
 * Redis, GiteaClient + WikiAdapter, GuardAdapter, LlmRouter,
 * CredentialStore, source-adapter factory map), and returns the
 * `WorkerContext` engine-ingestion's `start({ mode: 'workers' })`
 * consumes. The orchestrator (serve.ts) wraps composition in a
 * try/catch — on failure, it falls back to `mode: 'probes-only'`
 * with a clear stderr line so the management UI stays up.
 *
 * # Env surface
 *
 *   - `DATABASE_URL` (required) — pg.Pool connection string.
 *   - `REDIS_URL` (required) — ioredis connection URL.
 *   - `ENCRYPTION_KEY` (required) — 32-byte base64 vault key.
 *   - `GITEA_URL` (required) — Gitea base URL for wiki transport.
 *   - `GITEA_PAT` (required) — service-account PAT for wiki commits.
 *   - `GITEA_PROVISION_ORG` (optional, default 'opencoo') —
 *     org/owner of provisioned domain repos. Same env the
 *     admin-API composition env already reads.
 *
 * No NEW env vars introduced (THREAT-MODEL §2 invariant 9).
 * `GITEA_PAT` is the same credential the gitea-wiki-mcp-server
 * already consumes; `GITEA_PROVISION_ORG` is already loaded by
 * the admin-API composition env. Wiki branch + repo-prefix +
 * instance-id are HARDCODED constants in this file (not env
 * reads) — v0.1's distributable shape is one branch per repo,
 * one wiki-prefix convention, one engine instance per process.
 * If a deployment ever needs to vary them, the value moves to
 * Postgres config (UI-managed) per the §2 invariant.
 */
import pg from "pg";
import { Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  composeProductionWorkerContext,
  type ProductionSourceAdapterFactory,
  type ProductionWorkerContext,
} from "@opencoo/engine-ingestion";
import {
  DrizzleCredentialStore,
  loadEncryptionKey,
} from "@opencoo/shared/credential-store";
import {
  readWithFile,
  requireWithFile,
} from "@opencoo/shared/engine-scaffold";
import {
  InMemoryQueuePauser,
  LlmRouter,
  createProvider,
  type LlmProvider,
} from "@opencoo/shared/llm-router";
import { ConsoleLogger, type Logger } from "@opencoo/shared/logger";
import { scrubPat } from "@opencoo/shared/scrub";

import {
  GiteaRestClient,
  giteaWikiAdapter,
} from "@opencoo/wiki-gitea";
import { guardRedactionRegex } from "@opencoo/guard-redaction-regex";

const COMPOSITION_NAME = "cli/serve" as const;

/** Round-3 fix #3: shared scrub-and-cap helper. The two error-log
 *  sites in this file (`llm_router.provider_unavailable` and
 *  `source_adapter_factory.skipped`) both surface a thrown
 *  `Error.message` from a dynamic-import / provider-construction
 *  path. THREAT-MODEL §3.6 invariant 11 says scrub credential
 *  patterns + cap at 200 chars; this helper unifies the shape so
 *  a future log site can't drift back to the unscrubbed form
 *  Copilot flagged in round-3. Mirrors the `safeError` helper in
 *  `engine-ingestion/src/workers/production-context.ts`. */
const ERROR_MESSAGE_MAX_LENGTH = 200;
function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubPat(raw).slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

export interface ProductionCompositionResult {
  readonly workerContext: ProductionWorkerContext;
  readonly redisConnection: ConnectionOptions;
  readonly pgPool: pg.Pool;
  readonly redis: Redis;
}

/** Narrow shape of the run-event emitter the WorkerContext consumes.
 *  Mirrors `IngestionRunEventEmitter` in engine-ingestion's
 *  context.ts — defined here so the orchestrator can pass an opaque
 *  bus across the engine boundary without dragging the full SseBus
 *  type. The PR-M1 sse-bridge in engine-ingestion publishes to
 *  whatever satisfies this shape. */
export interface ComposeSseBus {
  emitRunEvent(event: {
    readonly runId: string;
    readonly definitionSlug: string;
    readonly status: "running" | "success" | "failed" | "timeout";
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly errorMessage?: string;
  }): void;
}

export interface ComposeProductionArgs {
  readonly env: Record<string, string | undefined>;
  /** Optional logger override. Defaults to a ConsoleLogger writing
   *  to stdout. */
  readonly logger?: Logger;
  /** Round-2 fix #1 — the self-op engine's SseBus. When present,
   *  threaded into the WorkerContext so per-job lifecycle events
   *  emitted by the PR-M1 sse-bridge land on the SAME bus the
   *  Activity feed (`GET /api/admin/events`) streams from. When
   *  undefined (e.g. self-op didn't boot — boot-tolerance), the
   *  workers still run; their lifecycle events just don't reach
   *  the UI. */
  readonly sseBus?: ComposeSseBus;
}

/** Construct the production WorkerContext + the underlying pg.Pool
 *  / Redis handles. The orchestrator owns lifecycle of every
 *  returned handle — `closeProducers` on the WorkerContext closes
 *  the producer-side BullMQ Queue; the orchestrator separately
 *  closes the pg.Pool + Redis.
 *
 *  Throws on missing required env or any construction failure.
 *  Caller wraps in try/catch and falls back to probes-only.
 */
export async function composeProductionFromEnv(
  args: ComposeProductionArgs,
): Promise<ProductionCompositionResult> {
  const logger = args.logger ?? new ConsoleLogger();
  const databaseUrl = requireWithFile(args.env, "DATABASE_URL", COMPOSITION_NAME);
  const redisUrl = requireWithFile(args.env, "REDIS_URL", COMPOSITION_NAME);
  const giteaUrl = requireWithFile(args.env, "GITEA_URL", COMPOSITION_NAME);
  const giteaPat = requireWithFile(args.env, "GITEA_PAT", COMPOSITION_NAME);

  const provisionOrg = readWithFile(args.env, "GITEA_PROVISION_ORG") ?? "opencoo";
  // v0.1 baked-in constants — see file-header note. Per
  // THREAT-MODEL §2 invariant 9, these MUST NOT be env vars.
  const wikiBranch = "main";
  const wikiRepoPrefix = "wiki";
  const instanceId = "opencoo";

  // Single ConnectionOptions object reused for both the Redis
  // client construction options AND the BullMQ queue handle the
  // composition exposes — keeps the BullMQ requirements
  // (maxRetriesPerRequest: null, enableReadyCheck: false) in one
  // place.
  const redisConnection: ConnectionOptions = {
    url: redisUrl,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  const pgPool = new pg.Pool({ connectionString: databaseUrl });
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const db = drizzle(pgPool);

  // Credential store — encrypts/decrypts via AES-GCM with the
  // vault key. The vault key MUST be a 32-byte base64 string;
  // loadEncryptionKey throws on invalid shape.
  const credentialStore = new DrizzleCredentialStore({
    db: db as unknown as ConstructorParameters<
      typeof DrizzleCredentialStore
    >[0]["db"],
    key: loadEncryptionKey(args.env as NodeJS.ProcessEnv),
    logger,
  });

  // WikiAdapter — production Gitea REST client wrapped in the
  // shared adapter shape.
  const wikiAdapter = giteaWikiAdapter({
    client: new GiteaRestClient({ url: giteaUrl, token: giteaPat }),
    owner: provisionOrg,
    repoPrefix: wikiRepoPrefix,
    branch: wikiBranch,
  });

  // GuardAdapter — single regex-redaction baseline; per-domain
  // policy upgrades arrive in v0.2.
  const guardAdapter = guardRedactionRegex();

  // LlmRouter — production wiring requires a real LlmProvider.
  // For v0.1 the provider needs ONE concrete implementation per
  // deployment; the per-domain `llm_policy` selects between
  // providers via the `LlmProviderCall.provider` field. This
  // factory composes a multi-provider dispatcher that lazy-loads
  // the matching `@ai-sdk/*` package on the first call. When NO
  // provider env is set, the dispatcher throws on every call —
  // workers that don't reach an LLM call (e.g. the index-rebuild
  // pipeline against an empty wiki) still function.
  const router = new LlmRouter({
    db: db as unknown as ConstructorParameters<typeof LlmRouter>[0]["db"],
    env: args.env as NodeJS.ProcessEnv,
    logger,
    pauser: new InMemoryQueuePauser(),
    provider: createMultiProviderDispatcher(args.env, logger),
  });

  // Source-adapter factories — the orchestrator dynamic-imports
  // every shipped adapter package. The shared adapter-registry
  // contract gives us the slug union; we wire one factory per
  // slug, each adapting that adapter's specific extras shape into
  // the production-context's narrower `(credentialStore,
  // credentialId, config)` signature.
  const sourceAdapterFactories = await loadSourceAdapterFactories(logger);

  const workerContext = await composeProductionWorkerContext({
    db: db as unknown as Parameters<
      typeof composeProductionWorkerContext
    >[0]["db"],
    logger,
    redisConnection,
    redisClient: redis,
    credentialStore,
    sourceAdapterFactories,
    wikiAdapter,
    router,
    guardAdapter,
    author: {
      name: `opencoo-${instanceId}`,
      email: `${instanceId}@opencoo.local`,
    },
    instanceId,
    // Round-2 fix #1: forward the orchestrator-supplied bus so
    // every PR-M1 sse-bridge listener (compile / scanner /
    // index-rebuild / cleanup workers) emits onto the SAME bus
    // the management UI streams from.
    ...(args.sseBus !== undefined ? { sseBus: args.sseBus } : {}),
  });

  return { workerContext, redisConnection, pgPool, redis };
}

/** Multi-provider dispatcher — routes every `LlmProviderCall` to
 *  the matching `@ai-sdk/*` provider via the shared
 *  `createProvider` factory. Caches per-provider client modules
 *  to avoid re-importing on every call.
 *
 *  Provider-specific API keys come from env (already standard
 *  practice; not new): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 *  `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`. Missing key → the
 *  underlying provider's `LlmProviderError` surfaces on the
 *  first call for that provider; the per-pipeline retry policy
 *  bubbles it. */
/** Provider-specific env-var → ProviderOptions field mapping.
 *  Centralised so a future env-var rename doesn't require touching
 *  the resolver below. Per-provider keys aren't new — already
 *  standard `@ai-sdk/*` practice. */
const PROVIDER_ENV_OPTS: Readonly<
  Record<string, { readonly envVar: string; readonly field: "apiKey" | "baseUrl" }>
> = {
  openai: { envVar: "OPENAI_API_KEY", field: "apiKey" },
  anthropic: { envVar: "ANTHROPIC_API_KEY", field: "apiKey" },
  google: { envVar: "GOOGLE_API_KEY", field: "apiKey" },
  ollama: { envVar: "OLLAMA_BASE_URL", field: "baseUrl" },
};

function providerOptsFromEnv(
  env: Record<string, string | undefined>,
  providerName: string,
): { apiKey?: string; baseUrl?: string } {
  const spec = PROVIDER_ENV_OPTS[providerName];
  if (spec === undefined) return {};
  const value = env[spec.envVar];
  if (value === undefined || value.length === 0) return {};
  return { [spec.field]: value };
}

function createMultiProviderDispatcher(
  env: Record<string, string | undefined>,
  logger: Logger,
): LlmProvider {
  // Lazy-load each provider on first use — keeps boot fast and
  // makes the dispatcher tolerant of missing optional deps.
  const cache = new Map<string, Promise<LlmProvider>>();
  const resolve = (providerName: string): Promise<LlmProvider> => {
    const cached = cache.get(providerName);
    if (cached !== undefined) return cached;
    const pending = createProvider(
      providerName as never,
      providerOptsFromEnv(env, providerName),
    ).catch((err: unknown) => {
      // Don't cache the rejection — let the next call retry the
      // import in case the operator fixes the env mid-run.
      cache.delete(providerName);
      // Round-3 fix #3: scrub + cap via the shared helper.
      // Previously this site applied scrubPat to the Error branch
      // but skipped the 200-char cap AND left the non-Error
      // (`String(err)`) fallback unscrubbed — both inconsistencies
      // Copilot flagged in round-3.
      logger.warn("llm_router.provider_unavailable", {
        provider: providerName,
        error: safeError(err),
      });
      throw err;
    });
    cache.set(providerName, pending);
    return pending;
  };

  return {
    async generate(call) {
      const provider = await resolve(call.provider);
      return provider.generate(call);
    },
  };
}

/** Try-import + register one adapter factory. A missing optional
 *  adapter package logs + skips rather than crashing composition.
 *  The static-string `import(...)` calls upstream keep TS module
 *  resolution + bundler cache lookups intact; this helper only
 *  factors out the try/catch + logging shape. */
async function tryLoadAdapter(
  out: Partial<Record<string, ProductionSourceAdapterFactory>>,
  logger: Logger,
  slug: string,
  build: () => Promise<ProductionSourceAdapterFactory>,
): Promise<void> {
  try {
    out[slug] = await build();
  } catch (err) {
    logger.warn("source_adapter_factory.skipped", {
      adapter_slug: slug,
      // Round-2 fix #2: scrub + cap. THREAT-MODEL §3.6 invariant 11.
      // Round-3 fix #3: routed through the shared `safeError`
      // helper so this site stays in lockstep with
      // `llm_router.provider_unavailable`.
      error: safeError(err),
    });
  }
}

/** Dynamic-import every shipped SourceAdapter package and adapt
 *  its factory signature to the production-context narrower shape.
 *
 *  Drive + n8n require production-only client constructors
 *  (`makeDrive`, `makeApi`); v0.1 throws inside the produced
 *  adapter with a "production client not wired" message rather
 *  than silently returning a stub when the operator binds them
 *  via the UI. */
async function loadSourceAdapterFactories(
  logger: Logger,
): Promise<Readonly<Record<string, ProductionSourceAdapterFactory>>> {
  const out: Partial<Record<string, ProductionSourceAdapterFactory>> = {};
  await tryLoadAdapter(out, logger, "asana", async () => {
    const mod = await import("@opencoo/source-asana");
    return (a) => mod.createAsanaSourceAdapter(a);
  });
  await tryLoadAdapter(out, logger, "fireflies", async () => {
    const mod = await import("@opencoo/source-fireflies");
    return (a) => mod.createFirefliesSourceAdapter(a);
  });
  await tryLoadAdapter(out, logger, "webhook", async () => {
    const mod = await import("@opencoo/source-webhook");
    return (a) => mod.createSourceWebhookAdapter(a);
  });
  await tryLoadAdapter(out, logger, "drive", async () => {
    const mod = await import("@opencoo/source-drive");
    return (a) =>
      mod.createGoogleDriveAdapter({
        ...a,
        makeDrive: () => {
          throw new Error(
            "drive: production makeDrive not wired in v0.1 — bind via UI when adapter ships",
          );
        },
      });
  });
  await tryLoadAdapter(out, logger, "n8n", async () => {
    const mod = await import("@opencoo/source-n8n");
    return (a) =>
      mod.createN8nSourceAdapter({
        ...a,
        makeApi: () => {
          throw new Error(
            "n8n: production makeApi not wired in v0.1 — bind via UI when adapter ships",
          );
        },
      });
  });
  return out as Readonly<Record<string, ProductionSourceAdapterFactory>>;
}
