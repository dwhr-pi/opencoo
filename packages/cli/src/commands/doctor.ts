/**
 * `opencoo doctor` (PR 30 / plan #135 decisions Q6, Q7, Q12).
 *
 * Diagnostics dump: every check the operator needs to triage a
 * "is this deployment healthy?" question. Layered checks:
 *
 *   1. Required env vars present (DATABASE_URL, ENCRYPTION_KEY,
 *      etc.). Uses `inspectSecret` so VALUES NEVER PRINT.
 *   2. Internet-facing surfaces enumerated (THREAT-MODEL §3.15):
 *      bound port, admin-API path, webhook receiver path. The
 *      operator confirms reverse-proxy posture against this
 *      list.
 *   3. Database reachable (`SELECT 1`).
 *   4. Schema migrations applied (count of rows in
 *      `drizzle.__drizzle_migrations`).
 *   5. (Optional) Gitea team-check: when `--admin-pat <pat>` or
 *      `OPENCOO_ADMIN_PAT` is set, calls Gitea's `/user/teams`
 *      and reports membership in `ADMIN_TEAM_SLUG`. Skipped
 *      with a warn when no PAT is provided.
 *
 * Exit code (decision Q6):
 *   - errors → exit 1
 *   - warnings only → exit 0 + stderr warn lines
 *
 * Output mode:
 *   - default: human-readable lines (picocolors)
 *   - --json: structured `DoctorReport` JSON for CI pipelines
 */
import pc from "picocolors";
import type { Pool } from "pg";

import {
  formatSecret,
  inspectSecret,
  type RedactedSecret,
} from "../lib/credential-redact.js";
import { exitOk, exitUserError } from "../lib/exit.js";
import { openPool } from "../lib/db.js";

export type DoctorCheckLevel = "ok" | "warn" | "error";

