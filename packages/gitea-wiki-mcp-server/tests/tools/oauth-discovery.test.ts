import { describe, it, expect } from "vitest";
import express from "express";
import { createOAuthDiscoveryRouter } from "../../src/http/oauth-discovery.js";
import type { Config } from "../../src/config.js";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    mcpMode: "http",
    port: 3000,
    host: "0.0.0.0",
    bearerToken: "x".repeat(32),
    giteaPat: "pat",
    giteaBaseUrl: "https://gitea.example.com",
    repos: [{ slug: "w", owner: "o", name: "n", default: true }],
    dataDir: "/tmp/x",
    syncIntervalMin: 0,
    giteaWebhookSecret: "",
    logLevel: "info",
    corsOrigins: "",
    ...overrides,
  };
}

async function start(config: Config): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(createOAuthDiscoveryRouter(config));
  return await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

describe("oauth-discovery router", () => {
  describe("when OAuth is enabled", () => {
    const config = baseConfig({
      publicUrl: "https://mcp.example.com",
      giteaOauthClientId: "client123",
      giteaOauthClientSecret: "secret456",
    });

    it("returns protected-resource metadata pointing at /mcp", async () => {
      const { url, close } = await start(config);
      try {
        const res = await fetch(`${url}/.well-known/oauth-protected-resource`);
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        const body = await res.json();
        expect(body.resource).toBe("https://mcp.example.com/mcp");
        expect(body.authorization_servers).toEqual(["https://mcp.example.com"]);
      } finally {
        await close();
      }
    });

    it("returns AS metadata pointing at Gitea", async () => {
      const { url, close } = await start(config);
      try {
        const res = await fetch(`${url}/.well-known/oauth-authorization-server`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.issuer).toBe("https://mcp.example.com");
        expect(body.authorization_endpoint).toBe("https://gitea.example.com/login/oauth/authorize");
        expect(body.token_endpoint).toBe("https://gitea.example.com/login/oauth/access_token");
        expect(body.registration_endpoint).toBe("https://mcp.example.com/oauth/register");
        expect(body.code_challenge_methods_supported).toContain("S256");
        expect(body.grant_types_supported).toContain("authorization_code");
        expect(body.response_types_supported).toContain("code");
      } finally {
        await close();
      }
    });

    it("DCR returns the shared Gitea client credentials", async () => {
      const { url, close } = await start(config);
      try {
        const res = await fetch(`${url}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
            client_name: "ChatGPT MCP",
          }),
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.client_id).toBe("client123");
        expect(body.client_secret).toBe("secret456");
        expect(body.redirect_uris).toEqual([
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ]);
        expect(body.client_name).toBe("ChatGPT MCP");
        expect(body.token_endpoint_auth_method).toBe("client_secret_post");
        expect(body.grant_types).toContain("authorization_code");
      } finally {
        await close();
      }
    });

    it("DCR rejects missing redirect_uris", async () => {
      const { url, close } = await start(config);
      try {
        const res = await fetch(`${url}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "no uris" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("invalid_redirect_uri");
      } finally {
        await close();
      }
    });

    it("DCR rejects non-array redirect_uris", async () => {
      const { url, close } = await start(config);
      try {
        const res = await fetch(`${url}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: "not-an-array" }),
        });
        expect(res.status).toBe(400);
      } finally {
        await close();
      }
    });

    it("strips trailing slash from publicUrl + giteaBaseUrl", async () => {
      const trailing = baseConfig({
        publicUrl: "https://mcp.example.com/",
        giteaOauthClientId: "c",
        giteaOauthClientSecret: "s",
        giteaBaseUrl: "https://gitea.example.com/",
      });
      const { url, close } = await start(trailing);
      try {
        const res = await fetch(`${url}/.well-known/oauth-authorization-server`);
        const body = await res.json();
        expect(body.issuer).toBe("https://mcp.example.com");
        expect(body.authorization_endpoint).toBe("https://gitea.example.com/login/oauth/authorize");
      } finally {
        await close();
      }
    });
  });

  describe("when OAuth is disabled", () => {
    it("returns 503 on all discovery endpoints", async () => {
      const { url, close } = await start(baseConfig());
      try {
        for (const path of [
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-authorization-server",
        ]) {
          const res = await fetch(`${url}${path}`);
          expect(res.status).toBe(503);
          const body = await res.json();
          expect(body.error).toBe("oauth_disabled");
        }
        const reg = await fetch(`${url}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(reg.status).toBe(503);
      } finally {
        await close();
      }
    });
  });
});
