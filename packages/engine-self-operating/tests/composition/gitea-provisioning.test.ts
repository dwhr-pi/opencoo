/**
 * `provisionDomainRepo` tests (phase-a appendix #2).
 *
 * Sanctioned exception per architecture.md §1424 — the
 * domain-create flow MUST be able to seed a fresh Gitea repo
 * (one repo per domain) outside the wikiWrite orchestrator.
 * THREAT-MODEL §3.5 documents the exception.
 *
 * Provisioning steps:
 *   1. POST /api/v1/orgs/{org}/repos with {name: slug, private: true}.
 *   2. Create three seed files via PUT /api/v1/repos/{org}/{slug}/contents/{path}:
 *      - index.md
 *      - log.md
 *      - schema.md
 *   3. Idempotent — a 409 from steps 1/2 is treated as
 *      "already provisioned, continue" not a hard error.
 *   4. PAT scrubbed from any error message (THREAT-MODEL §3.13).
 *   5. Domain-class-aware: catalog-* class seeds use the
 *      catalog-class schema/index template.
 */
import { describe, expect, it, vi } from "vitest";

import { provisionDomainRepo } from "../../src/composition/gitea-provisioning.js";

const SECRET_PAT = "ghp_provisioning-secret-7890abcdef";

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("provisionDomainRepo — happy path", () => {
  it("creates the repo + seeds three files (index/log/schema) and returns repoUrl", async () => {
    const fetchImpl = vi.fn();
    // 1) POST /api/v1/orgs/opencoo/repos → 201 with html_url.
    fetchImpl.mockResolvedValueOnce(
      ok(
        {
          full_name: "opencoo/wiki-main",
          html_url: "https://gitea.test/opencoo/wiki-main",
          private: true,
        },
        201,
      ),
    );
    // 2) POST /api/v1/repos/opencoo/wiki-main/contents/index.md → 201
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "a" } }, 201));
    // 3) POST /contents/log.md
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "b" } }, 201));
    // 4) POST /contents/schema.md
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "c" } }, 201));

    const result = await provisionDomainRepo({
      baseUrl: "https://gitea.test",
      pat: SECRET_PAT,
      org: "opencoo",
      slug: "wiki-main",
      domainClass: "knowledge",
      defaultLocale: "en",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.repoUrl).toBe("https://gitea.test/opencoo/wiki-main");
    // 4 fetch calls: 1 repo create + 3 file seeds.
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    // The repo-create call carries `private: true`.
    const repoCallInit = fetchImpl.mock.calls[0]![1] as RequestInit;
    const repoBody = JSON.parse(String(repoCallInit.body)) as {
      name: string;
      private?: boolean;
    };
    expect(repoBody.name).toBe("wiki-main");
    expect(repoBody.private).toBe(true);

    // Each fetch carries `Authorization: token <pat>`.
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>).authorization).toBe(
        `token ${SECRET_PAT}`,
      );
    }

    // The seed-file URLs hit the right endpoints.
    const seedUrls = fetchImpl.mock.calls.slice(1).map((c) => String(c[0]));
    expect(seedUrls[0]).toMatch(/\/repos\/opencoo\/wiki-main\/contents\/index\.md$/);
    expect(seedUrls[1]).toMatch(/\/repos\/opencoo\/wiki-main\/contents\/log\.md$/);
    expect(seedUrls[2]).toMatch(/\/repos\/opencoo\/wiki-main\/contents\/schema\.md$/);

    // Wire-shape regression for bug C — every seed-file fetch must
    // be POST (Gitea's "create file" verb). PUT is the "update"
    // endpoint and returns 422 [SHA]: Required on a fresh repo,
    // which the previous idempotency carve-out silently swallowed
    // → empty repo. Index 0 is the repo-create POST; indices 1-3
    // are the seed file POSTs.
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).method).toBe("POST");
    expect((fetchImpl.mock.calls[2]![1] as RequestInit).method).toBe("POST");
    expect((fetchImpl.mock.calls[3]![1] as RequestInit).method).toBe("POST");
  });
});

