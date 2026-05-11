/**
 * `composeProductionWorkerContext` — production-shape composition
 * root for the ingestion `WorkerContext` (PR-M2, phase-a appendix #5).
 *
 * # Composition order
 *
 *   1. Caller (orchestrator / `serve.ts`) constructs the
 *      ingredients (pg.Pool → Drizzle handle, ioredis Redis, SseBus,
 *      LlmRouter, GuardAdapter, WikiAdapter, CredentialStore, plus
 *      the slug → adapter-factory map from the shared adapter-
 *      registry contract). The CALLER owns the network-touching
 *      bits because the CLI's `serve.ts` already opens the pg
 *      pool + Redis once for both engines, and the admin-API
 *      composition root has already validated the env shape — we
 *      reuse those handles rather than re-reading env here.
 *
 *   2. This factory wires those ingredients into the
 *      `WorkerContext` shape the ingestion workers consume:
 *        - `wikiDeps` ← `{ adapter, queue, deleteCap, logger,
 *           clock, instanceId }` (in-memory queue + delete-cap; the
 *           queue is single-process per the v0.1 distributable
 *           shape).
 *        - `adapterRegistry` ← lazy-resolved per-binding registry
 *           that reads `sources_bindings` + the credential vault
 *           on each `get(slug)`. Memoised after first resolution
 *           so the scanner doesn't hit pg per-document.
 *        - `enqueue` ← producer-side BullMQ Queue handle for
 *           `ingestion.scanner.classify`. Multi-dot prefix
 *           bypasses `buildEngineQueue` (which rejects dotted
 *           slugs), constructed via `new Queue(...)` directly per
 *           the same convention pipelines/scanner.ts uses.
 *
 *   3. Caller passes the returned context to
 *      `engine-ingestion.start({ mode: 'workers', workerContext,
 *      workerConnection })`. The orchestrator drains
 *      `closeProducers()` on SIGTERM AFTER the workers stop — it
 *      closes the producer-side queue handle this factory opened.
 *
 * # Why no env reads
 *
 * The CLAUDE.md / THREAT-MODEL invariant 9 forbids feature config
 * via env. The composition root reads env at the orchestrator
 * level (DATABASE_URL, REDIS_URL, GITEA_URL, ENCRYPTION_KEY) once;
 * this factory takes the already-resolved handles. New env vars
 * are NOT introduced here.
 *
 * # Boot tolerance
 *
 * If the caller passes incomplete ingredients (e.g. no
 * `sourceAdapterFactories` because the bindings table is empty),
 * the registry returns `undefined` for every `get(slug)` and the
 * scanner pipeline's `scanner.adapter_missing` log line fires —
 * graceful degradation, not a crash.
 */
