/**
 * Admin API plugin — `/api/admin/*` review-dashboard surface
 * (PR 28 / plan #128, THREAT-MODEL §3.13).
 *
 * Mount via `serverFactory` swap in `start.ts`:
 *
 *   const userServerFactory = async (probes, config, logger) => {
 *     const app = await defaultServerFactory(probes, config, logger);
 *     await registerAdminApi(app, {db, giteaClient, ...});
 *     return app;
 *   };
 *
 * Order of registration matters:
 *   1. `_csrf` issuance route — verifyAdmin only (no CSRF gate
 *      yet; this is where the operator gets the token).
 *   2. State-changing route handlers — verifyAdmin + requireCsrf.
 *   3. Read-only listing routes — verifyAdmin only.
 *   4. Debug-banner onSend hook (after all routes so it sees
 *      every JSON response).
 *
 * The plugin does NOT register a notFoundHandler — the
 * existing `static-ui.ts` setNotFoundHandler differentiates
 * `/api/*` from SPA routes (verified). Unknown `/api/admin/*`
 * paths fall through to that handler and return 404.
 */
import type { FastifyInstance } from "fastify";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { Logger } from "@opencoo/shared/logger";
import type { DeleteCap } from "@opencoo/shared/wiki-write";

import { buildVerifyAdmin, type GiteaClient } from "./auth.js";
import { issueCsrfToken } from "./csrf.js";
import { attachDebugBannerHook } from "./debug-banner.js";
import { createSseBus, type SseBus } from "./sse-bus.js";
import { registerAdaptersRoute } from "./routes/adapters.js";
import { registerAgentRunsRoutes } from "./routes/agent-runs.js";
import {
  registerAgentsDispatchRoute,
  type AgentDispatchEnqueue,
} from "./routes/agents-dispatch.js";
import { registerAuditLogReadRoutes } from "./routes/audit-log-read.js";
import { registerAutomationCandidatesRoutes } from "./routes/automation-candidates.js";
import { registerCostSummaryRoute } from "./routes/cost-summary.js";
import { registerDomainsLlmPolicyRoutes } from "./routes/domains-llm-policy.js";
import {
  registerDomainsRoutes,
  type PingWikiMcpRefreshFn,
  type ProvisionDomainRepoFn,
} from "./routes/domains.js";
import { registerEventsRoute } from "./routes/events.js";
import { registerHeartbeatRoutes } from "./routes/heartbeat.js";
import { registerLintFindingsRoutes } from "./routes/lint-findings.js";
import { registerLlmModelsRoute } from "./routes/llm-models.js";
import { registerLogoutRoute } from "./routes/logout.js";
import { registerMarketplaceUpdatesRoutes } from "./routes/marketplace-updates.js";
import {
  registerOutputChannelsRoutes,
  type OutputAdapterDescriptor,
  type OutputAdapterSlug,
} from "./routes/output-channels.js";
import { registerPipelinesRoutes } from "./routes/pipelines.js";
import { registerPromptsRoutes } from "./routes/prompts.js";
import { registerRedactionEventsRoutes } from "./routes/redaction-events.js";
import {
  registerSchedulerRoute,
  type SchedulerSource,
  type SchedulerUpdate,
} from "./routes/scheduler.js";
import {
  registerSourceBindingsRoutes,
  type ForgetJobEnqueueArgs,
} from "./routes/source-bindings.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegisterAdminApiArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly giteaClient: GiteaClient;
  readonly adminTeamSlug: string;
  readonly sessionHmacKey: Buffer;
  readonly logger: Logger;
  /** Whether `LLM_DEBUG_LOG=1` is set at boot. The onSend hook
   *  injects the `_llmDebugLogActive: true` banner into JSON
   *  responses iff this is true. */
  readonly llmDebugLog: boolean;
  /** Phase-a appendix #2 — provisioning callable for the
   *  domain-create flow. The composition root passes the real
   *  helper from `composition/gitea-provisioning.ts`; tests
   *  inject a stub. When undefined, POST /api/admin/domains
   *  returns 500 (composition-incomplete). */
  readonly provisionDomainRepo?: ProvisionDomainRepoFn;
  /** Gitea organisation under which provisioned repos are
   *  created. Sourced from `GITEA_PROVISION_ORG`. */
  readonly provisionOrg?: string;
  /** Phase-a appendix #12 PR-Z8 (G10) — fire-and-forget
   *  `/refresh-all` ping the domain-create handler dispatches so
   *  gitea-wiki-mcp-server learns about new repos. The composition
   *  root wires this when both `GITEA_WIKI_MCP_URL` and
   *  `MCP_BEARER_TOKEN` are set; otherwise the ping is skipped
   *  (domain creation still succeeds; operator can curl manually). */
  readonly pingWikiMcpRefresh?: PingWikiMcpRefreshFn;
  /** Phase-a appendix #2 — credential store for the binding
   *  create flow. Encrypts auth + webhook_secret halves before
   *  the binding row INSERT. When undefined, POST
   *  /api/admin/source-bindings returns 500. */
  readonly credentialStore?: CredentialStore;
  /** BullMQ ingestion queue — probed for DLQ depth in the GET
   *  /api/admin/source-bindings handler AND for pipeline stats in
   *  GET /api/admin/pipelines. When undefined, DLQ alerts are silenced
   *  and the ingestion pipeline entry shows zeroed stats.
   *
   *  PR-B (C2 fix): `start.ts` constructs a `buildEngineQueue("ingestion",
   *  "scanner", ...)` handle using `config.redisUrl`, passes it to
   *  `productionServerFactory` via `ProductionServerFactoryArgs.ingestionQueue`,
   *  which threads it through to `RegisterAdminApiArgs.ingestionQueue` and
   *  onwards to `registerSourceBindingsRoutes` + `registerPipelinesRoutes`.
   *
   *  PR-Z3 (phase-a appendix #12) widens the shape with optional
   *  `add` so the source-bindings route can enqueue a post-create
   *  initial scan (closes G6) and the `:id/scan-now` route can
   *  enqueue an on-demand scan (closes G8). Read paths
   *  (`getJobCounts`) work even when `add` is undefined — same
   *  boot-tolerance pattern. */
  readonly ingestionQueue?: {
    getJobCounts: (...states: string[]) => Promise<Record<string, number>>;
    add?: (
      name: string,
      data: unknown,
      opts?: unknown,
    ) => Promise<unknown>;
    name?: string;
  };
  /** Phase-a appendix #4 PR-B — SSE bus for the Activity feed.
   *  When undefined a fresh bus is created internally (production path).
   *  Tests may inject a mock bus if they need to assert on bus interactions. */
  readonly sseBus?: SseBus;
  /** @internal Test seam — override `setInterval` for heartbeat timing tests.
   *  Threaded through to `registerEventsRoute`. Returns an opaque handle. */
  readonly sseSetIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** @internal Test seam — override `clearInterval`. Receives the opaque
   *  handle returned by `sseSetIntervalFn`. */
  readonly sseClearIntervalFn?: (id: unknown) => void;
  /** Phase-a appendix #5 PR-M2 — read-only scheduler source for
   *  `GET /api/admin/scheduler`. Production passes the in-process
   *  `AgentDispatcher`; when undefined the route is registered with
   *  an empty source (operator sees `{ schedules: [] }`) so the
   *  endpoint stays reachable even if the scheduler failed to boot. */
  readonly schedulerSource?: SchedulerSource;
  /** Phase-a appendix #10 PR-R3 — on-demand agent dispatch enqueue.
   *  Production passes the dispatcher's `enqueueOneShot` method;
   *  when undefined the `POST /api/admin/agents/:slug/dispatch`
   *  route registers but every call returns 503 (composition
   *  incomplete — same boot-tolerance pattern as the rest of the
   *  admin API). */
  readonly dispatchAgentJob?: AgentDispatchEnqueue;
  /** Phase-a appendix #10 PR-R6 — scheduler / cadence editor.
   *  Production passes the dispatcher's `updateSchedule` method;
   *  when undefined the `PUT /api/admin/scheduler/:agent` route
   *  registers but every call returns 503 (composition incomplete).
   *  Same boot-tolerance pattern as `dispatchAgentJob`. */
  readonly updateSchedule?: SchedulerUpdate;
  /** Phase-a appendix #10 PR-R7 — delete-cap probe + reserve for
   *  the source-forget impact preview. Production passes the
   *  ingestion engine's `wikiDeps.deleteCap` (single-process v0.1
   *  shape: same instance the compiler workers reserve against).
   *  When undefined the forget endpoint returns 503. */
  readonly deleteCap?: DeleteCap;
  /** Phase-a appendix #10 PR-R7 — composition-supplied enqueuer
   *  for the actual forget action. The route plans the impact +
   *  reserves the cap; this callable turns the plan into BullMQ
   *  recompile + delete jobs. Tests inject a `vi.fn()`. When
   *  undefined the forget endpoint returns 503. */
  readonly forgetJobEnqueuer?: (args: ForgetJobEnqueueArgs) => Promise<void>;
  /** PR-Z4 (phase-a appendix #12 G5) — test seam for the
   *  `/api/admin/output-channels` CRUD routes. Production lets the
   *  routes lazy-import `@opencoo/output-asana` to derive the
   *  per-adapter descriptor; tests inject a stub so the admin-API
   *  fixture doesn't need the cross-package import surface. */
  readonly outputChannelRegistry?: Readonly<
    Record<OutputAdapterSlug, OutputAdapterDescriptor>
  >;
}