describe("provisionDomainRepo — fresh empty repo (regression for bug C)", () => {
  it("provisionDomainRepo on a fresh empty repo seeds all three files (regression for the PUT-on-empty-repo bug)", async () => {
    // Smoke test against a freshly created Gitea repo (no default
    // branch yet). The bug was: PUT on contents/<path> for a repo
    // with no commits returned 422 [SHA]: Required, which the
    // idempotency carve-out swallowed as "already seeded" — leaving
    // the repo empty. Helper must POST (Gitea's "Create a file"
    // endpoint creates the default branch automatically when the
    // repo has no commits) and the three seeds must each land.
    const fetchImpl = vi.fn();
    // 1) repo create POST → 201
    fetchImpl.mockResolvedValueOnce(
      ok({ html_url: "https://gitea.test/opencoo/fresh-repo" }, 201),
    );
    // 2-4) three seed POSTs → 201 each (Gitea returns the new
    //      content sha in the body)
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "i1" } }, 201));
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "i2" } }, 201));
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "i3" } }, 201));

    const result = await provisionDomainRepo({
      baseUrl: "https://gitea.test",
      pat: SECRET_PAT,
      org: "opencoo",
      slug: "fresh-repo",
      domainClass: "knowledge",
      defaultLocale: "en",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.repoUrl).toBe("https://gitea.test/opencoo/fresh-repo");
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    // Three seed-file calls — methods MUST be POST and URLs MUST
    // end with the expected `contents/<path>` paths.
    const seedCalls = fetchImpl.mock.calls.slice(1);
    expect(seedCalls).toHaveLength(3);
    expect(String(seedCalls[0]![0])).toMatch(
      /\/repos\/opencoo\/fresh-repo\/contents\/index\.md$/,
    );
    expect(String(seedCalls[1]![0])).toMatch(
      /\/repos\/opencoo\/fresh-repo\/contents\/log\.md$/,
    );
    expect(String(seedCalls[2]![0])).toMatch(
      /\/repos\/opencoo\/fresh-repo\/contents\/schema\.md$/,
    );
    for (const call of seedCalls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("POST");
    }
  });
});

describe("provisionDomainRepo — idempotency", () => {
  it("treats a 422 with 'already exists' body on a seed POST as 'already provisioned, continue'", async () => {
    // Gitea returns 422 + a body containing "already exists" when
    // the file already exists at the target path. Provisioning
    // is supposed to be re-runnable, so this is the idempotency
    // signal alongside 409.
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      ok({ html_url: "https://gitea.test/opencoo/wiki-existing" }, 201),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "A file with this name already exists" }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "ok" } }, 201));
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "ok" } }, 201));
    const result = await provisionDomainRepo({
      baseUrl: "https://gitea.test",
      pat: SECRET_PAT,
      org: "opencoo",
      slug: "wiki-existing",
      domainClass: "knowledge",
      defaultLocale: "en",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.repoUrl).toBe("https://gitea.test/opencoo/wiki-existing");
  });

  it("treats a 409 from a seed POST as 'already provisioned, continue'", async () => {
    // The repo-create call already had its 409 carve-out (see
    // below); the seed-file calls need the same treatment because
    // POST on an existing path returns 409 (whereas PUT returned
    // 422). This pin guards the seed-file branch independently.
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      ok({ html_url: "https://gitea.test/opencoo/wiki-existing-409" }, 201),
    );
    fetchImpl.mockResolvedValueOnce(
      ok({ message: "file already exists" }, 409),
    );
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "ok" } }, 201));
    fetchImpl.mockResolvedValueOnce(ok({ content: { sha: "ok" } }, 201));
    const result = await provisionDomainRepo({
      baseUrl: "https://gitea.test",
      pat: SECRET_PAT,
      org: "opencoo",
      slug: "wiki-existing-409",
      domainClass: "knowledge",
      defaultLocale: "en",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.repoUrl).toBe("https://gitea.test/opencoo/wiki-existing-409");
  });

  it("does NOT silently swallow a 422 with '[SHA]: Required' as idempotent (the old PUT bug must propagate)", async () => {
    // The previous carve-out matched [SHA]: Required as
    // idempotent, which masked the underlying PUT-vs-POST bug
    // because a fresh empty repo's PUT response is 422 [SHA]:
    // Required → swallowed → empty repo. After the fix the
    // helper POSTs (which never returns this 422 message under
    // normal operation), and the carve-out is tightened to only
    // accept 409 OR 422 + "already exists". A 422 [SHA]:
    // Required must surface as an error so the carve-out cannot
    // re-introduce the silent-empty-repo failure mode.
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      ok({ html_url: "https://gitea.test/opencoo/wiki-shafail" }, 201),
    );
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "[SHA]: Required" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );
    let caught: Error | null = null;
    try {
      await provisionDomainRepo({
        baseUrl: "https://gitea.test",
        pat: SECRET_PAT,
        org: "opencoo",
        slug: "wiki-shafail",
        domainClass: "knowledge",
        defaultLocale: "en",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/422/);
  });

  it("treats a 409 on repo-create as 'already provisioned, continue'", async () => {
    const fetchImpl = vi.fn();
    // 1) repo create returns 409 (already exists).
    fetchImpl.mockResolvedValueOnce(
      ok({ message: "Repository already exists" }, 409),
    );
    // The helper falls through to seeding — assume seeds also already exist.
    fetchImpl.mockResolvedValueOnce(ok({ message: "exists" }, 409));
    fetchImpl.mockResolvedValueOnce(ok({ message: "exists" }, 409));
    fetchImpl.mockResolvedValueOnce(ok({ message: "exists" }, 409));

    const result = await provisionDomainRepo({
      baseUrl: "https://gitea.test",
      pat: SECRET_PAT,
      org: "opencoo",
      slug: "wiki-main",
      domainClass: "knowledge",
      defaultLocale: "en",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // repoUrl falls back to deterministic concat of base + org + slug.
    expect(result.repoUrl).toBe("https://gitea.test/opencoo/wiki-main");
  });
});

