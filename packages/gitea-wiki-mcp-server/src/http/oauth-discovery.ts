/**
 * OAuth 2.1 discovery + DCR proxy routes.
 *
 * ChatGPT Team custom connectors (and Claude.ai remote MCP) only accept
 * `noauth` or OAuth 2.1. Static bearer tokens are not an option for those
 * clients. This module makes our MCP server look like a full OAuth 2.1
 * Authorization Server even though the actual AS is Gitea.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource       — RFC 9728
 *   GET  /.well-known/oauth-authorization-server     — RFC 8414
 *   POST /oauth/register                             — RFC 7591 DCR proxy
 *
 * The DCR proxy returns ONE pre-registered Gitea OAuth2 app's client_id +
 * client_secret to every caller. Different MCP clients share that app; each
 * user still gets their own access token via the standard auth-code + PKCE
 * flow. This pattern is how the hosted ChatGPT + Atlassian + Cloudflare
 * Workers MCP bridges all work — Gitea 1.21's OAuth2 provider has no native
 * DCR support.
 */
import type { Request, Response, Router } from "express";
import express from "express";
import { isOAuthEnabled, type Config } from "../config.js";

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported?: string[];
}

interface DcrRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
}

interface DcrResponse {
  client_id: string;
  client_secret: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
  scope?: string;
}

/**
 * Build the router. Returns a no-op router (404s on all routes) when OAuth
 * is disabled via config — preserves the internal-only deploy shape.
 */
export function createOAuthDiscoveryRouter(config: Config): Router {
  const router = express.Router();

  if (!isOAuthEnabled(config)) {
    // OAuth disabled — mount 503s on the public paths so clients get a
    // readable error rather than a confusing 404.
    for (const p of OAUTH_PATHS) router.all(p, disabled);
    return router;
  }

  // Safe casts: isOAuthEnabled guarantees these are set.
  const publicUrl = stripTrailingSlash(config.publicUrl as string);
  const clientId = config.giteaOauthClientId as string;
  const clientSecret = config.giteaOauthClientSecret as string;
  // Prefer the public Gitea URL when the server talks to Gitea internally
  // (docker network, VPN). ChatGPT / user browsers need a URL they can reach.
  const giteaBase = stripTrailingSlash(config.giteaPublicUrl ?? config.giteaBaseUrl);

  // Known redirect URIs the DCR proxy will happily echo back. We don't
  // validate caller-provided URIs against this list — the security boundary
  // is Gitea itself, which WILL reject unknown redirect_uris at authorize
  // time. This list is just for logging + the admin-token auto-register path.
  const seenRedirectUris = new Set<string>();

  function sendDiscovery(res: Response, body: object): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(body);
  }

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const body: ProtectedResourceMetadata = {
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ["header"],
    };
    sendDiscovery(res, body);
  });

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const body: AuthorizationServerMetadata = {
      issuer: publicUrl,
      authorization_endpoint: `${giteaBase}/login/oauth/authorize`,
      token_endpoint: `${giteaBase}/login/oauth/access_token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      // Gitea supports both — "client_secret_post" is what ChatGPT uses.
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      scopes_supported: ["read:user", "read:organization"],
    };
    sendDiscovery(res, body);
  });

  router.post("/oauth/register", async (req, res) => {
    const body = (req.body ?? {}) as DcrRequest;
    const redirectUris = normalizeStringArray(body.redirect_uris);
    if (redirectUris.length === 0) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a non-empty array of strings",
      });
      return;
    }

    // Log newly-seen URIs so the admin can spot drift in ChatGPT's redirects.
    const unseen = redirectUris.filter((u) => !seenRedirectUris.has(u));
    for (const u of unseen) seenRedirectUris.add(u);
    if (unseen.length > 0) {
      console.error(
        `[oauth-discovery] DCR: new redirect_uri(s) ${JSON.stringify(unseen)} — ensure they are registered on the Gitea OAuth2 app (id=${clientId.slice(0, 8)}…)`,
      );
      // Best-effort: if admin token is configured, try to patch the app.
      if (config.giteaAdminToken) {
        await tryAddRedirectUris(config, redirectUris).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[oauth-discovery] auto-register failed: ${msg}`);
        });
      }
    }

    const response: DcrResponse = {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (typeof body.client_name === "string") response.client_name = body.client_name;
    if (typeof body.scope === "string") response.scope = body.scope;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(201).json(response);
  });

  return router;
}

const OAUTH_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
] as const;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function disabled(_req: Request, res: Response): void {
  res.status(503).json({
    error: "oauth_disabled",
    error_description:
      "OAuth is not configured on this server. Set PUBLIC_URL, GITEA_OAUTH_CLIENT_ID, GITEA_OAUTH_CLIENT_SECRET to enable.",
  });
}

function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Best-effort: patch the Gitea OAuth2 app to include unseen redirect URIs.
 * Requires GITEA_ADMIN_TOKEN. Gitea's API: GET then PATCH the app with the
 * merged redirect_uris list. Uses the `/api/v1/user/applications/oauth2/{id}`
 * endpoint (must be called as the user who owns the app).
 *
 * If this fails for any reason we log and move on — the DCR response is
 * already sent, so worst case the user hits Gitea, sees "redirect_uri_mismatch"
 * and the admin adds it by hand.
 */
async function tryAddRedirectUris(config: Config, newUris: string[]): Promise<void> {
  const base = stripTrailingSlash(config.giteaBaseUrl);
  const authHeaders = {
    Authorization: `token ${config.giteaAdminToken as string}`,
    Accept: "application/json",
  };
  // Fetch all OAuth2 apps for the calling user; find ours by client_id.
  const listRes = await fetch(`${base}/api/v1/user/applications/oauth2`, {
    headers: authHeaders,
  });
  if (!listRes.ok) {
    throw new Error(`list apps failed: ${listRes.status}`);
  }
  const apps = (await listRes.json()) as Array<{
    id: number;
    client_id: string;
    redirect_uris: string[];
    name: string;
    confidential_client?: boolean;
  }>;
  const ours = apps.find((a) => a.client_id === config.giteaOauthClientId);
  if (!ours) {
    throw new Error("OAuth app not found for configured client_id");
  }
  const merged = Array.from(new Set([...(ours.redirect_uris ?? []), ...newUris]));
  if (merged.length === ours.redirect_uris.length) return; // nothing to do

  const patchRes = await fetch(`${base}/api/v1/user/applications/oauth2/${ours.id}`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: ours.name,
      redirect_uris: merged,
      confidential_client: ours.confidential_client ?? true,
    }),
  });
  if (!patchRes.ok) {
    throw new Error(`patch app failed: ${patchRes.status}`);
  }
  console.error(
    `[oauth-discovery] auto-registered ${newUris.length} new redirect URI(s) on Gitea app ${ours.id}`,
  );
}