export interface DoctorCheck {
  readonly id: string;
  readonly level: DoctorCheckLevel;
  readonly message: string;
  /** Optional structured detail — included in --json output. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** One enumerated webhook intake surface from `sources_bindings`. */
export interface WebhookSurface {
  /** The HTTP path that receives inbound webhooks, e.g. `/webhooks/asana`
   *  or `/webhooks/<binding_id>` for the generic adapter. */
  readonly path: string;
  readonly bindingId: string;
  readonly adapterSlug: string;
  readonly domainSlug: string;
  readonly enabled: boolean;
  /** Human-readable label for the path segment (generic `webhook` adapter
   *  only). `undefined` for named adapters (asana/fireflies/gitea). */
  readonly pathSegmentLabel?: string;
}

export interface DoctorReport {
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly internetFacing: ReadonlyArray<string>;
  readonly secrets: ReadonlyArray<RedactedSecret>;
  /** Webhook intake surfaces resolved from `sources_bindings`. Added by
   *  PR-L to close THREAT-MODEL §7 "Generic webhook intake paths not
   *  enumerated in `opencoo doctor`". */
  readonly webhookSurfaces: ReadonlyArray<WebhookSurface>;
}

const REQUIRED_SECRETS = [
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "REDIS_URL",
  "GITEA_URL",
  "ADMIN_TEAM_SLUG",
  "SESSION_HMAC_KEY",
  "GITEA_BASE_URL",
] as const;

export interface DoctorArgs {
  readonly env: Record<string, string | undefined>;
  readonly json: boolean;
  /** Optional PAT for the team-check (decision Q12). When
   *  unset, the team-check skips with a warn. */
  readonly adminPat?: string;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to `openPool`. */
  readonly poolFactory?: (env: Record<string, string | undefined>) => Pool;
  /** @internal Test seam — substitute the Gitea team-check.
   *  Defaults to a real fetch-based call. */
  readonly giteaTeamsFn?: (args: {
    readonly baseUrl: string;
    readonly pat: string;
  }) => Promise<ReadonlyArray<string>>;
}

const INTERNET_FACING_PATHS: ReadonlyArray<string> = [
  "/health",
  "/ready",
  "/api/admin/_csrf",
  "/api/admin/adapters",
  "/api/admin/source-bindings",
  "/api/admin/automation-candidates",
  "/api/admin/marketplace-updates",
  "/api/admin/audit-log",
  "/api/admin/domains",
  "/api/admin/lint-findings",
  "/api/admin/prompts",
  "/api/admin/logout",
  "/api/admin/domains/:id/llm-policy/preview",
  "/api/admin/domains/:id/llm-policy/apply",
  "/webhooks/asana",
  "/webhooks/fireflies",
  "/webhooks/gitea",
];

async function checkDb(args: DoctorArgs): Promise<DoctorCheck> {
  let pool: Pool | null = null;
  try {
    const factory = args.poolFactory ?? ((e): Pool => openPool({ env: e }));
    pool = factory(args.env);
    const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    if (result.rows[0]?.ok === 1) {
      return {
        id: "database",
        level: "ok",
        message: "database: SELECT 1 succeeded",
      };
    }
    return {
      id: "database",
      level: "error",
      message: "database: SELECT 1 returned no rows",
    };
  } catch (err) {
    return {
      id: "database",
      level: "error",
      message: `database: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (pool !== null) {
      await pool.end().catch(() => undefined);
    }
  }
}

async function checkMigrations(args: DoctorArgs): Promise<DoctorCheck> {
  let pool: Pool | null = null;
  try {
    const factory = args.poolFactory ?? ((e): Pool => openPool({ env: e }));
    pool = factory(args.env);
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    const count = Number.parseInt(result.rows[0]?.count ?? "0", 10);
    if (count === 0) {
      return {
        id: "migrations",
        level: "error",
        message:
          "migrations: drizzle.__drizzle_migrations is empty; run `opencoo migrate`",
        detail: { count },
      };
    }
    return {
      id: "migrations",
      level: "ok",
      message: `migrations: ${count} applied`,
      detail: { count },
    };
  } catch (err) {
    return {
      id: "migrations",
      level: "error",
      message: `migrations: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (pool !== null) {
      await pool.end().catch(() => undefined);
    }
  }
}

/** Replace the PAT with `<REDACTED>` in any error message string.
 *  Defense-in-depth: `fetch` implementations / proxies may include
 *  request headers in error text on certain failure paths; without
 *  this scrub a propagated `err.message` could leak the PAT.
 *  Mirrors the engine's GiteaClient `stripPat` pattern. */
function stripPat(message: string, pat: string): string {
  if (pat.length === 0) return message;
  return message.split(pat).join("<REDACTED>");
}

async function checkGiteaTeam(args: DoctorArgs): Promise<DoctorCheck> {
  // Read PAT honoring the `_FILE` Docker-secrets convention used
  // by every other secret in opencoo (matches the allow-list
  // already pinned in `no-feature-env-vars`). `--admin-pat` flag
  // wins; then OPENCOO_ADMIN_PAT_FILE; then OPENCOO_ADMIN_PAT.
  let pat: string | undefined = args.adminPat;
  if ((pat === undefined || pat.length === 0)) {
    const patFile = args.env["OPENCOO_ADMIN_PAT_FILE"];
    if (typeof patFile === "string" && patFile.length > 0) {
      try {
        const fs = await import("node:fs/promises");
        pat = (await fs.readFile(patFile, "utf8")).trim();
      } catch (err) {
        return {
          id: "gitea_team",
          level: "error",
          message: `gitea_team: cannot read OPENCOO_ADMIN_PAT_FILE: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }
  if (pat === undefined || pat.length === 0) {
    pat = args.env["OPENCOO_ADMIN_PAT"];
  }
  if (typeof pat !== "string" || pat.length === 0) {
    return {
      id: "gitea_team",
      level: "warn",
      message:
        "gitea_team: skipped (no --admin-pat or OPENCOO_ADMIN_PAT); cannot verify ADMIN_TEAM_SLUG membership",
    };
  }
  const teamSlug = args.env["ADMIN_TEAM_SLUG"];
  const baseUrl = args.env["GITEA_BASE_URL"];
  if (typeof teamSlug !== "string" || teamSlug.length === 0) {
    return {
      id: "gitea_team",
      level: "error",
      message: "gitea_team: ADMIN_TEAM_SLUG is unset; cannot check membership",
    };
  }
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    return {
      id: "gitea_team",
      level: "error",
      message: "gitea_team: GITEA_BASE_URL is unset; cannot reach Gitea",
    };
  }
  try {
    const teamsFn =
      args.giteaTeamsFn ??
      (async (a): Promise<ReadonlyArray<string>> => {
        // Minimal fetch — the real team-check uses the
        // production GiteaClient in engine-self-operating, but
        // the CLI keeps a focused fetch here so doctor doesn't
        // pull the whole engine package.
        const res = await fetch(`${a.baseUrl.replace(/\/+$/, "")}/api/v1/user/teams?limit=50`, {
          headers: { authorization: `token ${a.pat}`, accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`gitea returned ${res.status}`);
        }
        const json = (await res.json()) as ReadonlyArray<{
          name?: unknown;
          organization?: { username?: unknown };
        }>;
        const out: string[] = [];
        for (const t of json) {
          const name = typeof t.name === "string" ? t.name : "";
          const org =
            typeof t.organization?.username === "string"
              ? t.organization.username
              : "";
          if (name.length === 0) continue;
          out.push(name);
          if (org.length > 0) out.push(`${org}/${name}`);
        }
        return out;
      });
    const teams = await teamsFn({ baseUrl, pat });
    if (!teams.includes(teamSlug)) {
      return {
        id: "gitea_team",
        level: "error",
        message: `gitea_team: PAT does not belong to '${teamSlug}'`,
        detail: { resolved_teams_count: teams.length },
      };
    }
    return {
      id: "gitea_team",
      level: "ok",
      message: `gitea_team: PAT is in '${teamSlug}'`,
    };
  } catch (err) {
    // PAT scrub before propagating — `err.message` may include
    // request headers (some fetch implementations / proxies
    // surface them on certain failure paths). The `pat` is a
    // string in scope here; `stripPat` replaces all occurrences
    // with `<REDACTED>`.
    const raw = err instanceof Error ? err.message : String(err);
    return {
      id: "gitea_team",
      level: "error",
      message: `gitea_team: ${stripPat(raw, pat)}`,
    };
  }
}

/** Adapter slugs that receive inbound HTTP webhooks (have a path under
 *  `/webhooks/`). Used to filter `sources_bindings` rows. `gitea` is
 *  absent because Gitea webhooks are currently a system-level route
 *  not wired through `sources_bindings`; it appears in the static
 *  INTERNET_FACING_PATHS list instead. */
const WEBHOOK_ADAPTER_SLUGS = new Set(["asana", "fireflies", "webhook"]);

/** Row shape returned by the webhook-bindings DB query.
 *  Includes `config` JSONB so we can resolve `pathSegment` for the
 *  generic `webhook` adapter. */
interface WebhookBindingRow {
  readonly id: string;
  readonly adapter_slug: string;
  readonly domain_slug: string;
  readonly config: Record<string, unknown> | null;
  readonly enabled: boolean;
}

/** Compute the URL path for a webhook binding row.
 *  Named adapters (asana/fireflies/gitea) use a fixed slug-based path.
 *  The generic `webhook` adapter routes by binding_id UUID. */
function computeWebhookPath(row: WebhookBindingRow): string {
  if (row.adapter_slug === "webhook") {
    return `/webhooks/${row.id}`;
  }
  return `/webhooks/${row.adapter_slug}`;
}

/** Query `sources_bindings` for webhook-mode rows and build the surface
 *  list. Returns a `DoctorCheck` + the resolved `WebhookSurface[]`.
 *
 *  Errors here are warn-level: the DB is already checked by `checkDb`;
 *  if `sources_bindings` doesn't exist yet (fresh install, migrations
 *  not run) we warn and continue. */
async function checkWebhookBindings(
  args: DoctorArgs,
): Promise<{ check: DoctorCheck; surfaces: ReadonlyArray<WebhookSurface> }> {
  let pool: import("pg").Pool | null = null;
  try {
    const factory = args.poolFactory ?? ((e): import("pg").Pool => openPool({ env: e }));
    pool = factory(args.env);
    const result = await pool.query<WebhookBindingRow>(
      `SELECT
         sb.id,
         sb.adapter_slug,
         d.slug AS domain_slug,
         sb.config,
         sb.enabled
       FROM sources_bindings sb
       JOIN domains d ON d.id = sb.domain_id
       WHERE sb.adapter_slug = ANY($1)
       ORDER BY sb.created_at ASC`,
      [Array.from(WEBHOOK_ADAPTER_SLUGS)],
    );

    if (result.rows.length === 0) {
      return {
        check: {
          id: "webhook_surfaces",
          level: "ok",
          message: "webhook_surfaces: no webhook bindings configured",
          detail: { count: 0 },
        },
        surfaces: [],
      };
    }

    const surfaces: WebhookSurface[] = result.rows.map((row) => {
      const path = computeWebhookPath(row);
      const surface: WebhookSurface = {
        path,
        bindingId: row.id,
        adapterSlug: row.adapter_slug,
        domainSlug: row.domain_slug,
        enabled: row.enabled,
      };
      if (row.adapter_slug === "webhook") {
        const seg = typeof row.config?.["pathSegment"] === "string"
          ? row.config["pathSegment"]
          : undefined;
        if (seg !== undefined) {
          return { ...surface, pathSegmentLabel: seg };
        }
      }
      return surface;
    });

    return {
      check: {
        id: "webhook_surfaces",
        level: "ok",
        message: `webhook_surfaces: ${surfaces.length} binding(s) enumerated`,
        detail: { count: surfaces.length },
      },
      surfaces,
    };
  } catch (err) {
    return {
      check: {
        id: "webhook_surfaces",
        level: "warn",
        message: `webhook_surfaces: could not enumerate bindings — ${err instanceof Error ? err.message : String(err)}`,
      },
      surfaces: [],
    };
  } finally {
    if (pool !== null) {
      await pool.end().catch(() => undefined);
    }
  }
}

export async function runDoctor(args: DoctorArgs): Promise<void> {
  const secrets = REQUIRED_SECRETS.map((name) => inspectSecret(args.env, name));
  const secretChecks: DoctorCheck[] = secrets.map((s) => ({
    id: `secret.${s.name}`,
    level: s.source === "unset" ? ("error" as const) : ("ok" as const),
    message: formatSecret(s),
  }));

  const dbCheck = await checkDb(args);
  const migCheck = dbCheck.level === "ok" ? await checkMigrations(args) : null;
  const giteaCheck = await checkGiteaTeam(args);
  // Fix #5: gate webhook check on DB availability — if checkDb already failed,
  // a second connection attempt adds noise without new information.
  const webhookResult = dbCheck.level === "ok"
    ? await checkWebhookBindings(args)
    : {
        check: {
          id: "webhook_surfaces",
          level: "ok" as const,
          message: "webhook_surfaces: skipped — db unavailable",
          detail: { count: 0, skipped: true },
        },
        surfaces: [] as ReadonlyArray<WebhookSurface>,
      };

  const checks: DoctorCheck[] = [
    ...secretChecks,
    dbCheck,
    ...(migCheck !== null ? [migCheck] : []),
    giteaCheck,
    webhookResult.check,
  ];

  const report: DoctorReport = {
    checks,
    internetFacing: INTERNET_FACING_PATHS,
    secrets,
    webhookSurfaces: webhookResult.surfaces,
  };

  if (args.json) {
    args.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const c of checks) {
      const tag =
        c.level === "ok" ? pc.green("ok  ") : c.level === "warn" ? pc.yellow("warn") : pc.red("err ");
      const stream = c.level === "ok" ? args.stdout : args.stderr;
      stream.write(`${tag} ${c.message}\n`);
    }
    args.stdout.write("\n");
    args.stdout.write(pc.bold("internet-facing surfaces (operator should gate via reverse proxy):\n"));
    for (const p of INTERNET_FACING_PATHS) {
      args.stdout.write(`  ${p}\n`);
    }
    args.stdout.write("\n");
    args.stdout.write(pc.bold("webhook intake surfaces:\n"));
    // Fix #6: distinguish three states — no bindings, bindings exist, and
    // enumeration failed — rather than collapsing the last two into the same
    // "no webhook bindings configured" message.
    if (webhookResult.check.level === "warn") {
      // Enumeration failed — the check message already contains the reason.
      args.stdout.write(`  could not enumerate (${webhookResult.check.message.replace(/^webhook_surfaces:\s*/i, "")})\n`);
    } else if (webhookResult.surfaces.length === 0) {
      args.stdout.write("  no webhook bindings configured\n");
    } else {
      for (const s of webhookResult.surfaces) {
        const status = s.enabled ? pc.green("enabled") : pc.yellow("paused");
        const label = s.pathSegmentLabel !== undefined ? `  (${s.pathSegmentLabel})` : "";
        args.stdout.write(
          `  ${s.path.padEnd(40)} binding=${s.bindingId}  domain=${s.domainSlug}  ${status}${label}\n`,
        );
      }
    }
  }

  // Exit code per Q6.
  const hasError = checks.some((c) => c.level === "error");
  if (hasError) {
    return exitUserError();
  }
  return exitOk();
}
