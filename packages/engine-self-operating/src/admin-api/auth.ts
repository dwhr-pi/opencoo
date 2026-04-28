/**
 * Admin-API authentication (PR 28 / plan #128, THREAT-MODEL §3.13).
 *
 * Auth flow:
 *   1. Client sends `Authorization: Bearer <gitea-PAT>`.
 *   2. `verifyAdmin` preHandler hashes the PAT and looks up an
 *      in-memory cache (60-second TTL).
 *   3. On miss, calls `giteaClient.whoami(pat)` which returns
 *      `{username, teams: string[]}`.
 *   4. Upserts the user into the `users` table (`gitea_username`
 *      is the natural key); records `gitea_teams` +
 *      `gitea_teams_refreshed_at`.
 *   5. Caches the resolved `{userId, username, teams}` for the
 *      next 60s — same PAT, same response, no extra Gitea round-
 *      trip.
 *   6. Authorization: `teams.includes(ADMIN_TEAM_SLUG)` — if
 *      false, 403. UI filtering is NOT authorization
 *      (THREAT-MODEL §3.13); the server reconciles every
 *      request.
 *   7. On first success, sets a `Set-Cookie: opencoo_session=…`
 *      header (SameSite=Strict, HttpOnly, Secure).
 *   8. Adds `request.adminContext = {userId, username, teams}`
 *      so downstream handlers + the audit-log writer can
 *      consume the resolved identity without re-running auth.
 *
 * NOTE: this module owns READS from the in-memory PAT cache;
 * the cache is populated on whoami success and entries expire
 * after 60s. A test seam (`__resetAdminAuthCache`) clears it
 * between tests so order-dependent assertions stay
 * deterministic.
 */
import { createHash } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Logger } from "@opencoo/shared/logger";

import { buildAdminCookieLine } from "./cookie-attrs.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Per-PAT cache TTL — 60 seconds (planner Q11). */
const PAT_CACHE_TTL_MS = 60_000;

/** Minimal Gitea-API surface this module consumes. Production
 *  wiring (PR 30 composition root) wraps a real fetch-based
 *  Gitea client; tests inject a mock. */
export interface GiteaWhoamiResult {
  readonly username: string;
  readonly teams: readonly string[];
}

export interface GiteaClient {
  /** Resolve `(username, teams[])` from a personal access token.
   *  The teams list is the slugs of every team the user belongs
   *  to across the orgs the PAT can see — opencoo's admin authz
   *  matches one of those slugs against `ADMIN_TEAM_SLUG`. */
  whoami(pat: string): Promise<GiteaWhoamiResult>;
}

/** Resolved admin identity attached to `request.adminContext`
 *  by the preHandler. */
export interface AdminContext {
  readonly userId: string;
  readonly username: string;
  readonly teams: readonly string[];
}

