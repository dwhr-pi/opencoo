/**
 * Configuration loading and validation. All env parsing happens here once at
 * startup — downstream code should import `loadConfig()` output, never read
 * `process.env` directly.
 */
import { z } from "zod";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const RepoEntrySchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, "slug must be lowercase alphanumeric with - or _"),
    owner: z.string().min(1),
    name: z.string().min(1),
    default: z.boolean().optional().default(false),
    access_tag: z.string().optional(),
  })
  .strict();

export type RepoEntry = z.infer<typeof RepoEntrySchema>;

const ConfigSchema = z
  .object({
    mcpMode: z.enum(["stdio", "http"]).default("stdio"),
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    host: z.string().default("0.0.0.0"),
    bearerToken: z.string().min(16, "MCP_BEARER_TOKEN must be at least 16 chars"),
    giteaPat: z.string().min(1, "GITEA_PAT is required"),
    giteaBaseUrl: z.string().url(),
    repos: z.array(RepoEntrySchema).min(1, "REPOS must list at least one repo"),
    dataDir: z.string().default("./data"),
    syncIntervalMin: z.coerce.number().int().min(0).default(5),
    giteaWebhookSecret: z.string().optional().default(""),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
    // --- OAuth 2.1 public-access path (all optional; absent → OAuth disabled) -
    // Public URL this server is reachable at — used as the OAuth issuer and in
    // the WWW-Authenticate resource_metadata hint. Leave empty for internal-only.
    publicUrl: z.string().url().optional(),
    // Publicly-reachable Gitea URL used in OAuth discovery (authorize_endpoint,
    // token_endpoint). Defaults to giteaBaseUrl when unset — required only
    // when the server talks to Gitea over an internal URL (docker network,
    // VPN) that browsers can't reach.
    giteaPublicUrl: z.string().url().optional(),
    // Gitea OAuth2 app credentials. The "shared client" the DCR proxy hands to
    // every MCP client (ChatGPT, etc.). Create this once in Gitea admin UI.
    giteaOauthClientId: z.string().optional(),
    giteaOauthClientSecret: z.string().optional(),
    // Gitea admin API token — optional. If provided, the DCR endpoint will try
    // to append newly-seen redirect_uris to the shared OAuth app. Without it,
    // the admin must pre-add every ChatGPT redirect URI manually.
    giteaAdminToken: z.string().optional(),
    // Comma-separated origin allow-list for CORS. Empty → allow all origins
    // (matches the legacy behavior for internal-only deploys).
    corsOrigins: z.string().optional().default(""),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate env vars. Exits the process with a clear message if
 * anything required is missing — we'd rather crash at boot than serve a
 * partially-configured server.
 */
export function loadConfig(): Config {
  const reposRaw = process.env.REPOS ?? "[]";
  let reposParsed: unknown;
  try {
    reposParsed = JSON.parse(reposRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: REPOS env is not valid JSON — ${msg}`);
    process.exit(1);
  }

  const parsed = ConfigSchema.safeParse({
    mcpMode: process.env.MCP_MODE,
    port: process.env.PORT,
    host: process.env.HOST,
    bearerToken: process.env.MCP_BEARER_TOKEN,
    giteaPat: process.env.GITEA_PAT,
    giteaBaseUrl: process.env.GITEA_BASE_URL,
    repos: reposParsed,
    dataDir: process.env.DATA_DIR,
    syncIntervalMin: process.env.SYNC_INTERVAL_MIN,
    giteaWebhookSecret: process.env.GITEA_WEBHOOK_SECRET,
    logLevel: process.env.LOG_LEVEL,
    publicUrl: process.env.PUBLIC_URL,
    giteaPublicUrl: process.env.GITEA_PUBLIC_URL,
    giteaOauthClientId: process.env.GITEA_OAUTH_CLIENT_ID,
    giteaOauthClientSecret: process.env.GITEA_OAUTH_CLIENT_SECRET,
    giteaAdminToken: process.env.GITEA_ADMIN_TOKEN,
    corsOrigins: process.env.CORS_ORIGINS,
  });

  if (!parsed.success) {
    console.error("ERROR: Invalid configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    console.error("\nSee .env.example for required variables.");
    process.exit(1);
  }

  // Exactly one default repo.
  const defaults = parsed.data.repos.filter((r) => r.default);
  if (defaults.length === 0) {
    console.error(
      "ERROR: REPOS must have exactly one entry with `default: true`. None found.",
    );
    process.exit(1);
  }
  if (defaults.length > 1) {
    console.error(
      `ERROR: REPOS has ${defaults.length} entries with default:true — exactly one allowed.`,
    );
    process.exit(1);
  }

  // Unique slugs.
  const slugs = new Set<string>();
  for (const r of parsed.data.repos) {
    if (slugs.has(r.slug)) {
      console.error(`ERROR: duplicate repo slug "${r.slug}" in REPOS.`);
      process.exit(1);
    }
    slugs.add(r.slug);
  }

  // Normalize dataDir to absolute.
  const absoluteDataDir = path.resolve(parsed.data.dataDir);

  // OAuth vars are all-or-nothing: either all three (publicUrl, clientId,
  // clientSecret) are set or none are. Partial config = misconfiguration.
  const oauthPresent = [
    parsed.data.publicUrl,
    parsed.data.giteaOauthClientId,
    parsed.data.giteaOauthClientSecret,
  ].filter((v) => typeof v === "string" && v.length > 0).length;
  if (oauthPresent !== 0 && oauthPresent !== 3) {
    console.error(
      "ERROR: OAuth config is partial. Set ALL of PUBLIC_URL, GITEA_OAUTH_CLIENT_ID, GITEA_OAUTH_CLIENT_SECRET — or none.",
    );
    process.exit(1);
  }

  return { ...parsed.data, dataDir: absoluteDataDir };
}

/** True when all OAuth env vars are configured. Controls whether the server
 *  exposes the /.well-known/* + /oauth/register endpoints and accepts Gitea
 *  OAuth tokens in the bearer middleware. */
export function isOAuthEnabled(config: Config): boolean {
  return Boolean(
    config.publicUrl && config.giteaOauthClientId && config.giteaOauthClientSecret,
  );
}
