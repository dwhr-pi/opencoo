import { describe, it, expect, vi } from "vitest";
import express from "express";
import { bearerAuth } from "../../src/http/auth.js";
import type { GiteaOAuthValidator } from "../../src/services/gitea-oauth.js";

const STATIC = "static-token-0123456789abcdef-long-enough";

function okHandler(req: express.Request, res: express.Response): void {
  res.json({ ok: true, principal: req.authPrincipal });
}

async function start(opts: Parameters<typeof bearerAuth>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.post("/mcp", bearerAuth(opts), okHandler);
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

describe("bearerAuth hybrid middleware", () => {
  it("accepts the static token → principal kind=static", async () => {
    const { url, close } = await start({ staticToken: STATIC });
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${STATIC}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.principal.kind).toBe("static");
    } finally {
      await close();
    }
  });

  it("rejects a wrong token with no validator → 401", async () => {
    const { url, close } = await start({ staticToken: STATIC });
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer nope" },
      });
      expect(res.status).toBe(401);
      const www = res.headers.get("www-authenticate") ?? "";
      expect(www).toContain("Bearer");
      expect(www).toContain('error="invalid_token"');
    } finally {
      await close();
    }
  });

  it("accepts a Gitea-validated token → principal kind=gitea with login", async () => {
    const validator: GiteaOAuthValidator = {
      validate: vi.fn(async (token: string) =>
        token === "gitea-good"
          ? { valid: true, user: { login: "alice", email: "a@x.y" } }
          : { valid: false },
      ),
      invalidate: vi.fn(),
      size: () => 0,
    };
    const { url, close } = await start({ staticToken: STATIC, giteaValidator: validator });
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer gitea-good" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.principal).toEqual({
        kind: "gitea",
        login: "alice",
        email: "a@x.y",
      });
    } finally {
      await close();
    }
  });

  it("emits resource_metadata hint when publicUrl set + invalid token", async () => {
    const { url, close } = await start({
      staticToken: STATIC,
      publicUrl: "https://mcp.example.com",
    });
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
      const www = res.headers.get("www-authenticate") ?? "";
      expect(www).toContain(
        'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      );
    } finally {
      await close();
    }
  });

  it("static token is checked first — validator not called on match", async () => {
    const spy = vi.fn(async () => ({ valid: false }));
    const validator: GiteaOAuthValidator = {
      validate: spy,
      invalidate: vi.fn(),
      size: () => 0,
    };
    const { url, close } = await start({ staticToken: STATIC, giteaValidator: validator });
    try {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${STATIC}` },
      });
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("missing header → 401 + WWW-Authenticate", async () => {
    const { url, close } = await start({ staticToken: STATIC });
    try {
      const res = await fetch(`${url}/mcp`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    } finally {
      await close();
    }
  });
});