import { Queue, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type {
  CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { Logger } from "@opencoo/shared/logger";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import type { GuardAdapter } from "@opencoo/shared/adapter-contract-tests/guard";
import type { SourceAdapter } from "@opencoo/shared/source-adapter";
import { HmacSha256Verifier } from "@opencoo/shared/webhook-verifier";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  type DeleteCap,
  type WikiAdapter,
  type WikiAuthor,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";

import {
  SCANNER_CLASSIFY_QUEUE_SLUG,
  type ScannerClassifyJob,
} from "../pipelines/scanner.js";

import type { IngestionRunEventEmitter, WorkerContext } from "./context.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** PR-Z3 (phase-a appendix #12) — BullMQ jobId used for the scanner
 *  cron repeat-job. Stable across engine restarts so a re-register
 *  lands on the same entry instead of stacking duplicates. Exported
 *  so tests can assert the registration is in place. */
export const SCANNER_REPEAT_KEY = "ingestion.scanner.tick" as const;

/** PR-Z3 (phase-a appendix #12) — default scanner cadence: every
 *  4h UTC. Mirrors architecture.md §9.1 (Ingestion Scanner cadence).
 *  Overridable via `OPENCOO_SCANNER_CRON` env at composition root. */
export const SCANNER_CRON_DEFAULT = "0 */4 * * *" as const;

/** Per-adapter factory — same shape as the shared
 *  `AdapterRegistry`'s `SourceAdapterFactory`, narrowed here to
 *  what the production composition needs (the slug union is
 *  open-ended at this layer; the orchestrator passes only the
 *  factories it ships). */
export type ProductionSourceAdapterFactory = (args: {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  readonly config: unknown;
}) => SourceAdapter;

export interface ComposeProductionContextArgs {
  /** Shared Drizzle handle the orchestrator opened once. */
  readonly db: Db;
  /** Shared logger. */
  readonly logger: Logger;
  /** BullMQ ConnectionOptions for the producer-side `enqueue`
   *  Queue. Same Redis the orchestrator's other Queue handles
   *  use — required for the scanner's `add()` calls to land on
   *  the same backlog the consumer-side worker reads. */
  readonly redisConnection: ConnectionOptions;
  /** Optional Redis client passed for cleanup / introspection.
   *  When present, `closeProducers()` does NOT disconnect it —
   *  the orchestrator owns its lifecycle. */
  readonly redisClient?: Redis;
  /** Credential vault — the per-binding `credentials_id` lookup
   *  goes through this. */
  readonly credentialStore: CredentialStore;
  /** Slug → factory map. The orchestrator imports each adapter
   *  package (drive / asana / n8n / fireflies / webhook) and
   *  passes a factory closure that bakes in any production-only
   *  client deps (e.g. drive's `makeDrive`). When a slug is
   *  missing here, the registry's `get()` returns `undefined`
   *  for that slug. */
  readonly sourceAdapterFactories: Readonly<
    Record<string, ProductionSourceAdapterFactory>
  >;
  /** Production WikiAdapter (typically `giteaWikiAdapter(...)`). */
  readonly wikiAdapter: WikiAdapter;
  /** Production LlmRouter. */
  readonly router: LlmRouter;
  /** Production GuardAdapter (typically `guardRedactionRegex()`). */
  readonly guardAdapter: GuardAdapter;
  /** Service-account author stamped on every machine wiki commit. */
  readonly author: WikiAuthor;
  /** Deployment instance id baked into commit trailers
   *  (`Opencoo-Instance: <instanceId>`). v0.1: a stable string
   *  per deployment, not per-instance. */
  readonly instanceId: string;
  /** Optional shared SseBus. When set, run-lifecycle events from
   *  every worker emit through here so the Activity feed shows
   *  ingestion runs alongside agent runs. */
  readonly sseBus?: IngestionRunEventEmitter;
  /** Optional clock for deterministic test commit timestamps. */
  readonly clock?: () => Date;
  /** PR-W1 (phase-a appendix #11) — caller-supplied delete-cap.
   *
   *  When the orchestrator (`cli/src/provision/production-composition.ts`)
   *  needs the SAME `InMemoryDeleteCap` instance the compiler workers
   *  reserve against to ALSO be visible to the self-op admin-API's
   *  `POST /api/admin/source-bindings/:id/forget` route, it constructs
   *  the cap once at composition root and threads it through here AND
   *  through `registerAdminApi(...).deleteCap`. Single-process v0.1
   *  shape: one cap, two readers (compiler workers + admin route).
   *
   *  When undefined, this factory constructs an internal cap (the
   *  pre-W1 behavior). Tests that don't care about the forget route's
   *  cap probe leave this undefined; production code MUST pass it
   *  (otherwise the route's `peek/reserve` and the workers'
   *  `wikiWrite.deleteCap.reserve` would address two different caps
   *  and a forget could exceed the daily budget undetected). */
  readonly deleteCap?: DeleteCap;
  /** PR-Z3 (phase-a appendix #12) — operator-overridable cron pattern
   *  for the scanner backstop. Defaults to `SCANNER_CRON_DEFAULT`
   *  (every 4h UTC; see the constant in this module for the literal)
   *  when undefined. The composition root reads `OPENCOO_SCANNER_CRON`
   *  and threads it here; per the no-feature-env-vars invariant this
   *  is INFRASTRUCTURE config (cron cadence, not feature behaviour)
   *  and follows the same Docker-secrets `_FILE` convention as the
   *  rest of the boot env. */
  readonly scannerCronPattern?: string;
  /** @internal PR-Z3 (phase-a appendix #12) test seam — override the
   *  scanner cron registration call. Production passes `undefined`;
   *  the composition uses the real `webhookScannerQueue.add(...)` with
   *  BullMQ's `repeat: { pattern, tz, immediately }` shape. Tests
   *  inject a stub that records the call without round-tripping
   *  through BullMQ's Lua-scripted repeat path (which hangs on
   *  ioredis-mock — same limitation the AgentDispatcher tests
   *  document at agent-dispatcher.ts:104). */
  readonly registerScannerCronFn?: (args: {
    readonly repeatKey: string;
    readonly pattern: string;
  }) => Promise<void>;
}

/** Same shape as the WorkerContext the engine consumes, but
 *  carries an additional `closeProducers` cleanup hook that
 *  releases the producer-side BullMQ Queue handle this factory
 *  opened. */
export interface ProductionWorkerContext extends WorkerContext {
  /** Close every producer-side resource this factory opened
   *  (today: the `ingestion.scanner.classify` Queue handle). The
   *  orchestrator awaits this AFTER the worker pool drains so
   *  in-flight scanner enqueues complete first. */
  closeProducers(): Promise<void>;
}

/**
 * Build the production WorkerContext. Returns a fully-populated
 * context with every required field non-undefined. Errors during
 * construction throw — the orchestrator's caller catches and falls
 * back to `mode: 'probes-only'` with a clear stderr line so the
 * management UI stays up.
 */
export async function composeProductionWorkerContext(
  args: ComposeProductionContextArgs,
): Promise<ProductionWorkerContext> {
  // 1. wikiDeps — single-process queue + cap (v0.1 distributable
  //    shape). The clock is overridable for deterministic tests.
  //
  //    PR-W1 (phase-a appendix #11): when the orchestrator passed
  //    `args.deleteCap`, use that instance verbatim so the self-op
  //    admin-API's forget route reads the SAME cap budget the compiler
  //    workers reserve against. Without this thread, the route would
  //    peek a fresh empty-cap and reserve against a separate budget,
  //    silently letting a forget exceed the per-domain daily limit.
  const wikiDeps: WikiWriteDeps = {
    adapter: args.wikiAdapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: args.deleteCap ?? new InMemoryDeleteCap(),
    logger: args.logger,
    clock: args.clock ?? ((): Date => new Date()),
    instanceId: args.instanceId,
  };

  // 2. SourceAdapterRegistry — lazy resolution. The scanner
  //    invokes `registry.get(slug)` per binding scan; we cache
  //    successful resolutions keyed by `slug` (one adapter
  //    instance per slug, not per binding).
  //
  //    Round-3 fix #2: v0.1 expects ONE enabled binding per slug
  //    per CLAUDE.md "Multi-project Asana bindings → never". The
  //    resolver picks the first enabled binding deterministically
  //    (ORDER BY created_at + LIMIT 1). If a deployment ever has
  //    multiple bindings sharing a slug, only the first is honored
  //    — operator-visible behavior should be to disable the
  //    redundant bindings rather than expect both to fire. v0.2
  //    revisits this if a real-customer trigger demands per-binding
  //    adapter instances (would require keying the cache by
  //    `binding_id` and changing the scanner to dispatch per
  //    binding rather than per slug).
  const adapterCache = new Map<string, SourceAdapter>();
  const adapterRegistry = {
    /** Resolve the adapter for the FIRST enabled binding with the
     *  given slug. Memoised. The scanner pipeline calls this once
     *  per binding scan; the cache avoids re-reading
     *  `sources_bindings` on the next 4h cron. */
    get(slug: string): SourceAdapter | undefined {
      const cached = adapterCache.get(slug);
      if (cached !== undefined) return cached;
      // The scanner pipeline calls registry.get() synchronously,
      // but our resolution requires async pg + credential vault
      // reads. Trigger a background resolution and return
      // undefined on first call — the next 4h cron iteration
      // benefits from the populated cache. The race is acceptable
      // for v0.1 (the scanner skips with `scanner.adapter_missing`
      // and the next cron run resolves cleanly).
      void resolveBindingAdapter(args, slug)
        .then((resolved) => {
          if (resolved !== null) {
            adapterCache.set(slug, resolved);
          } else {
            args.logger.warn("adapter_registry.lookup_empty", {
              adapter_slug: slug,
              reason:
                "no enabled binding with this slug + credentials_id resolved cleanly",
            });
          }
        })
        .catch((err: unknown) => {
          args.logger.error("adapter_registry.lookup_failed", {
            adapter_slug: slug,
            // Round-2 fix #2: scrub + cap. THREAT-MODEL §3.6.
            error: safeErrorMessage(err),
          });
        });
      return undefined;
    },
  };

  // Eagerly warm the cache for every enabled binding's slug at
  // boot — pays the round-trip once so the FIRST scanner cron
  // tick doesn't no-op.
  await warmAdapterCache(args, adapterCache);

  // 3. Producer-side enqueue handle. Multi-dot slug
  //    (`ingestion.scanner.classify`) bypasses `buildEngineQueue`
  //    by constructing `new Queue(...)` directly — same pattern
  //    pipelines/scanner.ts already documents. The Queue's `add`
  //    structurally satisfies the narrower `ScannerEnqueue` shape
  //    the scanner pipeline consumes.
  const enqueueQueue = new Queue<ScannerClassifyJob>(
    SCANNER_CLASSIFY_QUEUE_SLUG,
    { connection: args.redisConnection },
  );

  // 4. Webhook receiver producer-side handles (round-2 fix,
  //    Copilot #56): the receiver enqueues onto the Scanner queue
  //    when a delivery is accepted, and onto the intake DLQ when
  //    a delivery is rejected. Both queues use the standard
  //    `<prefix>.<slug>` convention (`ingestion.scanner` for the
  //    Scanner worker dequeue; `ingestion.intake.dlq` for operator
  //    triage of malformed deliveries).
  const webhookScannerQueue = new Queue("ingestion.scanner", {
    connection: args.redisConnection,
  });
  const webhookDlqQueue = new Queue("ingestion.intake.dlq", {
    connection: args.redisConnection,
  });

  // PR-Z3 (phase-a appendix #12) — register the SCANNER CRON on
  // the `ingestion.scanner` queue. Closes G3 (polling adapters
  // never tick automatically). One repeat-job for the entire
  // engine; the scanner ENUMERATES every enabled binding on each
  // tick (per-binding repeat jobs would explode at scale).
  //
  // The cron pattern is operator-overridable via `OPENCOO_SCANNER_CRON`
  // — same `_FILE` Docker-secret convention as every other env in
  // this composition. Defaults to every-4h UTC per architecture §9.1
  // (Ingestion Scanner cadence).
  //
  // Pinned to `tz: 'UTC'` to match the AgentDispatcher's repeat
  // pattern (agent-dispatcher.ts:539) — without this, BullMQ resolves
  // the cron against the host's local timezone and schedules drift on
  // non-UTC dev hosts. `immediately: false` prevents a boot-time
  // burst (the scanner runs on the cron, not on engine start).
  //
  // `jobId: SCANNER_REPEAT_KEY` makes the repeat-job dedupe stable
  // across engine restarts: BullMQ keys the repeatable by
  // (queue, name, pattern, tz, jobId), so a re-registration on
  // restart lands on the same entry instead of stacking duplicates.
  const scannerCronPattern = args.scannerCronPattern ?? SCANNER_CRON_DEFAULT;
  try {
    if (args.registerScannerCronFn !== undefined) {
      // Test path — stub records the call without hitting BullMQ's
      // Lua-scripted repeat path (which hangs on ioredis-mock).
      await args.registerScannerCronFn({
        repeatKey: SCANNER_REPEAT_KEY,
        pattern: scannerCronPattern,
      });
    } else {
      await webhookScannerQueue.add(
        SCANNER_REPEAT_KEY,
        {},
        {
          jobId: SCANNER_REPEAT_KEY,
          repeat: {
            pattern: scannerCronPattern,
            tz: "UTC",
            immediately: false,
          },
          removeOnComplete: 100,
          removeOnFail: 1000,
        },
      );
    }
  } catch (err) {
    // Best-effort: a failed cron registration must not crash boot.
    // The webhook fast-path and on-demand "Scan now" (PR-Z3 part 3)
    // still work; only the periodic backstop is missing. Operator
    // sees this in logs + can verify the absence of the repeatable
    // entry via redis-cli `KEYS bull:ingestion.scanner:repeat*`.
    args.logger.warn("scanner.cron_register_failed", {
      pattern: scannerCronPattern,
      error: safeErrorMessage(err),
    });
  }

  // The webhook verifier itself is stateless — same instance can
  // serve every binding. v0.1 ships `HmacSha256Verifier` only;
  // per-adapter verifiers ride along on the SourceAdapter via its
  // `webhook.verifier` field once PR-G+ adapters use that path.
  const webhookVerifier = new HmacSha256Verifier();

  // 5. Cleanup hook the orchestrator awaits AFTER worker drain.
  //    Drains every producer-side BullMQ queue handle this
  //    factory opened (the scanner-classify enqueue + the two
  //    webhook-receiver queues). Best-effort: a buggy close on
  //    one queue must not prevent the others from draining.
  let closing: Promise<void> | undefined;
  const closeProducers = async (): Promise<void> => {
    if (closing !== undefined) return closing;
    const closeOne = (q: Queue, label: string): Promise<void> =>
      q.close().catch((err: unknown) => {
        args.logger.warn("production_context.queue_close_failed", {
          queue: label,
          // Round-2 fix #2: scrub + cap. THREAT-MODEL §3.6.
          error: safeErrorMessage(err),
        });
      });
    closing = Promise.all([
      closeOne(enqueueQueue, SCANNER_CLASSIFY_QUEUE_SLUG),
      closeOne(webhookScannerQueue, "ingestion.scanner"),
      closeOne(webhookDlqQueue, "ingestion.intake.dlq"),
    ]).then(() => undefined);
    return closing;
  };

  return {
    db: args.db,
    logger: args.logger,
    router: args.router,
    wikiDeps,
    wikiAdapter: args.wikiAdapter,
    author: args.author,
    guardAdapter: args.guardAdapter,
    adapterRegistry,
    enqueue: enqueueQueue,
    credentialStore: args.credentialStore,
    webhookVerifier,
    webhookScannerQueue,
    webhookDlqQueue,
    ...(args.sseBus !== undefined ? { sseBus: args.sseBus } : {}),
    closeProducers,
  };
}

interface BindingRow {
  readonly id: string;
  readonly adapter_slug: string;
  readonly config: unknown;
  readonly credentials_id: string | null;
}

/** Resolve the adapter for the FIRST enabled binding with the
 *  given slug + non-null credentials_id. Returns `null` when no
 *  matching binding exists or the credential lookup fails. */
async function resolveBindingAdapter(
  args: ComposeProductionContextArgs,
  slug: string,
): Promise<SourceAdapter | null> {
  const factory = args.sourceAdapterFactories[slug];
  if (factory === undefined) {
    args.logger.warn("adapter_registry.factory_missing", {
      adapter_slug: slug,
    });
    return null;
  }
  const result = (await args.db.execute(sql`
    SELECT id::text             AS id,
           adapter_slug          AS adapter_slug,
           config                AS config,
           credentials_id::text  AS credentials_id
    FROM sources_bindings
    WHERE adapter_slug = ${slug}
      AND enabled = true
      AND credentials_id IS NOT NULL
    ORDER BY created_at
    LIMIT 1
  `)) as unknown as { rows: BindingRow[] };
  const row = result.rows[0];
  if (row === undefined) return null;
  // Verify the credential is decryptable BEFORE handing the
  // factory the id — the factory itself reads via the store at
  // call time but a missing or corrupted credential would surface
  // there as a confusing "fetch failed" error. Eager check here
  // converts to a clear log line + null result.
  try {
    await args.credentialStore.read(row.credentials_id as CredentialId);
  } catch (err) {
    args.logger.error("adapter_registry.credential_unreadable", {
      adapter_slug: slug,
      binding_id: row.id,
      // Round-2 fix #2: scrub + cap. THREAT-MODEL §3.6 invariant 11.
      error: safeErrorMessage(err),
    });
    return null;
  }
  try {
    return factory({
      credentialStore: args.credentialStore,
      credentialId: row.credentials_id as CredentialId,
      config: row.config,
    });
  } catch (err) {
    args.logger.error("adapter_registry.factory_threw", {
      adapter_slug: slug,
      binding_id: row.id,
      // Round-2 fix #2: scrub + cap. THREAT-MODEL §3.6 invariant 11.
      error: safeErrorMessage(err),
    });
    return null;
  }
}

/** Eagerly resolve every enabled binding's adapter so the
 *  FIRST scan tick doesn't return undefined and skip its
 *  documents. */
async function warmAdapterCache(
  args: ComposeProductionContextArgs,
  cache: Map<string, SourceAdapter>,
): Promise<void> {
  const result = (await args.db.execute(sql`
    SELECT DISTINCT adapter_slug
    FROM sources_bindings
    WHERE enabled = true
      AND credentials_id IS NOT NULL
  `)) as unknown as { rows: Array<{ adapter_slug: string }> };
  for (const row of result.rows) {
    const adapter = await resolveBindingAdapter(args, row.adapter_slug);
    if (adapter !== null) {
      cache.set(row.adapter_slug, adapter);
    }
  }
}
