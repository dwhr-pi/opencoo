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
import { Queue, type ConnectionOptions } from "bullmq";
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
  createForgetJobEnqueuer,
  WIKI_DELETE_QUEUE_SLUG,
  WIKI_RECOMPILE_QUEUE_SLUG,
  type ForgetJobEnqueueArgs,
  type ForgetJobPayload,
  type ForgetJobQueue,
} from "@opencoo/shared/forget";
import {
  InMemoryQueuePauser,
  LlmRouter,
  createProvider,
  type LlmProvider,
} from "@opencoo/shared/llm-router";
import { ConsoleLogger, type Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import {
  InMemoryDeleteCap,
  type DeleteCap,
} from "@opencoo/shared/wiki-write";

import {
  AgentDefinitionRegistry,
  HEARTBEAT_DEFINITION,
  HttpMcpToolClient,
  LINT_DEFINITION,
  SURFACER_DEFINITION,
  type AgentRunnerRegistry,
  type McpToolClient,
} from "@opencoo/engine-self-operating";
import {
  GiteaRestClient,
  giteaWikiAdapter,
} from "@opencoo/wiki-gitea";
import { guardRedactionRegex } from "@opencoo/guard-redaction-regex";
import {
  builderSkills,
  listAvailableTemplateSlugs,
} from "@opencoo/automation-n8n-mcp";

import { createProductionAgentRunners } from "./agent-runners.js";

const COMPOSITION_NAME = "cli/serve" as const;

export interface ProductionCompositionResult {
  readonly workerContext: ProductionWorkerContext;
  readonly redisConnection: ConnectionOptions;
  readonly pgPool: pg.Pool;
  readonly redis: Redis;
  /** PR-W1 (phase-a appendix #11) — the SAME `InMemoryDeleteCap`
   *  the workerContext's `wikiDeps` reads. The orchestrator threads
   *  this into `engine-self-operating.start({ deleteCap })` so the
   *  admin-API forget route's `peek/reserve` reads the SAME budget
   *  the compiler workers reserve against. Single-process v0.1
   *  shape per architecture §16. */
  readonly deleteCap: DeleteCap;
  /** PR-W1 (phase-a appendix #11) — composition-built enqueuer for
   *  the source-forget action (PR-R7). The orchestrator threads
   *  this into `engine-self-operating.start({ forgetJobEnqueuer })`
   *  so the admin-API route stops returning 503. The factory wraps
   *  two BullMQ queues (`wiki.recompile` + `wiki.delete`) opened on
   *  the SAME `redisConnection` the worker pool uses. */
  readonly forgetJobEnqueuer: (args: ForgetJobEnqueueArgs) => Promise<void>;
  /** PR-W1 (phase-a appendix #11) — close hook for the producer-side
   *  forget queue handles. Best-effort; orchestrator awaits this on
   *  SIGTERM AFTER worker drain (mirrors `closeProducers` on the
   *  WorkerContext). */
  readonly closeForgetQueues: () => Promise<void>;
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
  /** @internal Test seam (PR-W1, phase-a appendix #11) — override
   *  the BullMQ Queue constructor for the producer-side forget
   *  queues (`wiki.recompile` + `wiki.delete`). Defaults to the
   *  real `new Queue(name, { connection })` from bullmq. Tests pass
   *  a `vi.fn()` returning a stub with `add` so the composition can
   *  be exercised without ioredis-mock + real BullMQ wiring. */
  readonly forgetQueueFactory?: (
    name: string,
    connection: ConnectionOptions,
  ) => ForgetJobQueue & { close?(): Promise<void> };
  /** @internal Test seam (PR-W1, phase-a appendix #11) — override
   *  the pg.Pool factory. Defaults to `new pg.Pool({connectionString})`.
   *  Tests pass a PGlite-backed shim so the composition can be
   *  exercised without a real Postgres. */
  readonly pgPoolFactory?: (connectionString: string) => pg.Pool;
  /** @internal Test seam (PR-W1, phase-a appendix #11) — override
   *  the ioredis Redis factory. Defaults to `new Redis(redisUrl,
   *  {maxRetriesPerRequest:null,enableReadyCheck:false})`. Tests
   *  pass an ioredis-mock instance. */
  readonly redisFactory?: (redisUrl: string) => Redis;
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

  // PR-W1 test seams: tests pass PGlite + ioredis-mock here so the
  // composition can be exercised without a real Postgres / Redis.
  const pgPool =
    args.pgPoolFactory !== undefined
      ? args.pgPoolFactory(databaseUrl)
      : new pg.Pool({ connectionString: databaseUrl });
  const redis =
    args.redisFactory !== undefined
      ? args.redisFactory(redisUrl)
      : new Redis(redisUrl, {
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

  // PR-W1 (phase-a appendix #11) — single-process v0.1 delete-cap.
  // Constructed at the composition root so the SAME instance is
  // shared between:
  //   1. The ingestion compiler workers (via
  //      `composeProductionWorkerContext({ deleteCap })` →
  //      `wikiDeps.deleteCap`).
  //   2. The self-op admin-API forget route (via
  //      `engine-self-operating.start({ deleteCap })` →
  //      `registerAdminApi({ deleteCap })`).
  // Without identity sharing, the route's `peek/reserve` and the
  // workers' `wikiWrite` reservations would address two different
  // caps and a forget could blow past the per-domain daily limit
  // undetected (THREAT-MODEL §2 invariant 6 — bounded blast radius
  // for destructive ops).
  const deleteCap = new InMemoryDeleteCap();

  // PR-W1 (phase-a appendix #11) — producer-side BullMQ queues for
  // the source-forget action (consumer worker lands in a follow-up
  // PR; today the route 503s because no producer is wired). Same
  // multi-dot-prefix convention `production-context.ts` uses for
  // `ingestion.scanner` / `ingestion.intake.dlq`. The
  // `forgetQueueFactory` test seam lets unit tests substitute a
  // stub returning a spy queue instead of opening real BullMQ.
  //
  // PR-W6 follow-up — wire `defaultJobOptions` so a transport blip
  // retries with exponential backoff before landing in the failed
  // set (acts as DLQ at the attempts cap). The forget operation is
  // safely re-runnable: delete-page is idempotent (the worker's
  // existence probe + warn-and-continue branch handles a prior
  // partial commit), recompile-stub is log-only, and a cap-exceeded
  // throw is an INTENDED retry trigger (the daily window resets at
  // midnight UTC and the next retry succeeds). `removeOnComplete`
  // caps history so the queue doesn't grow unbounded under steady
  // forget volume; `removeOnFail` keeps the larger tail for operator
  // inspection of permanent failures (malformed payloads, schema
  // drift). Mirrors the worker docstring at forget-consumer.ts:64.
  const forgetQueueFactory =
    args.forgetQueueFactory ??
    ((name, connection): ForgetJobQueue & { close?(): Promise<void> } =>
      new Queue<ForgetJobPayload>(name, {
        connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 1000 },
        },
      }));
  const makeForgetQueue = (
    slug: string,
  ): ForgetJobQueue & { close?(): Promise<void> } =>
    forgetQueueFactory(slug, redisConnection);
  const recompileQueue = makeForgetQueue(WIKI_RECOMPILE_QUEUE_SLUG);
  const deleteQueue = makeForgetQueue(WIKI_DELETE_QUEUE_SLUG);
  const forgetJobEnqueuer = createForgetJobEnqueuer({
    recompileQueue,
    deleteQueue,
  });
  // Idempotent drain — the orchestrator (serve.ts) calls this on
  // SIGTERM AFTER the worker pool stops so any in-flight forget
  // enqueue completes first. Best-effort per queue: a single close
  // failure is logged but doesn't prevent the sibling from draining.
  let forgetQueuesClosing: Promise<void> | undefined;
  const closeForgetQueue = async (
    q: ForgetJobQueue & { close?(): Promise<void> },
    label: string,
  ): Promise<void> => {
    if (typeof q.close !== "function") return;
    try {
      await q.close();
    } catch (err) {
      logger.warn("forget_queue.close_failed", {
        queue: label,
        // Round-2 fix #2 style — scrub + cap. THREAT-MODEL §3.6.
        error: safeErrorMessage(err),
      });
    }
  };
  const closeForgetQueues = async (): Promise<void> => {
    if (forgetQueuesClosing !== undefined) return forgetQueuesClosing;
    forgetQueuesClosing = Promise.all([
      closeForgetQueue(recompileQueue, WIKI_RECOMPILE_QUEUE_SLUG),
      closeForgetQueue(deleteQueue, WIKI_DELETE_QUEUE_SLUG),
    ]).then(() => undefined);
    return forgetQueuesClosing;
  };

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
    // PR-W1 (phase-a appendix #11) — share the cap instance with
    // the workers so their `wikiWrite` reservations and the route's
    // `peek/reserve` address the SAME budget.
    deleteCap,
    // Round-2 fix #1: forward the orchestrator-supplied bus so
    // every PR-M1 sse-bridge listener (compile / scanner /
    // index-rebuild / cleanup workers) emits onto the SAME bus
    // the management UI streams from.
    ...(args.sseBus !== undefined ? { sseBus: args.sseBus } : {}),
  });

  return {
    workerContext,
    redisConnection,
    pgPool,
    redis,
    deleteCap,
    forgetJobEnqueuer,
    closeForgetQueues,
  };
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
 *  standard `@ai-sdk/*` practice. Current keys: `OPENAI_API_KEY`,
 *  `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`,
 *  `OPENROUTER_API_KEY` (PR-Q4 / appendix #9). */
const PROVIDER_ENV_OPTS: Readonly<
  Record<string, { readonly envVar: string; readonly field: "apiKey" | "baseUrl" }>
> = {
  openai: { envVar: "OPENAI_API_KEY", field: "apiKey" },
  anthropic: { envVar: "ANTHROPIC_API_KEY", field: "apiKey" },
  google: { envVar: "GOOGLE_API_KEY", field: "apiKey" },
  ollama: { envVar: "OLLAMA_BASE_URL", field: "baseUrl" },
  openrouter: { envVar: "OPENROUTER_API_KEY", field: "apiKey" },
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
        error: safeErrorMessage(err),
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

/** PR-Q8 — extract the asana PAT from the `auth`-half credential
 *  plaintext. The credential is written via the binding API as
 *  `JSON.stringify({"personal_access_token":"…","workspace_gid":"…"})`
 *  (see admin-API source-bindings persistence path). When the JSON
 *  is malformed or the field is missing/empty, throw a clean error
 *  scoped to this adapter — the AsanaClient's `scrubPat` wrapper
 *  ensures the message never leaks the raw bytes. */
export function extractAsanaPatFromAuthBlob(plaintext: Buffer): string {
  const text = plaintext.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `source-asana: credential plaintext is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      "source-asana: credential plaintext must be a JSON object with `personal_access_token`",
    );
  }
  const pat = (parsed as { personal_access_token?: unknown }).personal_access_token;
  if (typeof pat !== "string" || pat.length === 0) {
    throw new Error(
      "source-asana: credential plaintext is missing `personal_access_token` (string)",
    );
  }
  return pat;
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
      // Round-3 fix #3: routed through the shared
      // `safeErrorMessage` helper (PR-P3 consolidation, phase-a
      // appendix #8) so this site stays in lockstep with
      // `llm_router.provider_unavailable`.
      error: safeErrorMessage(err),
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
    // PR-Q8: inject `makeAsanaClient` per-binding so the default
    // `snapshotMode='on-event'` factory guard accepts the binding
    // and `enrichEvents` resolves a real client lazily on the first
    // dispatch. The credential plaintext is the JSON blob
    // `{"personal_access_token":"…","workspace_gid":"…"}` (the `auth`
    // half of the binding's credentialSchema); `patFromRecord`
    // extracts the PAT inside the AsanaClient on the first
    // fetchProjectSnapshot call.
    return (a) => {
      const makeAsanaClient = (): ReturnType<typeof mod.createAsanaClient> =>
        mod.createAsanaClient({
          credentialStore: a.credentialStore,
          credentialId: a.credentialId,
          patFromRecord: extractAsanaPatFromAuthBlob,
        });
      return mod.createAsanaSourceAdapter({
        ...a,
        makeAsanaClient,
      });
    };
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

// ─────────────────────────────────────────────────────────────────
// PR-N3 (phase-a appendix #6) — AgentRunnerRegistry composition.
// ─────────────────────────────────────────────────────────────────

/** Default URL for the gitea-wiki-mcp-server. Matches the
 *  README's `MCP_MODE=http npm start` default port. The operator
 *  overrides via `MCP_BASE_URL` when the server runs elsewhere
 *  (Docker network, reverse proxy, etc.). */
const DEFAULT_MCP_BASE_URL = "http://localhost:3000/mcp";

/** Minimal structural mirror of `McpToolCallClient` from
 *  @opencoo/automation-n8n-mcp — declared locally to avoid the
 *  cross-package type round-trip at the composition root signature. */
interface McpToolCallClientShape {
  callTool?(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ComposeAgentRunnersArgs {
  readonly env: Record<string, string | undefined>;
  /** Production LlmRouter — typically the same instance the
   *  ingestion WorkerContext consumes. The runners thread it
   *  through the harness's AgentRunContext. */
  readonly router: LlmRouter;
  /** Postgres pool — same instance the orchestrator opens for
   *  the ingestion composition. The runners reuse it for
   *  scope-check / binding / citation queries. */
  readonly pgPool: pg.Pool;
  /** Logger — error log lines route here with `safeErrorMessage`
   *  applied. */
  readonly logger?: Logger;
  /** Caller-supplied template catalog override (test path).
   *  When undefined, the function calls n8n-mcp via the env-derived
   *  client and falls back to the vendored builderSkills baseline
   *  on any failure. */
  readonly availableTemplateSlugs?: readonly string[];
  /** @internal Test seam — when present, listAvailableTemplateSlugs
   *  receives this client instead of the env-derived
   *  HttpMcpToolClient. Use `null` to simulate "n8n-mcp unreachable"
   *  without touching env vars. Production callers leave this
   *  undefined and let env-derivation run. (PR-O3, appendix #7). */
  readonly n8nMcpClient?: McpToolCallClientShape | null;
}

export interface ComposedAgentRunners {
  readonly mcp: McpToolClient;
  readonly definitions: AgentDefinitionRegistry;
  readonly runners: AgentRunnerRegistry;
}

export interface ComposeAgentRunnersFromEnvOnlyArgs {
  readonly env: Record<string, string | undefined>;
  readonly logger?: Logger;
  /** Closed set of n8n template slugs Surfacer can propose. */
  readonly availableTemplateSlugs?: readonly string[];
  /** @internal Test seam — see `ComposeAgentRunnersArgs.n8nMcpClient`.
   *  Threaded through to `tryComposeAgentRunnersFromEnv`. */
  readonly n8nMcpClient?: McpToolCallClientShape | null;
}

export interface ComposedAgentRunnersBundle extends ComposedAgentRunners {
  /** A pg.Pool the bundle owns. The orchestrator closes it on
   *  SIGTERM. */
  readonly pgPool: pg.Pool;
  /** The production LlmRouter the bundle constructed. The
   *  orchestrator threads this into
   *  `engine-self-operating.start({ agentRouter })` so the
   *  AgentDispatcher's per-dispatch context exposes the SAME
   *  router instance to every runner closure (round-2 fix #1
   *  on PR #57). Without identity sharing, the dispatcher would
   *  fall back to its `({} as unknown) as LlmRouter` empty-object
   *  cast and the first scheduled agent dispatch would crash on
   *  `ctx.router.generateObject is not a function`. */
  readonly router: LlmRouter;
  /** A close hook that drains the bundle's resources (pg.Pool).
   *  Idempotent; safe to call multiple times. */
  close(): Promise<void>;
}

/** Open a pg.Pool + LlmRouter against env, then compose the
 *  AgentRunnerRegistry. Returns null on the same boot-tolerance
 *  conditions as `tryComposeAgentRunnersFromEnv` PLUS a
 *  pgPool-construction failure (missing DATABASE_URL).
 *
 *  Used by the CLI's serve verb to open the registry alongside
 *  the self-op + ingestion engines without dragging the full
 *  ingestion WorkerContext composition.
 *
 *  PR-O3 (phase-a appendix #7): now async because
 *  `tryComposeAgentRunnersFromEnv` performs an outbound MCP call
 *  to n8n-mcp at boot to populate the Surfacer template catalog.
 *  The orchestrator (`composeStartedEngineWithBundle` in
 *  `serve.ts`) already awaits the bundle.
 */
export async function tryComposeAgentRunnersBundleFromEnv(
  args: ComposeAgentRunnersFromEnvOnlyArgs,
): Promise<ComposedAgentRunnersBundle | null> {
  const logger = args.logger ?? new ConsoleLogger();

  let databaseUrl: string;
  try {
    databaseUrl = requireWithFile(args.env, "DATABASE_URL", COMPOSITION_NAME);
  } catch (err) {
    logger.warn("mcp_http.unavailable", {
      reason: "DATABASE_URL not set — cannot open pool for agent runners",
      error: safeErrorMessage(err),
    });
    return null;
  }

  let pgPool: pg.Pool;
  try {
    pgPool = new pg.Pool({ connectionString: databaseUrl });
  } catch (err) {
    logger.warn("mcp_http.unavailable", {
      reason: "pg.Pool construction threw",
      error: safeErrorMessage(err),
    });
    return null;
  }

  // Build an LlmRouter using the same multi-provider dispatcher
  // the ingestion composition does. This router targets the same
  // `domains.llm_policy` rows the ingestion side reads, so the
  // scheduled agents pick up the same per-domain provider/model
  // selections.
  const db = drizzle(pgPool);
  const router = new LlmRouter({
    db: db as unknown as ConstructorParameters<typeof LlmRouter>[0]["db"],
    env: args.env as NodeJS.ProcessEnv,
    logger,
    pauser: new InMemoryQueuePauser(),
    provider: createMultiProviderDispatcher(args.env, logger),
  });

  const composed = await tryComposeAgentRunnersFromEnv({
    env: args.env,
    router,
    pgPool,
    logger,
    ...(args.availableTemplateSlugs !== undefined
      ? { availableTemplateSlugs: args.availableTemplateSlugs }
      : {}),
    ...(args.n8nMcpClient !== undefined ? { n8nMcpClient: args.n8nMcpClient } : {}),
  });
  if (composed === null) {
    // tryComposeAgentRunnersFromEnv already logged the reason.
    // Drain the pool we just opened so we don't leak the
    // connections.
    void pgPool.end().catch(() => undefined);
    return null;
  }

  let closed = false;
  return {
    ...composed,
    pgPool,
    // Expose the SAME router instance the runner closures
    // captured. The orchestrator threads this through
    // `engine-self-operating.start({ agentRouter })` so the
    // AgentDispatcher's dispatch context carries the production
    // router rather than the empty-object cast (round-2 fix #1
    // on PR #57).
    router,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pgPool.end().catch(() => undefined);
    },
  };
}

/** Try to compose the production AgentRunnerRegistry. Returns
 *  null and logs `mcp_http.unavailable` when:
 *
 *    - `MCP_BEARER_TOKEN` (or its `_FILE` variant) is unset, OR
 *    - `HttpMcpToolClient` construction throws.
 *
 *  Boot-tolerant: a returned `null` lets the orchestrator boot
 *  with an EMPTY agent runner registry — the management UI stays
 *  alive, the `/api/admin/scheduler` route still enumerates
 *  registered instances, but every dispatched job throws (the
 *  harness records the failure) until the env is fixed.
 *
 *  THREAT-MODEL §3.6 invariant 11: the bearer token is read but
 *  NEVER appears in any log line; failures route through
 *  `safeErrorMessage` so a cause's `.message` carrying the token
 *  stays redacted via the shared `scrubPat` pipeline.
 *
 *  Per-dispatch domain slug resolution lives in the runner
 *  closures (`agent-runners.ts`): each closure reads
 *  `ctx.instance.scopeDomainIds[0]` and looks up the
 *  corresponding `domains.slug`. No new env var is needed for the
 *  per-dispatch slug (THREAT-MODEL §2 invariant 9 — feature
 *  config lives in Postgres + UI, not env).
 *
 *  PR-O3 (phase-a appendix #7) — Surfacer activation: the
 *  function is now async. It optionally constructs a SECOND
 *  `HttpMcpToolClient` pointed at the n8n-mcp server (via
 *  `N8N_MCP_BASE_URL` + `N8N_MCP_BEARER_TOKEN`) and calls the
 *  adapter's `listAvailableTemplateSlugs` to fetch the closed
 *  list of template slugs Surfacer is allowed to propose. When
 *  either env var is unset OR the n8n-mcp call fails, the
 *  vendored `builderSkills` baseline is used so Surfacer remains
 *  registered (no longer omitted by default — round-2 fix #2 of
 *  PR-N3 still applies, but only when BOTH the n8n-mcp call AND
 *  the vendored fallback yield 0 slugs). N8N_MCP_BASE_URL +
 *  N8N_MCP_BEARER_TOKEN are infrastructure-config (NOT feature
 *  config) and follow the same `_FILE` Docker-secrets convention
 *  as MCP_BEARER_TOKEN.
 */
export async function tryComposeAgentRunnersFromEnv(
  args: ComposeAgentRunnersArgs,
): Promise<ComposedAgentRunners | null> {
  const logger = args.logger ?? new ConsoleLogger();
  const bearer = readWithFile(args.env, "MCP_BEARER_TOKEN");
  if (bearer === undefined) {
    logger.warn("mcp_http.unavailable", {
      reason:
        "MCP_BEARER_TOKEN (or MCP_BEARER_TOKEN_FILE) not set — scheduled agents will not fire; webhook→wiki path still works",
    });
    return null;
  }
  const baseUrl = readWithFile(args.env, "MCP_BASE_URL") ?? DEFAULT_MCP_BASE_URL;

  let mcp: HttpMcpToolClient;
  try {
    mcp = new HttpMcpToolClient({
      baseUrl,
      bearerToken: bearer,
      logger,
    });
  } catch (err) {
    // The constructor itself does no I/O, so this is unlikely
    // — but if a future refactor adds e.g. URL validation, we
    // want the same boot-tolerant path. Round-3-style scrubbed
    // log line.
    logger.warn("mcp_http.unavailable", {
      reason: "HttpMcpToolClient construction threw",
      base_url: baseUrl,
      error: safeErrorMessage(err),
    });
    return null;
  }

  const definitions = new AgentDefinitionRegistry();
  definitions.register(HEARTBEAT_DEFINITION);
  definitions.register(LINT_DEFINITION);
  definitions.register(SURFACER_DEFINITION);

  // PR-O3 (phase-a appendix #7) — Surfacer activation via n8n-mcp.
  //
  // 1. Resolve the SURFACER TEMPLATE CATALOG. The list is the
  //    closed set of n8n template slugs the Surfacer LLM is
  //    allowed to propose; `runSurfacer` rejects every candidate
  //    with an unknown slug, so the list MUST be non-empty for
  //    Surfacer to do useful work.
  //
  // 2. Source order:
  //    a. Caller-supplied `availableTemplateSlugs` (test path) —
  //       wins outright; useful for fixed-shape unit tests.
  //    b. n8n-mcp `search_templates` (production path) — when
  //       N8N_MCP_BASE_URL + N8N_MCP_BEARER_TOKEN are set, point
  //       a SECOND `HttpMcpToolClient` at n8n-mcp and ask for
  //       the patterns-mode catalog. Boot-tolerant: any failure
  //       (env unset, construction throw, callTool throw, empty
  //       result) falls back to (c).
  //    c. Vendored `builderSkills` baseline — the ~3-template
  //       snapshot bundled with the adapter. Always non-empty.
  //
  //    With (c) as the floor, Surfacer is REGISTERED in
  //    production by default — closing the round-2 fix #2
  //    "omitted" path for the realistic operator deployment.
  //    Surfacer is omitted only when the caller explicitly
  //    passes `availableTemplateSlugs: []` AND the n8n-mcp call
  //    yields 0 slugs (corner case for tests + the empty-vendor
  //    edge case that `builderSkills` can in theory expose).
  let availableTemplateSlugs: readonly string[];
  if (args.availableTemplateSlugs !== undefined) {
    // Caller wins (test path).
    availableTemplateSlugs = args.availableTemplateSlugs;
  } else {
    // Test seam (n8nMcpClient) wins over env-derivation. `null`
    // simulates "n8n-mcp unreachable"; an object value injects a
    // stub that satisfies McpToolCallClient. Production callers
    // leave args.n8nMcpClient undefined and the env-derived
    // HttpMcpToolClient is constructed.
    const n8nMcpClient =
      args.n8nMcpClient === undefined
        ? tryConstructN8nMcpClient(args.env, logger)
        : args.n8nMcpClient;
    const fallbackSlugs = builderSkills.map((s) => s.slug);
    availableTemplateSlugs = await listAvailableTemplateSlugs({
      mcp: n8nMcpClient,
      fallbackSlugs,
      logger,
    });
  }
  const surfacerEnabled = availableTemplateSlugs.length > 0;
  if (!surfacerEnabled) {
    logger.warn("surfacer.template_catalog_empty", {
      reason:
        "availableTemplateSlugs is empty AND vendored fallback yielded 0 slugs — Surfacer is OMITTED from the runner registry. Heartbeat + Lint still run on cron.",
    });
  }

  const runners = createProductionAgentRunners({
    db: args.pgPool,
    mcp,
    router: args.router,
    logger,
    definitions,
    availableTemplateSlugs,
    surfacerEnabled,
  });

  return { mcp, definitions, runners };
}

/** Build an n8n-mcp `HttpMcpToolClient` from env, OR return null
 *  on any boot-tolerance condition (env vars unset, construction
 *  throw). The `listAvailableTemplateSlugs` caller treats null
 *  identically to a callTool failure — falls back to the vendored
 *  baseline and Surfacer remains registered. */
function tryConstructN8nMcpClient(
  env: Record<string, string | undefined>,
  logger: Logger,
): HttpMcpToolClient | null {
  const n8nMcpBaseUrl = readWithFile(env, "N8N_MCP_BASE_URL");
  const n8nMcpBearer = readWithFile(env, "N8N_MCP_BEARER_TOKEN");
  if (n8nMcpBaseUrl === undefined || n8nMcpBearer === undefined) {
    logger.warn("n8n_mcp.unavailable", {
      reason:
        "N8N_MCP_BASE_URL or N8N_MCP_BEARER_TOKEN not set — Surfacer will use vendored fallback templates",
    });
    return null;
  }
  try {
    return new HttpMcpToolClient({
      baseUrl: n8nMcpBaseUrl,
      bearerToken: n8nMcpBearer,
      logger,
    });
  } catch (err) {
    logger.warn("n8n_mcp.unavailable", {
      reason: "HttpMcpToolClient construction threw for n8n-mcp",
      error: safeErrorMessage(err),
    });
    return null;
  }
}