describe("provisionDomainRepo — PAT scrub", () => {
  it("never includes the PAT in a thrown error message (5xx upstream)", async () => {
    const fetchImpl = vi.fn();
    // Repo create 500 with body that echoes back the auth header value
    // (simulate a verbose / leaky upstream).
    fetchImpl.mockResolvedValueOnce(
      new Response(`upstream said: token ${SECRET_PAT} failed`, {
        status: 500,
      }),
    );
    let caught: Error | null = null;
    try {
      await provisionDomainRepo({
        baseUrl: "https://gitea.test",
        pat: SECRET_PAT,
        org: "opencoo",
        slug: "wiki-main",
        domainClass: "knowledge",
        defaultLocale: "en",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain(SECRET_PAT);
  });

  it("never includes the PAT in network-failure error messages", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(
      // Simulate a fetch-level rejection that includes the PAT in the
      // cause text — the helper must scrub before re-throwing.
      new Error(`network error contacting https://gitea.test (token ${SECRET_PAT})`),
    );
    let caught: Error | null = null;
    try {
      await provisionDomainRepo({
        baseUrl: "https://gitea.test",
        pat: SECRET_PAT,
        org: "opencoo",
        slug: "wiki-main",
        domainClass: "knowledge",
        defaultLocale: "en",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toContain(SECRET_PAT);
  });
});

describe("provisionDomainRepo — domain class shapes the seed templates", () => {
  it("knowledge-class seeds carry the basic three-file template", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      ok({ html_url: "https://gitea.test/opencoo/wiki-knowledge" }, 201),
    );
    fetchImpl.mockResolvedValueOnce(ok({ content: {} }, 201));
    fetchImpl.mockResolvedValueOnce(ok({ content: {} }, 201));
    fetchImpl.mockResolvedValueOnce(ok({ content: {} }, 201));

    await provisionDomainRepo({
      baseUrl: "https://gitea.test",
      pat: SECRET_PAT,
      org: "opencoo",
      slug: "wiki-knowledge",
      domainClass: "knowledge",
      defaultLocale: "en",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Seed bodies are base64-encoded in Gitea's API. Decode the
    // 2nd call's body to confirm the template type.
    const indexCall = fetchImpl.mock.calls[1]![1] as RequestInit;
    const indexBody = JSON.parse(String(indexCall.body)) as { content: string };
    const decoded = Buffer.from(indexBody.content, "base64").toString("utf8");
    expect(decoded).toMatch(/^# /); // markdown heading
    expect(decoded.length).toBeGreaterThan(0);
  });

  it("catalog-workflows-class seeds carry a catalog-shaped template", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      ok({ html_url: "https://gitea.test/opencoo/catalog-wf" }, 201),
    );
    fetchImpl.mockResolvedValueOnce(ok({ content: {} }, 201));
    fetchImpl.mockResolvedValueOnce(ok({ content: {} }, 201));
    fetchImpl.mockResolvedValueOnce(ok({ content: {} }, 201));

    await provisionDomainRepo({
      baseUrl: "https://gitea.test",
      pat: SECRET_PAT,
      org: "opencoo",
      slug: "catalog-wf",
      domainClass: "catalog-workflows",
      defaultLocale: "en",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const indexCall = fetchImpl.mock.calls[1]![1] as RequestInit;
    const indexBody = JSON.parse(String(indexCall.body)) as { content: string };
    const decoded = Buffer.from(indexBody.content, "base64").toString("utf8");
    // Catalog index advertises content_kind awareness.
    expect(decoded.toLowerCase()).toMatch(/catalog|workflow/);
  });
});
