/**
 * Streamable-HTTP transport. One Express app with:
 *   - GET  /health                                    — liveness, no auth
 *   - GET  /.well-known/oauth-protected-resource      — OAuth 2.1 discovery (public)
 *   - GET  /.well-known/oauth-authorization-server    — OAuth 2.1 discovery (public)
 *   - POST /oauth/register                            — Dynamic Client Registration proxy
 *   - POST /mcp                                       — MCP JSON-RPC, bearer-gated
 *   - GET  /mcp                                       — 405, documents the POST-only shape
 *   - POST /refresh/:slug                             — Gitea-webhook-triggered git pull + reindex
 *
 * Bearer gate accepts both the static MCP_BEARER_TOKEN (internal: n8n / Claude
 * Code) and Gitea OAuth2 access tokens (public: ChatGPT Team / Claude.ai).
 * Discovery endpoints are mounted BEFORE the auth middleware so unauthenticated
 * clients can fetch them.
 *
 * Transport is stateless: a new StreamableHTTPServerTransport per request.
 * CORS exposes the MCP session headers so browser-based clients work.
 */
import express, { type Request, type Response } from "express";
import cors, { type CorsOptions } from "cors";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isOAuthEnabled, type Config } from "../config.js";
import { SERVER_INFO } from "../constants.js";
import { createGiteaOAuthValidator } from "../services/gitea-oauth.js";
import type { RepoRegistry } from "../services/repo-registry.js";
import type { GitSync } from "../sync/git-sync.js";
import { bearerAuth, type BearerAuthOptions } from "./auth.js";
import { createOAuthDiscoveryRouter } from "./oauth-discovery.js";
import { verifyGiteaSignature } from "./webhook-verify.js";

type RequestWithRawBody = Request & { rawBody?: Buffer };

export interface HttpServerHandle {
  close: () => Promise<void>;
}

export async function startHttpServer(
  config: Config,
  mcpServer: McpServer,
  registry: RepoRegistry,
  gitSync: GitSync,
): Promise<HttpServerHandle> {
  const app = express();

  // Caddy terminates TLS and hits us over the Docker network. Trust exactly
  // one proxy hop so req.ip / rate-limit keys are the real client IP.
  app.set("trust proxy", 1);

  // Raw body capture for webhook HMAC verification. Must run BEFORE the json
  // parser for the /refresh route; applied globally with a path guard so
  // non-webhook routes skip it.
  app.use((req, _res, next) => {
    if (!req.path.startsWith("/refresh/")) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      (req as RequestWithRawBody).rawBody = raw;
      try {
        req.body = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        req.body = {};
      }
      next();
    });
    req.on("error", next);
  });

  // Standard JSON body parser for non-webhook routes.
  app.use(express.json({ limit: "4mb" }));

  // CORS — origin allow-list from env, default open (internal-only deploys).
  // ChatGPT / Claude.ai need to see our MCP session + WWW-Authenticate
  // headers for the protocol to work; those stay in exposedHeaders.
  const corsAllowList = config.corsOrigins
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const corsOrigin: CorsOptions["origin"] = corsAllowList.length === 0
    ? true
    : (origin, cb) => {
        // Allow same-origin / server-to-server (no Origin header).
        if (!origin || corsAllowList.includes(origin)) {
          cb(null, origin || true);
        } else {
          cb(null, false);
        }
      };
  app.use(cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"],
    exposedHeaders: ["WWW-Authenticate", "Mcp-Session-Id", "Mcp-Protocol-Version"],
    credentials: true,
  }));

  // Health — no auth, no rate limit. Used by Caddy + Docker.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: SERVER_INFO.name,
      version: SERVER_INFO.version,
      oauth: isOAuthEnabled(config),
      repos: registry.list().map((r) => r.slug),
    });
  });

  // OAuth 2.1 discovery + DCR proxy. Public (no auth). Mounted BEFORE /mcp.
  app.use(createOAuthDiscoveryRouter(config));

  // Construct the Gitea OAuth validator if we have enough config. It's the
  // one piece of shared state the bearer middleware needs.
  const giteaValidator = isOAuthEnabled(config)
    ? createGiteaOAuthValidator({ giteaBaseUrl: config.giteaBaseUrl })
    : undefined;

  // Rate limit on /mcp only — the expensive path.
  const mcpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { jsonrpc: "2.0", error: { code: -32002, message: "Rate limit exceeded" }, id: null },
  });

  // Explicit 405 on GET /mcp so probes get a real answer instead of a 404
  // that'd look like a missing route. Keep the JSON-RPC shape for clients
  // that parse it anyway.
  app.get("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Use POST for MCP JSON-RPC" },
      id: null,
    });
  });

  const bearerOpts: BearerAuthOptions = {
    staticToken: config.bearerToken,
    giteaValidator,
    publicUrl: config.publicUrl,
  };

  // MCP endpoint — bearer auth then streamable HTTP transport per request.
  app.post(
    "/mcp",
    mcpLimiter,
    bearerAuth(bearerOpts),
    async (req: Request, res: Response) => {
      const principal = req.authPrincipal;
      const who = principal?.kind === "gitea" ? principal.login : "static";
      const method = Array.isArray(req.body)
        ? req.body.map((r: { method?: string }) => r.method).join("+")
        : (req.body?.method ?? "?");
      console.error(`[mcp] ${who} → ${method}`);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close().catch(() => undefined);
      });
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[http] /mcp handler error: ${msg}`);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          });
        }
      }
    },
  );

  // Gitea webhook → trigger pull + reindex. HMAC-verified with the shared secret.
  app.post("/refresh/:slug", async (req: Request, res: Response) => {
    const slug = typeof req.params.slug === "string" ? req.params.slug : "";
    if (!slug) {
      res.status(400).json({ error: "missing_slug" });
      return;
    }

    if (!config.giteaWebhookSecret) {
      res.status(403).json({
        error: "webhook_disabled",
        message: "Server has no GITEA_WEBHOOK_SECRET configured",
      });
      return;
    }

    const rawSignature = req.header("x-gitea-signature");
    const signature = typeof rawSignature === "string" ? rawSignature : undefined;
    const rawBody = (req as RequestWithRawBody).rawBody ?? Buffer.alloc(0);
    if (!verifyGiteaSignature(rawBody, config.giteaWebhookSecret, signature)) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    let entry;
    try {
      entry = registry.resolve(slug).entry;
    } catch {
      res.status(404).json({ error: "unknown_repo", slug });
      return;
    }

    try {
      const { changed } = await gitSync.pullOne(entry);
      if (changed) await gitSync.rebuildIndex(entry);
      console.error(`[http] /refresh/${slug} ok, changed=${changed}`);
      res.json({ ok: true, slug, changed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[http] /refresh/${slug} failed: ${msg}`);
      res.status(500).json({ error: "pull_failed", message: msg });
    }
  });

  // 404 fallback.
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const httpServer = app.listen(config.port, config.host, () => {
    const oauthNote = isOAuthEnabled(config) ? " +oauth" : "";
    console.error(
      `[http] listening on http://${config.host}:${config.port} (paths: /mcp, /refresh/:slug, /health${oauthNote})`,
    );
  });

  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
