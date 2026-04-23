import { describe, it, expect, vi } from "vitest";
import { createGiteaOAuthValidator } from "../../src/services/gitea-oauth.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

describe("createGiteaOAuthValidator", () => {
  it("accepts a 200 userinfo response and extracts the principal", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify({ login: "alice", email: "alice@example.com", name: "Alice" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const v = createGiteaOAuthValidator({
      giteaBaseUrl: "https://gitea.example.com",
      fetchImpl,
    });
    const out = await v.validate("t1");
    expect(out.valid).toBe(true);
    expect(out.user?.login).toBe("alice");
    expect(out.user?.email).toBe("alice@example.com");
  });

  it("rejects 401 from Gitea", async () => {
    const fetchImpl = mockFetch(() => new Response("nope", { status: 401 }));
    const v = createGiteaOAuthValidator({
      giteaBaseUrl: "https://gitea.example.com",
      fetchImpl,
    });
    const out = await v.validate("bad");
    expect(out.valid).toBe(false);
    expect(out.user).toBeUndefined();
  });

  it("caches successful validations — same token hits fetch once", async () => {
    const spy = vi.fn(
      () =>
        new Response(
          JSON.stringify({ login: "bob" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const fetchImpl = mockFetch(spy);
    const v = createGiteaOAuthValidator({
      giteaBaseUrl: "https://gitea.example.com",
      fetchImpl,
    });
    const a = await v.validate("cached-token");
    const b = await v.validate("cached-token");
    expect(a.valid).toBe(true);
    expect(b.valid).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(v.size()).toBe(1);
  });

  it("does not cache negative results — retries on next call", async () => {
    let callCount = 0;
    const spy = vi.fn(() => {
      callCount += 1;
      return callCount === 1
        ? new Response("nope", { status: 401 })
        : new Response(
            JSON.stringify({ login: "eve" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
    });
    const fetchImpl = mockFetch(spy);
    const v = createGiteaOAuthValidator({
      giteaBaseUrl: "https://gitea.example.com",
      fetchImpl,
    });
    const first = await v.validate("rotating-token");
    const second = await v.validate("rotating-token");
    expect(first.valid).toBe(false);
    expect(second.valid).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("invalidate() drops a cached entry", async () => {
    const spy = vi.fn(
      () =>
        new Response(
          JSON.stringify({ login: "carol" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const fetchImpl = mockFetch(spy);
    const v = createGiteaOAuthValidator({
      giteaBaseUrl: "https://gitea.example.com",
      fetchImpl,
    });
    await v.validate("tok");
    v.invalidate("tok");
    await v.validate("tok");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("handles userinfo missing login field → invalid", async () => {
    const fetchImpl = mockFetch(
      () => new Response(JSON.stringify({ email: "no-login@x.y" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const v = createGiteaOAuthValidator({
      giteaBaseUrl: "https://gitea.example.com",
      fetchImpl,
    });
    const out = await v.validate("t");
    expect(out.valid).toBe(false);
  });

  it("network error → invalid, nothing cached", async () => {
    const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const v = createGiteaOAuthValidator({
      giteaBaseUrl: "https://gitea.example.com",
      fetchImpl,
    });
    const out = await v.validate("t");
    expect(out.valid).toBe(false);
    expect(v.size()).toBe(0);
  });

  it("strips trailing slash from base URL", async () => {
    let seenUrl = "";
    const fetchImpl = mockFetch((url) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ login: "x" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const v = createGiteaOAuthValidator({
      giteaBaseUrl: "https://gitea.example.com/",
      fetchImpl,
    });
    await v.validate("t");
    expect(seenUrl).toBe("https://gitea.example.com/login/oauth/userinfo");
  });
});
