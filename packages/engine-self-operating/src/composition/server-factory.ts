/**
 * Production serverFactory — wires admin-API + static-UI in
 * the right order (PR 30 / plan #135).
 *
 * Order matters: `registerAdminApi` MUST run BEFORE
 * `registerStaticUi`. The static-ui middleware installs a
 * `setNotFoundHandler` that catches unknown paths AND maps
 * extension-less non-`/api/` paths to `index.html` (the SPA
 * fallback). If admin-api routes registered AFTER the static
 * UI, the static handler would be set first and Fastify would
 * route `/api/admin/*` requests through it before our admin
 * routes had a chance to match.
 *
 * The ordering invariant is verified BEHAVIOURALLY by the test
 * in `tests/composition/server-factory.test.ts`: an unknown POST
 * route resolves to the static-UI's `setNotFoundHandler` (status:
 * "not_found") AND `/api/admin/_csrf` returns 401 (admin-API
 * reachable). If admin-API was registered AFTER static-UI, the
 * static handler would intercept `/api/admin/*` requests and the
 * 401 wouldn't fire. (Spy-on-imports would be more direct but
 * requires module-level mocking; the behavioural assertion
 * already pins the load-bearing invariant.)
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import {
  buildServer,
  type ProbeMap,
  type StartServer,
} from "@opencoo/shared/engine-scaffold";
import type { Logger } from "@opencoo/shared/logger";
import type { DeleteCap } from "@opencoo/shared/wiki-write";

import { registerAdminApi } from "../admin-api/index.js";
import type { GiteaClient } from "../admin-api/auth.js";
import type { ForgetJobEnqueueArgs } from "../admin-api/routes/source-bindings.js";
import { createSseBus, type SseBus } from "../admin-api/sse-bus.js";
import type {
  SchedulerSource,
  SchedulerUpdate,
} from "../admin-api/routes/scheduler.js";
import type { EngineConfig } from "../config.js";
import { registerStaticUi } from "../static-ui.js";

import type { AdminApiCompositionEnv } from "./env.js";
import { provisionDomainRepo } from "./gitea-provisioning.js";

export interface ProductionServerFactoryArgs {
  readonly probes: ProbeMap;
  readonly config: EngineConfig;
  readonly logger: Logger;
  /** pg pool the boot scaffold opened — re-used by the admin-API
   *  routes. We wrap it in a Drizzle handle here. */
  readonly pgPool: Pool;
  readonly giteaClient: GiteaClient;
  readonly compositionEnv: AdminApiCompositionEnv;
  /** Phase-a appendix #2 — credential store for the binding-
   *  create flow. Production composition wires the
   *  DrizzleCredentialStore here. When undefined (e.g.
   *  ENCRYPTION_KEY missing at boot), POST
   *  /api/admin/source-bindings returns 500 (composition-
   *  incomplete). */
  readonly credentialStore?: CredentialStore;
  /** Phase-a appendix #4 PR-B — optional BullMQ queue handle for the
   *  ingestion-scanner queue. When provided, GET /api/admin/pipelines
   *  returns live depth + failed counts instead of zeroed stats.
   *  Read-only — no jobs are added from this side. */
  readonly ingestionQueue?: { getJobCounts: (...states: string[]) => Promise<Record<string, number>>; name?: string };
  /** Phase-a appendix #4 PR-B — SSE bus for the Activity feed.
   *  When undefined, `productionServerFactory` creates a fresh bus.
   *  Exposed on the returned object so `start.ts` can thread it to
   *  harness invocations. @internal test seam. */
  readonly sseBus?: SseBus;
  /** Phase-a appendix #5 PR-M2 — scheduler source for
   *  `GET /api/admin/scheduler`. The orchestrator passes the
   *  in-process `AgentDispatcher`; when undefined the route still
   *  registers but returns an empty list (boot-tolerance: scheduler
   *  may have failed to compose, but the operator should still be
   *  able to inspect what's wired). */
  readonly schedulerSource?: SchedulerSource;
  /** Phase-a appendix #10 PR-R3 — on-demand agent dispatch
   *  enqueue. Production passes the dispatcher's `enqueueOneShot`
   *  bound method; when undefined the route registers but returns
   *  503 (composition incomplete). */
  readonly dispatchAgentJob?: import("../admin-api/routes/agents-dispatch.js").AgentDispatchEnqueue;
  /** Phase-a appendix #10 PR-R6 — cadence-editor update callable.
   *  Production passes the dispatcher's `updateSchedule` bound
   *  method; when undefined the `PUT /api/admin/scheduler/:agent`
   *  route returns 503 (composition incomplete). */
  readonly updateSchedule?: SchedulerUpdate;
  /** PR-W1 (phase-a appendix #11) — delete-cap probe + reserve for
   *  the source-forget impact preview (PR-R7). Production passes the
   *  ingestion engine's `wikiDeps.deleteCap` instance so the route
   *  reads the SAME budget the compiler workers reserve against.
   *  When undefined the forget endpoint returns 503. */
  readonly deleteCap?: DeleteCap;
  /** PR-W1 (phase-a appendix #11) — composition-supplied enqueuer
   *  for the actual forget action (PR-R7). When undefined the
   *  forget endpoint returns 503. */
  readonly forgetJobEnqueuer?: (args: ForgetJobEnqueueArgs) => Promise<void>;
  /** PR-Q6 (phase-a appendix #9) fix-up — Fastify request body
   *  limit. The orchestrator sets this to `WEBHOOK_BODY_LIMIT_BYTES`
   *  (5 MB) when co-booting engine-ingestion in workers mode so a
   *  4-MB webhook delivery doesn't hit Fastify's default 1-MB cap
   *  before the receiver's own size guard runs. */
  readonly bodyLimit?: number;
}