interface CacheEntry {
  readonly context: AdminContext;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** @internal TEST ONLY — flush the PAT cache between tests so
 *  entries from a prior test don't leak into the next. */
export function __resetAdminAuthCache(): void {
  cache.clear();
}

function hashPat(pat: string): string {
  return createHash("sha256").update(pat).digest("hex");
}

/** Pull the raw token from `Authorization: Bearer <token>`. Used
 *  by `verifyAdmin` here AND by `extractOperatorPat` in `pat.ts`
 *  — keeping the regex in one place avoids drift between the two
 *  call sites that need to read the same header. */
export function extractBearer(headerValue: string | undefined): string | undefined {
  if (typeof headerValue !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(headerValue);
  return match?.[1];
}

interface UpsertedUser {
  readonly userId: string;
}

async function upsertUserAndTeams(
  db: Db,
  username: string,
  teams: readonly string[],
): Promise<UpsertedUser> {
  // ON CONFLICT (gitea_username) DO UPDATE — the natural key
  // means re-resolving the same PAT (or a fresh PAT for the same
  // operator) refreshes the cached teams + bumps
  // gitea_teams_refreshed_at without churning the user id.
  const teamsJson = JSON.stringify(teams);
  const result = (await db.execute(sql`
    INSERT INTO users (gitea_username, role, gitea_teams, gitea_teams_refreshed_at)
    VALUES (${username}, 'operator', ${teamsJson}::jsonb, NOW())
    ON CONFLICT (gitea_username) DO UPDATE
       SET gitea_teams = EXCLUDED.gitea_teams,
           gitea_teams_refreshed_at = NOW()
    RETURNING id::text AS id
  `)) as unknown as { rows: Array<{ id: string }> };
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("admin-auth: upsertUserAndTeams returned no row");
  }
  return { userId: row.id };
}

export interface VerifyAdminDeps {
  readonly db: Db;
  readonly giteaClient: GiteaClient;
  readonly adminTeamSlug: string;
  readonly sessionHmacKey: Buffer;
  readonly logger: Logger;
  /** @internal Test seam — defaults to `Date.now()`. */
  readonly now?: () => number;
}

declare module "fastify" {
  interface FastifyRequest {
    adminContext?: AdminContext;
  }
}

/**
 * Build the `verifyAdmin` Fastify preHandler. Stamp the resolved
 * identity onto `request.adminContext` for downstream handlers
 * + the audit-log writer.
 *
 * Negative paths (all return early; downstream handlers don't
 * fire):
 *   - missing Authorization header → 401
 *   - whoami throws → 401 (don't leak provider error to client)
 *   - team check fails → 403
 */
export function buildVerifyAdmin(
  deps: VerifyAdminDeps,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const now = deps.now ?? ((): number => Date.now());
  return async (req, reply) => {
    const authHeader = req.headers["authorization"];
    const rawHeader = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (rawHeader === undefined) {
      reply.code(401).send({
        error: "unauthorized",
        reason: "missing_authorization_header",
      });
      return;
    }
    const pat = extractBearer(rawHeader);
    if (pat === undefined || pat.length === 0) {
      // Header present but not in `Bearer <token>` shape — distinguish
      // from missing so client diagnostics are accurate without
      // leaking sensitive details about the malformed value.
      reply.code(401).send({
        error: "unauthorized",
        reason: "malformed_authorization_header",
      });
      return;
    }
    const patHash = hashPat(pat);
    const tNow = now();

    let context: AdminContext | undefined;
    const cached = cache.get(patHash);
    if (cached !== undefined && cached.expiresAt > tNow) {
      context = cached.context;
    } else {
      // Cache miss / expired — call Gitea + upsert.
      let whoami: GiteaWhoamiResult;
      try {
        whoami = await deps.giteaClient.whoami(pat);
      } catch (err) {
        deps.logger.warn("admin_auth.whoami_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        reply.code(401).send({
          error: "unauthorized",
          reason: "whoami_failed",
        });
        return;
      }
      const { userId } = await upsertUserAndTeams(
        deps.db,
        whoami.username,
        whoami.teams,
      );
      context = {
        userId,
        username: whoami.username,
        teams: whoami.teams,
      };
      cache.set(patHash, {
        context,
        expiresAt: tNow + PAT_CACHE_TTL_MS,
      });
    }

    // Authorization (server-side) — UI filtering is not authz.
    if (!context.teams.includes(deps.adminTeamSlug)) {
      deps.logger.warn("admin_auth.forbidden", {
        username: context.username,
        admin_team_slug: deps.adminTeamSlug,
      });
      reply.code(403).send({
        error: "forbidden",
        reason: "missing_admin_team_membership",
      });
      return;
    }

    req.adminContext = context;

    // Set the session cookie. The session id is the resolved
    // userId — a stateless cookie equal to the user's row id is
    // adequate for v0.1 because every request is re-auth'd via
    // PAT anyway. This cookie is NOT a session bearer; it
    // carries continuity across same-tab navigation and lets
    // the SPA remember "who am I" without repeating whoami.
    // HttpOnly blocks JS reads; SameSite=Strict + Path=/ +
    // conditional Secure are enforced by `buildAdminCookieLine`.
    reply.header(
      "set-cookie",
      buildAdminCookieLine({
        name: "opencoo_session",
        value: context.userId,
        httpOnly: true,
      }),
    );

    // The session HMAC key is here so a future refactor can
    // rotate to a signed session value without changing the
    // call sites; v0.1 does not consume it inside the
    // preHandler.
    void deps.sessionHmacKey;
  };
}

/** Type-narrow request → require adminContext after the
 *  preHandler ran. Throws if invoked on an unauth'd request. */
export function requireAdminContext(req: FastifyRequest): AdminContext {
  const ctx = req.adminContext;
  if (ctx === undefined) {
    throw new Error(
      "admin-api: requireAdminContext called without prior verifyAdmin",
    );
  }
  return ctx;
}
