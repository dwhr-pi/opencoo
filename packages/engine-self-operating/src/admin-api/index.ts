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

import { buildVerifyAdmin, type GiteaClient } from "./auth.js";
import { issueCsrfToken } from "./csrf.js";
import { attachDebugBannerHook } from "./debug-banner.js";
import { createSseBus, type SseBus } from "./sse-bus.js";
import { registerAdaptersRoute } from "./routes/adapters.js";
import { registerAgentRunsRoutes } from "./routes/agent-runs.js";
import { registerAuditLogReadRoutes } from "./routes/audit-log-read.js";
import { registerAutomationCandidatesRoutes } from "./routes/automation-candidates.js";
import { registerDomainsLlmPolicyRoutes } from "./routes/domains-llm-policy.js";
import {
  registerDomainsRoutes,
  type ProvisionDomainRepoFn,
} from "./routes/domains.js";
import { registerEventsRoute } from "./routes/events.js";
import { registerHeartbeatRoutes } from "./routes/heartbeat.js";
import { registerLintFindingsRoutes } from "./routes/lint-findings.js";
import { registerLogoutRoute } from "./routes/logout.js";
import { registerMarketplaceUpdatesRoutes } from "./routes/marketplace-updates.js";
import { registerPipelinesRoutes } from "./routes/pipelines.js";
import { registerPromptsRoutes } from "./routes/prompts.js";
import { registerRedactionEventsRoutes } from "./routes/redaction-events.js";
import {
  registerSchedulerRoute,
  type SchedulerSource,
} from "./routes/scheduler.js";
import { registerSourceBindingsRoutes } from "./routes/source-bindings.js";

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
   *  The queue handle is read-only — no jobs are enqueued from this side. */
  readonly ingestionQueue?: { getJobCounts: (...states: string[]) => Promise<Record<string, number>>; name?: string };
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
  registerAdaptersRoute({ app: guardedApp });
  registerSourceBindingsRoutes({
    app: guardedApp,
    db: args.db,
    ...(args.credentialStore !== undefined
      ? { credentialStore: args.credentialStore }
      : {}),
    ...(args.ingestionQueue !== undefined
      ? { ingestionQueue: args.ingestionQueue }
      : {}),
  });
  registerLintFindingsRoutes({ app: guardedApp, db: args.db });
  registerAutomationCandidatesRoutes({ app: guardedApp, db: args.db });
  registerMarketplaceUpdatesRoutes({ app: guardedApp, db: args.db });
  registerAuditLogReadRoutes({ app: guardedApp, db: args.db });
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
  });
  registerPromptsRoutes({ app: guardedApp });
  registerDomainsLlmPolicyRoutes({
    app: guardedApp,
    db: args.db,
    sessionHmacKey: args.sessionHmacKey,
  });
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
export type { ProvisionDomainRepoFn } from "./routes/domains.js";
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