/** Extended return type that exposes the SSE bus so `start.ts` can
 *  thread it into harness invocations. Uses `& { sseBus: SseBus }` rather
 *  than an `extends` interface because `FastifyInstance.close` and
 *  `StartServer.close` have incompatible signatures and TypeScript 5.x
 *  rejects the interface merge (TS2320). The intersection type avoids the
 *  conflict while keeping the structural contract. */
export type ProductionServer = (FastifyInstance & StartServer) & {
  readonly sseBus: SseBus;
};

export async function productionServerFactory(
  args: ProductionServerFactoryArgs,
): Promise<ProductionServer> {
  const app: FastifyInstance = buildServer({
    probes: args.probes,
    ...(args.bodyLimit !== undefined ? { bodyLimit: args.bodyLimit } : {}),
  });

  // Wrap the existing pg pool in a Drizzle handle so the
  // admin-API + audit-log writers consume the same connection
  // pool that the engine harness opened. Reusing the pool
  // matters: a second pool would run a second auth handshake
  // per-process and bloat connection counts.
  const db = drizzle(args.pgPool);

  // Phase-a appendix #4 PR-B — create the SSE bus that bridges the
  // agent-harness lifecycle events to the browser Activity feed.
  // Use caller-supplied bus (test seam) or create a fresh one.
  const sseBus: SseBus = args.sseBus ?? createSseBus();

  // 1. Admin-API FIRST — registers `/api/admin/*` routes BEFORE
  //    the static-ui setNotFoundHandler captures unknown paths.
  await registerAdminApi({
    app,
    db: db as unknown as Parameters<typeof registerAdminApi>[0]["db"],
    giteaClient: args.giteaClient,
    adminTeamSlug: args.compositionEnv.adminTeamSlug,
    sessionHmacKey: args.compositionEnv.sessionHmacKey,
    logger: args.logger,
    llmDebugLog: args.compositionEnv.llmDebugLog,
    sseBus,
    ...(args.credentialStore !== undefined
      ? { credentialStore: args.credentialStore }
      : {}),
    ...(args.ingestionQueue !== undefined
      ? { ingestionQueue: args.ingestionQueue }
      : {}),
    ...(args.schedulerSource !== undefined
      ? { schedulerSource: args.schedulerSource }
      : {}),
    ...(args.dispatchAgentJob !== undefined
      ? { dispatchAgentJob: args.dispatchAgentJob }
      : {}),
    ...(args.updateSchedule !== undefined
      ? { updateSchedule: args.updateSchedule }
      : {}),
    ...(args.deleteCap !== undefined ? { deleteCap: args.deleteCap } : {}),
    ...(args.forgetJobEnqueuer !== undefined
      ? { forgetJobEnqueuer: args.forgetJobEnqueuer }
      : {}),
    provisionOrg: args.compositionEnv.giteaProvisionOrg,
    provisionDomainRepo: async (a) => {
      // The composition root holds the Gitea base URL; the
      // route hands the operator's PAT verbatim.
      return provisionDomainRepo({
        baseUrl: args.compositionEnv.giteaBaseUrl,
        pat: a.pat,
        org: a.org,
        slug: a.slug,
        domainClass: a.domainClass,
        defaultLocale: a.defaultLocale,
      });
    },
  });

  // 2. Static-UI LAST — its setNotFoundHandler catches unknown
  //    paths + serves index.html for extension-less non-`/api/`
  //    paths. The handler differentiates `/api/*` from SPA
  //    routes (verified in `static-ui.ts:230-240`), so unknown
  //    `/api/admin/*` paths still 404 cleanly.
  await registerStaticUi(app, {
    ...(args.config.uiDistPath !== undefined
      ? { uiDistPath: args.config.uiDistPath }
      : {}),
    logger: args.logger,
  });

  // Attach the bus to the returned object so start.ts can thread
  // it into harness invocations via AgentInvocation.sseBus.
  return Object.assign(app, { sseBus }) as unknown as ProductionServer;
}
