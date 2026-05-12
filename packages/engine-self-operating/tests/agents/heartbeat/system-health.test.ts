/**
 * `gatherSystemHealth` unit tests (PR-W6, phase-a appendix #14).
 *
 * The gatherer is a pure read-side aggregator that powers the
 * Heartbeat agent's empty-wiki / operational-health prompt
 * branch. It reads ONLY from the heartbeat's scope domain — a
 * row in domain X must NOT surface when scope is [Y]. This is
 * the data-sovereignty boundary (architecture.md §9.5) and the
 * scope-filter test below is load-bearing for that invariant.
 *
 * Invariants pinned here:
 *   1. Shape: returns `intake_counts`, `intake_failures_recent`,
 *      `source_bindings`, `recent_agent_runs`, `wiki_stats`.
 *   2. Scope: a binding/intake/run row outside the heartbeat's
 *      scope is invisible to the gatherer.
 *   3. error_text_snippet truncated to 200 chars BEFORE leaving
 *      the gatherer (defense against prompt-injection in error
 *      messages).
 *   4. Empty-domain case: all counters zero, all arrays empty,
 *      no errors thrown.
 *   5. `intake_status='failed'` recognised via `status::text =
 *      'failed'` comparison — enum-tolerant across the W3
 *      migration (the W6 branch doesn't depend on W3 having
 *      merged).
 */
import { describe, expect, it } from "vitest";

import { gatherSystemHealth } from "../../../src/agents/heartbeat/system-health.js";
import type { SystemHealth } from "../../../src/agents/heartbeat/system-health.js";
import {
  freshAgentDb,
  seedBinding,
} from "../../agent-harness/_pglite-fixture.js";

const NOW = new Date("2026-05-12T10:00:00Z");

interface StubWikiAdapter {
  readonly listMarkdown: (slug: string) => Promise<readonly string[]>;
  readonly readPage: (
    slug: string,
    path: string,
  ) => Promise<{ sha: string; content: string } | null>;
}

function stubWiki(opts: {
  readonly markdownPaths?: readonly string[];
  readonly worldview?: string | null;
} = {}): StubWikiAdapter {
  return {
    listMarkdown: async () => opts.markdownPaths ?? [],
    readPage: async (slug: string, path: string) => {
      // The fake adapter is domain-agnostic in tests — assert
      // a slug is passed (else the gatherer mis-wired) but
      // don't branch on its value.
      if (typeof slug !== "string") throw new Error("expected slug");
      if (path === "worldview.md") {
        return opts.worldview === null
          ? null
          : opts.worldview !== undefined
            ? { sha: "deadbeef", content: opts.worldview }
            : null;
      }
      return null;
    },
  };
}

