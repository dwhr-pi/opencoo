/**
 * `GET /api/admin/llm-usage-debug` — read-only "what was actually
 * sent" surface for the Prompts UI debug drawer (PR-W7a, phase-a
 * appendix #15).
 *
 * Coverage:
 *  - happy path: returns the N most-recent rows for the
 *    (promptName, domainId) pair, mapped to the response shape
 *  - empty result: returns `{rows: []}` (not 404)
 *  - LLM_DEBUG_LOG=0: short-circuits to `{rows: [], hint: ...}`
 *  - 400 on invalid promptName (not in PROMPT_NAMES)
 *  - 400 on malformed domainId (non-UUID)
 *  - prefix match: a `compiler-asana-project` pipeline_or_agent
 *    row surfaces under `promptName=compiler` (Copilot triage:
 *    test name reads "prefix-matched", not "suffix-matched")
 *  - admin-team gate: 401 without PAT, 403 for outsider
 *  - prompt_text truncation: a >50KB body returns at-most-50KB
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

async function setupAdmin(
  fixture: Awaited<ReturnType<typeof makeAdminFixture>>,
): Promise<void> {
  fixture.gitea.responses.set("admin-pat", {
    username: "alice",
    teams: ["opencoo-admins"],
  });
}

async function seedDomain(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  slug: string = "exec",
): Promise<{ readonly id: string }> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO domains (slug, name, locale) VALUES ($1, $2, 'en') RETURNING id`,
    [slug, slug],
  );
  return { id: result.rows[0]!.id };
}

interface SeededUsage {
  readonly usageId: string;
}

async function seedUsageWithDebug(
  raw: Awaited<ReturnType<typeof makeAdminFixture>>["raw"],
  args: {
    domainId: string;
    pipelineOrAgent: string;
    model?: string;
    promptText?: string;
    timestamp?: Date;
  },
): Promise<SeededUsage> {
  const ts = args.timestamp ?? new Date();
  const r = await raw.query<{ id: string }>(
    `INSERT INTO llm_usage
       (engine, tier, model, pipeline_or_agent, domain_id, tokens_in,
        tokens_out, cost_usd, latency_ms, "timestamp", created_at)
     VALUES ('ingestion', 'worker', $1, $2, $3, 0, 0, 0, 0, $4, $4)
     RETURNING id::text AS id`,
    [args.model ?? "gpt-4o", args.pipelineOrAgent, args.domainId, ts],
  );
  const usageId = r.rows[0]!.id;
  await raw.query(
    `INSERT INTO llm_usage_debug
       (usage_id, prompt_text, response_text, created_at)
     VALUES ($1, $2, $3, $4)`,
    [usageId, args.promptText ?? "the body", "the response", ts],
  );
  return { usageId };
}

describe("admin-api GET /api/admin/llm-usage-debug (PR-W7a)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("returns the N most-recent rows for (promptName, domainId)", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);

    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-02T00:00:00Z");
    const t2 = new Date("2026-01-03T00:00:00Z");
    await seedUsageWithDebug(f.raw, {
      domainId,
      pipelineOrAgent: "heartbeat",
      promptText: "OLD",
      timestamp: t0,
    });
    await seedUsageWithDebug(f.raw, {
      domainId,
      pipelineOrAgent: "heartbeat",
      promptText: "MIDDLE",
      timestamp: t1,
    });
    await seedUsageWithDebug(f.raw, {
      domainId,
      pipelineOrAgent: "heartbeat",
      promptText: "NEWEST",
      timestamp: t2,
    });

    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=heartbeat&domainId=${domainId}&limit=2`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ promptTextTruncated: string; modelSlug: string }>;
    };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]!.promptTextTruncated).toBe("NEWEST");
    expect(body.rows[1]!.promptTextTruncated).toBe("MIDDLE");
    expect(body.rows[0]!.modelSlug).toBe("gpt-4o");
  });

  it("returns an empty rows array when no debug rows match", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=lint&domainId=${domainId}`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("short-circuits with a hint when LLM_DEBUG_LOG=1 is not set", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: false,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    await seedUsageWithDebug(f.raw, {
      domainId,
      pipelineOrAgent: "heartbeat",
      promptText: "should-not-leak",
    });
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=heartbeat&domainId=${domainId}`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[]; hint: string };
    expect(body.rows).toEqual([]);
    expect(body.hint).toMatch(/LLM_DEBUG_LOG/);
  });

  it("rejects an invalid promptName with 400", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=not-a-prompt&domainId=${domainId}`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("validation_failed");
  });

  it("rejects a non-UUID domainId with 400", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=heartbeat&domainId=not-a-uuid`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("validation_failed");
  });

  it("surfaces prefix-matched pipelineOrAgent under the parent promptName", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    await seedUsageWithDebug(f.raw, {
      domainId,
      pipelineOrAgent: "compiler-asana-project",
      promptText: "asana-body",
    });
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=compiler&domainId=${domainId}`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ promptTextTruncated: string }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.promptTextTruncated).toBe("asana-body");
  });

  it("does NOT cross-match unrelated prefixes (linter-x is not lint)", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    await seedUsageWithDebug(f.raw, {
      domainId,
      pipelineOrAgent: "linter-x",
      promptText: "wrong-row",
    });
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=lint&domainId=${domainId}`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("preserves authored U+FFFD characters within a body that fits the cap", async () => {
    // Pins the Copilot-triage fix on PR #149: the prior
    // truncateUtf8 stripped trailing U+FFFD bytes
    // unconditionally; the code-point-walking variant only
    // truncates when the body would exceed the cap.
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const authored = "prefix ��";
    await seedUsageWithDebug(f.raw, {
      domainId,
      pipelineOrAgent: "heartbeat",
      promptText: authored,
    });
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=heartbeat&domainId=${domainId}`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ promptTextTruncated: string }>;
    };
    expect(body.rows[0]!.promptTextTruncated).toBe(authored);
  });

  it("truncates oversized prompt_text bodies to at most 50 KB", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    await setupAdmin(f);
    const { id: domainId } = await seedDomain(f.raw);
    const oversized = "a".repeat(60_000);
    await seedUsageWithDebug(f.raw, {
      domainId,
      pipelineOrAgent: "heartbeat",
      promptText: oversized,
    });
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=heartbeat&domainId=${domainId}`,
      headers: { authorization: "Bearer admin-pat" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rows: Array<{ promptTextTruncated: string }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]!.promptTextTruncated.length).toBeLessThanOrEqual(50_000);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    const { id: domainId } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=heartbeat&domainId=${domainId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-admin caller with 403", async () => {
    const f = await makeAdminFixture({
      adminTeamSlug: "opencoo-admins",
      llmDebugLog: true,
    });
    cleanup = f.close;
    f.gitea.responses.set("outsider-pat", {
      username: "mallory",
      teams: ["some-other-team"],
    });
    const { id: domainId } = await seedDomain(f.raw);
    const res = await f.app.inject({
      method: "GET",
      url: `/api/admin/llm-usage-debug?promptName=heartbeat&domainId=${domainId}`,
      headers: { authorization: "Bearer outsider-pat" },
    });
    expect(res.statusCode).toBe(403);
  });
});