export async function registerAdminApi(
  args: RegisterAdminApiArgs,
): Promise<void> {
  const verifyAdmin = buildVerifyAdmin({
    db: args.db,
    giteaClient: args.giteaClient,
    adminTeamSlug: args.adminTeamSlug,
    sessionHmacKey: args.sessionHmacKey,
    logger: args.logger,
  });

  // Every route under /api/admin/* MUST authenticate.
  // We attach the preHandler at the route level (via the
  // explicit `preHandler` option on each route) so the order
  // of authn → CSRF → handler is unambiguous in the route
  // declaration.
  // Register the CSRF-issue endpoint with verifyAdmin only.
  args.app.get(
    "/api/admin/_csrf",
    { preHandler: verifyAdmin },
    async (req, reply) => {
      const issued = issueCsrfToken(reply);
      return reply.code(200).send({
        csrfToken: issued.csrfToken,
        // Reflect the resolved username — handy for the SPA's
        // top-bar without needing a separate /me call.
        username: req.adminContext?.username ?? null,
      });
    },
  );

  // Wrap every route registrar with verifyAdmin so the auth
  // gate runs uniformly. Using addHook on the app would
  // intercept /health + /ready too — we don't want that.
  // Instead, we attach verifyAdmin per route.
  const guardedApp = makeGuardedApp(args.app, verifyAdmin);

  // Phase-a appendix #4 PR-B — SSE bus. Use the caller's bus
  // (test injection) or create a fresh one for production.
  const bus: SseBus = args.sseBus ?? createSseBus();

  // Phase-a appendix #2 — adapter picker for the "+ New
  // binding" modal. Read-only; no body, no CSRF.
  registerAdaptersRoute({
    app: guardedApp,
    ...(args.outputChannelRegistry !== undefined
      ? { outputAdapterRegistry: args.outputChannelRegistry }
      : {}),
  });
  // PR-Z4 (phase-a appendix #12 G5) — Outputs tab CRUD. The
  // route registrar is async because the production path lazy-
  // imports `@opencoo/output-asana` for the per-adapter descriptor.
  await registerOutputChannelsRoutes({
    app: guardedApp,
    db: args.db,
    ...(args.credentialStore !== undefined
      ? { credentialStore: args.credentialStore }
      : {}),
    ...(args.outputChannelRegistry !== undefined
      ? { registry: args.outputChannelRegistry }
      : {}),
  });
  registerSourceBindingsRoutes({
    app: guardedApp,
    db: args.db,
    ...(args.credentialStore !== undefined
      ? { credentialStore: args.credentialStore }
      : {}),
    ...(args.ingestionQueue !== undefined
      ? { ingestionQueue: args.ingestionQueue }
      : {}),
    ...(args.deleteCap !== undefined
      ? { deleteCap: args.deleteCap }
      : {}),
    ...(args.forgetJobEnqueuer !== undefined
      ? { forgetJobEnqueuer: args.forgetJobEnqueuer }
      : {}),
  });
  registerLintFindingsRoutes({ app: guardedApp, db: args.db });
  registerAutomationCandidatesRoutes({ app: guardedApp, db: args.db });
  registerMarketplaceUpdatesRoutes({ app: guardedApp, db: args.db });
  registerAuditLogReadRoutes({ app: guardedApp, db: args.db });
  // Phase-a appendix #10 PR-R5 — cost analytics dashboard. Read-only
  // aggregation over `llm_usage`; no new write surface, no new
  // persistence table.
  registerCostSummaryRoute({ app: guardedApp, db: args.db });
  // PR 29 read-only domains list + phase-a appendix #2 create
  // handler. Pass through the provisioning callable + org name
  // so the POST handler can seed Gitea. Read-only GET works
  // even when provisioning is unwired (composition-incomplete
  // surfaces only on POST).
  registerDomainsRoutes({
    app: guardedApp,
    db: args.db,
    ...(args.provisionDomainRepo !== undefined
      ? { provisionDomainRepo: args.provisionDomainRepo }
      : {}),
    ...(args.provisionOrg !== undefined
      ? { provisionOrg: args.provisionOrg }
      : {}),
    ...(args.pingWikiMcpRefresh !== undefined
      ? { pingWikiMcpRefresh: args.pingWikiMcpRefresh }
      : {}),
  });
  registerPromptsRoutes({ app: guardedApp });
  registerDomainsLlmPolicyRoutes({
    app: guardedApp,
    db: args.db,
    sessionHmacKey: args.sessionHmacKey,
  });
  // PR-Q13 (phase-a appendix #9) — read-only model catalog
  // for the per-tier model dropdown in the LLM-policy editor.
  registerLlmModelsRoute({ app: guardedApp });
  registerLogoutRoute({ app: guardedApp, db: args.db });

  // Phase-a appendix #4 PR-B — Activity tab routes.
  registerAgentRunsRoutes({
    app: guardedApp,
    db: args.db,
    llmDebugLog: args.llmDebugLog,
  });
  registerEventsRoute({
    app: guardedApp,
    bus,
    llmDebugLog: args.llmDebugLog,
    ...(args.sseSetIntervalFn !== undefined ? { setIntervalFn: args.sseSetIntervalFn } : {}),
    ...(args.sseClearIntervalFn !== undefined ? { clearIntervalFn: args.sseClearIntervalFn } : {}),
  });
  registerPipelinesRoutes({
    app: guardedApp,
    db: args.db,
    queues: args.ingestionQueue !== undefined
      ? [{ name: args.ingestionQueue.name ?? "ingestion.scanner", ...args.ingestionQueue }]
      : [],
  });

  // Phase-a appendix #4 PR-D — Reports tab routes.
  registerHeartbeatRoutes({ app: guardedApp, db: args.db });
  registerRedactionEventsRoutes({ app: guardedApp, db: args.db });

  // Phase-a appendix #5 PR-M2 — read-only scheduler listing.
  // Falls back to an empty source when the orchestrator did not
  // wire one (e.g. dispatcher composition failed at boot — same
  // boot-tolerance pattern as the other admin routes).
  registerSchedulerRoute({
    app: guardedApp,
    db: args.db,
    source: args.schedulerSource ?? { listSchedules: () => [] },
    ...(args.updateSchedule !== undefined
      ? { updateSchedule: args.updateSchedule }
      : {}),
  });

  // Phase-a appendix #10 PR-R3 — on-demand agent dispatch.
  // The route registers regardless of whether the dispatcher
  // composed at boot; when the enqueue callable is absent the
  // route returns 503 so the operator sees a clean error surface
  // instead of a 404. Same pattern as schedulerSource above.
  registerAgentsDispatchRoute({
    app: guardedApp,
    db: args.db,
    ...(args.dispatchAgentJob !== undefined
      ? { dispatchAgentJob: args.dispatchAgentJob }
      : {}),
  });

  // Debug banner: registered LAST so it sees every JSON
  // response regardless of which route built it.
  attachDebugBannerHook(args.app, { llmDebugLog: args.llmDebugLog });
}