describe("gatherSystemHealth — shape + scope + truncation", () => {
  it("returns the expected shape on a domain with bindings, intake rows, and runs", async () => {
    const fixture = await freshAgentDb();

    // Bind a source — used as scope for the gatherer's intake
    // filter and as one entry in `source_bindings[]`.
    const { bindingId } = await seedBinding(fixture, {
      adapterSlug: "drive",
      allowedPaths: ["meetings/**"],
    });
    // Pin last_scanned_at to a known instant so `hours_since_scan`
    // is deterministic against NOW.
    await fixture.raw.query(
      `UPDATE sources_bindings SET last_scanned_at = $1::timestamptz WHERE id = $2`,
      [new Date(NOW.getTime() - 4 * 3600 * 1000).toISOString(), bindingId],
    );
    // Three intake rows: 2 pending, 1 failed.
    await fixture.raw.query(
      `INSERT INTO ingestion_intake (binding_id, source_doc_id, source_revision, content_hash, status)
       VALUES ($1::uuid, 'd1', 'r1', 'h1', 'pending'),
              ($1::uuid, 'd2', 'r2', 'h2', 'pending'),
              ($1::uuid, 'd3', 'r3', 'h3', 'failed')`,
      [bindingId],
    );
    // The failed row carries a diagnostic.
    await fixture.raw.query(
      `UPDATE ingestion_intake
         SET error_class = 'validation'::error_class,
             error_text = 'binding.allowed_paths is empty'
       WHERE source_doc_id = 'd3'`,
    );

    const wiki = stubWiki({
      markdownPaths: [
        "index.md",
        "log.md",
        "schema.md",
        "worldview.md",
        "meetings/standup-2026-05.md",
        "meetings/strategy.md",
      ],
      worldview: "# Worldview\nDomain has compiled pages.",
    });

    const result: SystemHealth = await gatherSystemHealth({
      db: fixture.db as unknown as Parameters<typeof gatherSystemHealth>[0]["db"],
      scopeDomainIds: [fixture.domainId],
      domainSlug: "test-domain",
      wikiAdapter: wiki,
      now: () => NOW,
    });

    expect(result.intake_counts.pending).toBe(2);
    expect(result.intake_counts.classified).toBe(0);
    expect(result.intake_counts.skipped).toBe(0);
    expect(result.intake_counts.failed).toBe(1);

    expect(result.intake_failures_recent).toHaveLength(1);
    expect(result.intake_failures_recent[0]?.error_class).toBe("validation");
    expect(result.intake_failures_recent[0]?.error_text_snippet).toBe(
      "binding.allowed_paths is empty",
    );
    expect(result.intake_failures_recent[0]?.binding_name).toBeDefined();

    expect(result.source_bindings).toHaveLength(1);
    expect(result.source_bindings[0]?.hours_since_scan).toBe(4);
    expect(result.source_bindings[0]?.pending_count).toBe(2);
    expect(result.source_bindings[0]?.failed_count).toBe(1);

    // 6 markdown paths total minus 4 placeholders = 2 real pages.
    expect(result.wiki_stats.page_count).toBe(2);
    expect(result.wiki_stats.worldview_bytes).toBeGreaterThan(0);
  });

  it("truncates error_text_snippet to 200 chars (prompt-injection bound)", async () => {
    const fixture = await freshAgentDb();
    const { bindingId } = await seedBinding(fixture, {
      adapterSlug: "drive",
      allowedPaths: ["meetings/**"],
    });
    // Use prose-shaped bytes that scrubPat leaves alone — a
    // long sequence of alphanum > 31 chars would match the
    // generic-token rule and get redacted to `[REDACTED]`
    // (which is correct behavior for credentials, but masks
    // the cap-to-200 assertion we want here). Spaces break the
    // generic-token regex's run-length so 500 chars of "x x x"
    // survive scrub and exercise pure truncation.
    const longErr = "x ".repeat(500); // 1000 chars; expect 200-char cap.
    await fixture.raw.query(
      `INSERT INTO ingestion_intake
         (binding_id, source_doc_id, source_revision, content_hash, status, error_class, error_text)
       VALUES ($1::uuid, 'd1', 'r1', 'h1', 'failed', 'validation'::error_class, $2)`,
      [bindingId, longErr],
    );

    const result = await gatherSystemHealth({
      db: fixture.db as unknown as Parameters<typeof gatherSystemHealth>[0]["db"],
      scopeDomainIds: [fixture.domainId],
      domainSlug: "test-domain",
      wikiAdapter: stubWiki(),
      now: () => NOW,
    });

    // safeErrorMessage caps at ERROR_MESSAGE_MAX_LENGTH (200);
    // the prose-shaped bytes survive the scrub layer
    // unchanged, so the snippet is exactly 200 chars.
    expect(result.intake_failures_recent[0]?.error_text_snippet).toHaveLength(
      200,
    );
    // First 200 chars of "x x x ..." → "x x x ... x " (each
    // pair takes 2 bytes, so 100 "x " pairs fill 200 chars).
    expect(result.intake_failures_recent[0]?.error_text_snippet).toBe(
      "x ".repeat(100),
    );
  });

  // PR-W6 follow-up (Copilot #3229578187) — spotlight() handles
  // XML sentinels but does NOT scrub secrets. The gatherer is
  // the load-bearing layer for "no credentials in the LLM
  // prompt" (THREAT-MODEL §2 invariant 11). We pin the chain
  // here by seeding an error_text with three credential
  // families that `scrubPat` recognises (Bearer header, JWT,
  // 32+ alphanum token) and asserting all three are redacted
  // before the snippet reaches the gatherer's return value.
  it("scrubs credential-shaped substrings from error_text_snippet (Bearer / JWT / 32+ alphanum)", async () => {
    const fixture = await freshAgentDb();
    const { bindingId } = await seedBinding(fixture, {
      adapterSlug: "drive",
      allowedPaths: ["meetings/**"],
    });
    // Three credential shapes a deployed compile-worker could
    // conceivably surface in error_text:
    //   - Bearer header in a 401 response
    //   - JWT (three base64url-shaped segments separated by dots)
    //   - 40+ char generic API key
    const malicious = [
      "401 Unauthorized: Bearer sk-veryverysensitivekeythatleaksifnotscrubbed",
      "jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "api key abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    ].join(" | ");
    await fixture.raw.query(
      `INSERT INTO ingestion_intake
         (binding_id, source_doc_id, source_revision, content_hash, status, error_class, error_text)
       VALUES ($1::uuid, 'd-mal', 'r', 'h', 'failed', 'validation'::error_class, $2)`,
      [bindingId, malicious],
    );

    const result = await gatherSystemHealth({
      db: fixture.db as unknown as Parameters<typeof gatherSystemHealth>[0]["db"],
      scopeDomainIds: [fixture.domainId],
      domainSlug: "test-domain",
      wikiAdapter: stubWiki(),
      now: () => NOW,
    });

    const snippet = result.intake_failures_recent[0]?.error_text_snippet ?? "";
    // None of the secret bytes survive — every credential family
    // is replaced with `[REDACTED]`.
    expect(snippet).not.toContain("sk-veryverysensitivekey");
    expect(snippet).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(snippet).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(snippet).toContain("[REDACTED]");
    // Snippet still fits within the 200-char prompt-size cap.
    expect(snippet.length).toBeLessThanOrEqual(200);
  });

  it("respects scope: a binding/intake row in domain X is NOT visible when scope is [Y]", async () => {
    const fixture = await freshAgentDb();
    // Create a second domain with its OWN binding + intake row.
    const otherDomain = await fixture.raw.query<{ id: string }>(
      `INSERT INTO domains (slug, name) VALUES ('other-domain', 'Other') RETURNING id`,
    );
    const otherDomainId = otherDomain.rows[0]!.id;
    const otherBindingInsert = await fixture.raw.query<{ id: string }>(
      `INSERT INTO sources_bindings (domain_id, adapter_slug, allowed_paths, enabled)
       VALUES ($1::uuid, 'drive', ARRAY['meetings/**']::text[], true)
       RETURNING id`,
      [otherDomainId],
    );
    const otherBindingId = otherBindingInsert.rows[0]!.id;
    await fixture.raw.query(
      `INSERT INTO ingestion_intake
         (binding_id, source_doc_id, source_revision, content_hash, status, error_class, error_text)
       VALUES ($1::uuid, 'd-other', 'r1', 'h1', 'failed', 'validation'::error_class, 'should-not-leak')`,
      [otherBindingId],
    );

    // The gatherer's scope is the FIRST (default) domain only.
    const result = await gatherSystemHealth({
      db: fixture.db as unknown as Parameters<typeof gatherSystemHealth>[0]["db"],
      scopeDomainIds: [fixture.domainId],
      domainSlug: "test-domain",
      wikiAdapter: stubWiki(),
      now: () => NOW,
    });

    // The OTHER domain's binding + intake row must NOT surface.
    expect(result.source_bindings).toHaveLength(0);
    expect(result.intake_counts.failed).toBe(0);
    expect(result.intake_failures_recent).toHaveLength(0);
    // The leaked error_text from the other domain must be absent.
    for (const f of result.intake_failures_recent) {
      expect(f.error_text_snippet).not.toContain("should-not-leak");
    }
  });

  it("empty-domain case: zero counters, empty arrays, no errors", async () => {
    const fixture = await freshAgentDb();
    // Domain exists (created by freshAgentDb) but no bindings,
    // no intake rows, no agent_runs.

    const result = await gatherSystemHealth({
      db: fixture.db as unknown as Parameters<typeof gatherSystemHealth>[0]["db"],
      scopeDomainIds: [fixture.domainId],
      domainSlug: "test-domain",
      wikiAdapter: stubWiki({ markdownPaths: [], worldview: null }),
      now: () => NOW,
    });

    expect(result.intake_counts).toEqual({
      pending: 0,
      classified: 0,
      skipped: 0,
      failed: 0,
    });
    expect(result.intake_failures_recent).toEqual([]);
    expect(result.source_bindings).toEqual([]);
    expect(result.recent_agent_runs).toEqual([]);
    expect(result.wiki_stats.page_count).toBe(0);
    expect(result.wiki_stats.worldview_bytes).toBe(0);
    expect(result.wiki_stats.worldview_last_compiled_at).toBeNull();
  });

  it("intake_failures_recent caps at 3 rows even when more failed rows exist", async () => {
    const fixture = await freshAgentDb();
    const { bindingId } = await seedBinding(fixture, {
      adapterSlug: "drive",
      allowedPaths: ["meetings/**"],
    });
    // Five failed rows.
    for (let i = 0; i < 5; i++) {
      await fixture.raw.query(
        `INSERT INTO ingestion_intake
           (binding_id, source_doc_id, source_revision, content_hash, status, error_class, error_text)
         VALUES ($1::uuid, $2, 'r', 'h', 'failed', 'validation'::error_class, $3)`,
        [bindingId, `d${i}`, `err-${i}`],
      );
    }
    const result = await gatherSystemHealth({
      db: fixture.db as unknown as Parameters<typeof gatherSystemHealth>[0]["db"],
      scopeDomainIds: [fixture.domainId],
      domainSlug: "test-domain",
      wikiAdapter: stubWiki(),
      now: () => NOW,
    });
    expect(result.intake_failures_recent).toHaveLength(3);
    expect(result.intake_counts.failed).toBe(5);
  });

  it("recent_agent_runs aggregates last 24h, per agent slug, with last_failure_message", async () => {
    const fixture = await freshAgentDb();
    // Seed an agent instance so we can write agent_runs rows
    // (the FK requires it).
    const instRes = await fixture.raw.query<{ id: string }>(
      `INSERT INTO agent_instances
         (definition_slug, name, scope_domain_ids, locale, enabled)
       VALUES ('heartbeat', 'test', $1::uuid[], 'en', true)
       RETURNING id`,
      [[fixture.domainId]],
    );
    const instanceId = instRes.rows[0]!.id;
    // 2 successes, 1 failure for heartbeat WITHIN 24h.
    await fixture.raw.query(
      `INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, started_at)
       VALUES ('heartbeat', $1::uuid, 'scheduled', 'success', $2::timestamptz),
              ('heartbeat', $1::uuid, 'scheduled', 'success', $2::timestamptz),
              ('heartbeat', $1::uuid, 'scheduled', 'failed', $2::timestamptz)`,
      [instanceId, new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString()],
    );
    // The failed row gets its `output.message` filled.
    await fixture.raw.query(
      `UPDATE agent_runs
         SET output = '{"message":"LLM provider timed out"}'::jsonb
       WHERE status = 'failed' AND instance_id = $1::uuid`,
      [instanceId],
    );
    // Outside the 24h window — must NOT count.
    await fixture.raw.query(
      `INSERT INTO agent_runs (definition_slug, instance_id, trigger, status, started_at)
       VALUES ('heartbeat', $1::uuid, 'scheduled', 'failed', $2::timestamptz)`,
      [instanceId, new Date(NOW.getTime() - 36 * 3600 * 1000).toISOString()],
    );

    const result = await gatherSystemHealth({
      db: fixture.db as unknown as Parameters<typeof gatherSystemHealth>[0]["db"],
      scopeDomainIds: [fixture.domainId],
      domainSlug: "test-domain",
      wikiAdapter: stubWiki(),
      now: () => NOW,
    });

    const heartbeatRow = result.recent_agent_runs.find(
      (r) => r.agent_slug === "heartbeat",
    );
    expect(heartbeatRow).toBeDefined();
    expect(heartbeatRow?.success_count).toBe(2);
    expect(heartbeatRow?.failure_count).toBe(1);
    expect(heartbeatRow?.last_failure_message).toBe("LLM provider timed out");
  });
});
