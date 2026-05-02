/**
 * THREAT-MODEL §3.3 security test — redaction events endpoint
 * cannot be used to reconstruct redacted content.
 *
 * Test-first artifact for PR-D (phase-a appendix #4).
 *
 * §3.3 states: "Do not log the matched content itself in
 * redaction_events — only metadata (category, byte range, pattern version)."
 *
 * This test suite:
 *   1. Constructs a synthetic event with KNOWN content + KNOWN byte ranges.
 *   2. Calls the endpoint.
 *   3. Asserts the response body cannot be used to reconstruct the
 *      original content — no source bytes, no range offsets that
 *      would permit slicing the original.
 *   4. Asserts only the COUNT of matches is returned, not the ranges.
 *   5. Asserts the response serializes to a string that does NOT
 *      contain the known sensitive content bytes.
 */
import { afterEach, describe, expect, it } from "vitest";

import { makeAdminFixture } from "./_fixture.js";

const ADMIN_PAT = "redaction-events-security-pat";

// Synthetic "source document" with known PII at known byte offsets.
// In production, the guard would have matched email addresses in this text
// and stored the byte ranges. We simulate that here.
const SYNTHETIC_SOURCE_TEXT =
  "Contact us at alice@example.com or bob@company.org for details.";
// The email "alice@example.com" occupies bytes 14..31 (0-indexed).
// The email "bob@company.org" occupies bytes 35..50 (0-indexed).
const KNOWN_BYTE_RANGES = [
  { start: 14, end: 31 }, // alice@example.com
  { start: 35, end: 50 }, // bob@company.org
];
// What the redacted bytes actually ARE (should NEVER appear in API response).
const REDACTED_CONTENT_1 = "alice@example.com";
const REDACTED_CONTENT_2 = "bob@company.org";

describe("THREAT-MODEL §3.3 — redaction events cannot reconstruct content", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it("response body does NOT contain known redacted content bytes", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // Insert a redaction_events row with the known byte ranges.
    // The "content" itself is NEVER stored — only the ranges.
    await f.raw.exec(`
      INSERT INTO redaction_events
        (pipeline, domain_id, binding_id, guard_slug, category,
         pattern_version, matched_byte_ranges, fail_mode)
      VALUES
        ('ingestion', NULL, NULL, 'guard-redaction-regex', 'pii.email',
         '1.0.0', '${JSON.stringify(KNOWN_BYTE_RANGES).replace(/'/g, "''")}',
         'transform')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    expect(res.statusCode).toBe(200);

    // The raw response body must not contain the redacted content strings.
    // If it did, an attacker with admin access could reconstruct what was
    // redacted. This check is defense-in-depth — the main invariant is
    // that the matched_byte_ranges field is stripped before serialization.
    expect(res.body).not.toContain(REDACTED_CONTENT_1);
    expect(res.body).not.toContain(REDACTED_CONTENT_2);
    expect(res.body).not.toContain(SYNTHETIC_SOURCE_TEXT);
  });

  it("response body does NOT contain matched_byte_ranges offsets (prevents slicing)", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await f.raw.exec(`
      INSERT INTO redaction_events
        (pipeline, domain_id, binding_id, guard_slug, category,
         pattern_version, matched_byte_ranges, fail_mode)
      VALUES
        ('ingestion', NULL, NULL, 'guard-redaction-regex', 'pii.email',
         '1.0.0', '${JSON.stringify(KNOWN_BYTE_RANGES).replace(/'/g, "''")}',
         'transform')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    const body = JSON.parse(res.body) as {
      events: Array<Record<string, unknown>>;
    };
    const row = body.events[0]!;

    // matchedByteRanges must not be present — having start/end offsets
    // along with knowledge of which pipeline/binding the redaction came from
    // could allow a sophisticated attacker to partially reconstruct content
    // by fetching the original source document and slicing it.
    expect("matchedByteRanges" in row).toBe(false);
    expect("matched_byte_ranges" in row).toBe(false);

    // Only the COUNT is permissible — knowing "2 emails were redacted"
    // is useful for auditing without enabling reconstruction.
    expect(row["matchedByteRangesCount"]).toBe(2);
  });

  it("response body does NOT embed start/end offset integers that match known ranges", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    // Use distinctive range values unlikely to appear in other numeric fields.
    const distinctiveRanges = [{ start: 99991, end: 99999 }];
    await f.raw.exec(`
      INSERT INTO redaction_events
        (pipeline, domain_id, binding_id, guard_slug, category,
         pattern_version, matched_byte_ranges, fail_mode)
      VALUES
        ('ingestion', NULL, NULL, 'guard-redaction-regex', 'pii.ssn',
         '2.0.0', '${JSON.stringify(distinctiveRanges).replace(/'/g, "''")}',
         'transform')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });

    // The distinctive offset values must not appear in the response body.
    expect(res.body).not.toContain("99991");
    expect(res.body).not.toContain("99999");

    // Confirm only the count appears.
    const body = JSON.parse(res.body) as {
      events: Array<{ matchedByteRangesCount: number }>;
    };
    expect(body.events[0]!.matchedByteRangesCount).toBe(1);
  });

  it("response is minimal — no fields beyond the declared metadata schema", async () => {
    const f = await makeAdminFixture();
    cleanup = f.close;
    f.gitea.responses.set(ADMIN_PAT, {
      username: "alice",
      teams: ["opencoo-admins"],
    });

    await f.raw.exec(`
      INSERT INTO redaction_events
        (pipeline, domain_id, binding_id, guard_slug, category,
         pattern_version, matched_byte_ranges, fail_mode)
      VALUES
        ('ingestion', NULL, NULL, 'guard-redaction-regex', 'pii.email',
         '1.0.0', '[{"start":1,"end":10}]',
         'transform')
    `);

    const res = await f.app.inject({
      method: "GET",
      url: "/api/admin/redaction-events",
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
    });
    const body = JSON.parse(res.body) as {
      events: Array<Record<string, unknown>>;
    };
    const row = body.events[0]!;

    // Enumerate ALLOWED keys only.
    const allowedKeys = new Set([
      "id",
      "pipeline",
      "domainId",
      "bindingId",
      "guardSlug",
      "category",
      "patternVersion",
      "matchedByteRangesCount",
      "failMode",
      "createdAt",
    ]);
    const actualKeys = Object.keys(row);
    for (const key of actualKeys) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    // Explicitly assert FORBIDDEN keys are absent.
    const forbiddenKeys = [
      "matchedByteRanges",
      "matched_byte_ranges",
      "sourceBytes",
      "source_bytes",
      "content",
      "rawContent",
      "raw_content",
      "payload",
    ];
    for (const key of forbiddenKeys) {
      expect(key in row).toBe(false);
    }
  });
});
