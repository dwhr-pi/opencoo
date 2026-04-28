/**
 * Logout endpoint (PR 29 / plan #131, decision Q13).
 *
 * `POST /api/admin/logout` — clears the session + CSRF cookies
 * server-side and writes a `session.logout` audit row. The UI
 * also clears the PAT from sessionStorage; this server-side
 * cookie clear is belt-and-suspenders for clients that don't
 * (e.g. an operator who closes the tab via the OS rather than
 * the UI's logout button).
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { buildAdminCookieLine } from "../cookie-attrs.js";
import { requireCsrf } from "../csrf.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegisterLogoutRouteArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerLogoutRoute(args: RegisterLogoutRouteArgs): void {
  args.app.post(
    "/api/admin/logout",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      // Set-Cookie with Max-Age=0 clears both cookies. Browsers
      // only delete when (name, Path, Domain) match the issuing
      // attributes — `buildAdminCookieLine` is the single source
      // of truth shared with csrf.ts and auth.ts so the CLEAR
      // path cannot drift from the SET path.
      reply.header("set-cookie", [
        buildAdminCookieLine({
          name: "opencoo_session",
          value: "",
          httpOnly: true,
          maxAge: 0,
        }),
        buildAdminCookieLine({
          name: "opencoo_csrf",
          value: "",
          httpOnly: false,
          maxAge: 0,
        }),
      ]);
      await writeAuditLog(args.db, {
        action: "session.logout",
        userId: ctx.userId,
        metadata: { username: ctx.username },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return reply.code(200).send({ ok: true });
    },
  );
}