/**
 * Wrap a Fastify instance so every `app.get` / `app.post` /
 * `app.put` registration prepends `verifyAdmin` to the
 * preHandler chain. Routes that ALSO require CSRF declare
 * `preHandler: requireCsrf` directly; the wrapper composes
 * the two so verifyAdmin always runs first.
 *
 * This avoids the `addHook('preHandler', verifyAdmin)`
 * footgun: a top-level addHook would intercept `/health`,
 * `/ready`, the static UI, and the SPA fallback — none of
 * which should be auth-gated.
 */
function makeGuardedApp(
  app: FastifyInstance,
  verifyAdmin: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>,
): FastifyInstance {
  type RouteFn = (
    path: string,
    options: { preHandler?: unknown } | unknown,
    handler?: unknown,
  ) => unknown;

  const wrap = (orig: RouteFn): RouteFn => {
    return (path, optionsOrHandler, maybeHandler) => {
      let opts: { preHandler?: unknown };
      let handler: unknown;
      if (typeof optionsOrHandler === "function") {
        opts = {};
        handler = optionsOrHandler;
      } else {
        opts = (optionsOrHandler as { preHandler?: unknown }) ?? {};
        handler = maybeHandler;
      }
      const existing = opts.preHandler;
      const chained = existing === undefined
        ? verifyAdmin
        : Array.isArray(existing)
          ? [verifyAdmin, ...existing]
          : [verifyAdmin, existing];
      const merged = { ...opts, preHandler: chained };
      return (orig as (...a: unknown[]) => unknown).call(
        app,
        path,
        merged,
        handler,
      );
    };
  };

  // Build a thin proxy that intercepts the http verbs we use.
  // Other Fastify methods (addHook, register, etc.) pass through.
  const proxy: FastifyInstance = new Proxy(app, {
    get(target, prop, receiver) {
      if (prop === "get" || prop === "post" || prop === "put" || prop === "delete" || prop === "patch") {
        const orig = Reflect.get(target, prop, receiver) as RouteFn;
        return wrap(orig.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return proxy;
}

export type { GiteaClient, GiteaWhoamiResult, AdminContext } from "./auth.js";
export type {
  PingWikiMcpRefreshFn,
  ProvisionDomainRepoFn,
} from "./routes/domains.js";
export type { AgentDispatchEnqueue } from "./routes/agents-dispatch.js";
export type { ForgetJobEnqueueArgs } from "./routes/source-bindings.js";
export type {
  SchedulerSource,
  SchedulerUpdate,
} from "./routes/scheduler.js";
export {
  DISPATCHABLE_AGENT_SLUGS,
  type DispatchableAgentSlug,
  __resetAgentDispatchRateLimit,
} from "./routes/agents-dispatch.js";
export { AUDIT_LOG_ACTIONS, type AuditAction } from "./audit-log.js";
export {
  computePayloadHash,
  issueSovereigntyDiffToken,
  verifySovereigntyDiffToken,
  SOVEREIGNTY_TOKEN_TTL_MS,
  type SovereigntyDiffPayload,
  type VerifyResult,
  type VerifyFailureReason,
} from "./sovereignty-token.js";
export { CSRF_COOKIE, CSRF_HEADER, extractCsrfCookie } from "./csrf.js";
export { DEBUG_BANNER_FIELD } from "./debug-banner.js";
