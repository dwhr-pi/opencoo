/**
 * Hybrid bearer middleware for /mcp.
 *
 * Accepts TWO kinds of tokens:
 *   1. The static `MCP_BEARER_TOKEN` — the internal path used by n8n +
 *      Claude Code. Timing-safe compared.
 *   2. A Gitea OAuth2 access token — the public path used by ChatGPT Team
 *      connectors. Validated via gitea-oauth.ts (cached).
 *
 * On failure returns 401 with `WWW-Authenticate: Bearer` pointing at the
 * OAuth discovery document so RFC-9728-aware clients (ChatGPT, Claude.ai)
 * kick off discovery automatically.
 */
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { GiteaOAuthValidator } from "../services/gitea-oauth.js";

export interface AuthPrincipal {
  kind: "static" | "gitea";
  login?: string;
  email?: string;
  name?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    // Distinct from the MCP SDK's `auth` (AuthInfo shape with token/clientId/
    // scopes). This one carries the resolved principal for our hybrid flow.
    authPrincipal?: AuthPrincipal;
  }
}

export interface BearerAuthOptions {
  staticToken: string;
  /** Gitea OAuth validator — pass only when OAuth is enabled. */
  giteaValidator?: GiteaOAuthValidator;
  /** Publicly reachable URL of this server. When set, 401 responses include
   *  `WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/..."`
   *  which triggers ChatGPT's OAuth discovery flow. */
  publicUrl?: string;
}

export function bearerAuth(opts: BearerAuthOptions) {
  const expectedBuf = Buffer.from(opts.staticToken, "utf8");
  const publicUrl = opts.publicUrl?.replace(/\/+$/, "");
  const validator = opts.giteaValidator;

  function wwwAuthenticate(err?: "invalid_token"): string {
    const parts = [`Bearer realm="gitea-wiki-mcp"`];
    if (err) parts.push(`error="${err}"`);
    if (publicUrl) {
      parts.push(`resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`);
    }
    return parts.join(", ");
  }

  function reject(
    res: Response,
    message: string,
    err?: "invalid_token",
  ): void {
    res.setHeader("WWW-Authenticate", wwwAuthenticate(err));
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    });
  }

  return async function bearerMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const hdr = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(hdr);
    if (!match) {
      reject(res, "Missing bearer token");
      return;
    }

    const token = match[1]!;
    const givenBuf = Buffer.from(token, "utf8");

    // Path 1: static token (internal n8n / Claude Code).
    if (
      givenBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(givenBuf, expectedBuf)
    ) {
      req.authPrincipal = { kind: "static" };
      next();
      return;
    }

    // Path 2: Gitea OAuth token (ChatGPT / Claude.ai / other OAuth clients).
    if (validator) {
      const result = await validator.validate(token);
      if (result.valid && result.user) {
        const { login, email, name } = result.user;
        req.authPrincipal = { kind: "gitea", login, email, name };
        next();
        return;
      }
    }

    reject(res, "Invalid bearer token", "invalid_token");
  };
}
