/**
 * Per-(agent, adapter) output transformer tests (PR-W2,
 * phase-a appendix #13 — closes G2).
 *
 * Pin matrix:
 *   - Per-(agent, adapter) pair happy path.
 *   - HTML entity escaping for the five chars (& < > " ').
 *   - Sibling-not-nested rule: `<h2>` and `<ul>` live at the
 *     `<body>` level, never inside each other.
 *   - 32 KB cap enforcement on the rendered html_notes body.
 *   - Unknown-agent fallback to `mergeAsanaPayloadGeneric` /
 *     `mergeWebhookPayloadGeneric`.
 *   - `mergePayloadFor` dispatcher routing per (agent, adapter)
 *     combo.
 *   - `OutputTransformerNotFoundError` thrown when both
 *     agent-specific AND generic transformers are absent for
 *     the adapter.
 *
 * THREAT-MODEL §3.6 invariant 11: transformers see ONLY
 * `(agentOutput, channelConfig)`. There is no credential
 * surface to assert here — by design — but every test
 * asserts the produced payload contains no smuggled bytes.
 */
import { describe, expect, it } from "vitest";

import {
  OutputTransformerNotFoundError,
  escapeHtml,
  heartbeatToAsana,
  heartbeatToWebhook,
  lintToAsana,
  lintToWebhook,
  mergeAsanaPayloadGeneric,
  mergePayloadFor,
  mergeWebhookPayloadGeneric,
  surfacerToAsana,
  surfacerToWebhook,
} from "../src/provision/output-transformers.js";

const PROJECT_GID = "1214005588882595";
const CHANNEL_CONFIG = { project_gid: PROJECT_GID } as const;

describe("escapeHtml", () => {
  it("escapes the standard five entity chars", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes only HTML-significant chars (passes through unicode)", () => {
    expect(escapeHtml("Łódź — ąęć")).toBe("Łódź — ąęć");
  });
});

describe("heartbeatToAsana", () => {
  it("happy path: alerts become sibling h2 + p + ul", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        version: "1.0",
        summary: "Two alerts today",
        alerts: [
          {
            priority: 1,
            title: "Q3 deck slipping",
            body: "Sales asked for the deck on 2026-09-30.",
            citations: ["wiki-executive/q3-plan.md"],
          },
          {
            priority: 2,
            title: "Hiring pause",
            body: "Operations froze new hires this week.",
            citations: [
              "wiki-hr/headcount.md",
              "wiki-ops/budget-2026.md",
            ],
          },
        ],
      },
    });
    expect(payload.projectGid).toBe(PROJECT_GID);
    expect(payload.title).toBe("Two alerts today");
    expect(payload.htmlNotes).toBeDefined();
    expect(payload.notes).toBeUndefined();
    const html = payload.htmlNotes!;
    // Root is <body>.
    expect(html.startsWith("<body>")).toBe(true);
    expect(html.endsWith("</body>")).toBe(true);
    // Each alert produces one h2, one p, one ul.
    expect(html.match(/<h2>/g)?.length).toBe(2);
    expect(html.match(/<p>/g)?.length).toBe(2);
    expect(html.match(/<ul>/g)?.length).toBe(2);
    // Specific content present.
    expect(html).toContain("Q3 deck slipping");
    expect(html).toContain("wiki-executive/q3-plan.md");
  });

  it("siblings rule: h2 NEVER appears inside ul, ul NEVER appears inside h2", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "x",
        alerts: [
          {
            title: "T1",
            body: "B1",
            citations: ["c1", "c2"],
          },
        ],
      },
    });
    const html = payload.htmlNotes!;
    expect(html).not.toMatch(/<ul>[\s\S]*<h2>[\s\S]*<\/h2>[\s\S]*<\/ul>/);
    expect(html).not.toMatch(/<h2>[\s\S]*<ul>[\s\S]*<\/ul>[\s\S]*<\/h2>/);
    expect(html).not.toMatch(/<li>[\s\S]*<h2>/);
  });

  it("HTML escapes alert body text — & < > \" ' are not interpreted as tags", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "s",
        alerts: [
          {
            title: "<script>alert(1)</script>",
            body: "Q3 R&D plan — \"high\" priority; what's next?",
            citations: ["a<b>c"],
          },
        ],
      },
    });
    const html = payload.htmlNotes!;
    // Smuggled <script> in title is escaped — no raw <script> appears.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    // & " ' all escaped in body.
    expect(html).toContain("R&amp;D");
    expect(html).toContain("&quot;high&quot;");
    expect(html).toContain("what&#39;s next");
    // Citation `<` is escaped.
    expect(html).toContain("a&lt;b&gt;c");
  });

  it("renders empty-alerts case with a default <p>", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "", alerts: [] },
    });
    expect(payload.htmlNotes).toContain("<p>No alerts today.</p>");
    // Empty summary → fallback ISO-date title.
    expect(payload.title).toMatch(/^opencoo heartbeat — \d{4}-\d{2}-\d{2}$/);
  });

  it("title caps at 500 chars", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "x".repeat(700), alerts: [] },
    });
    expect(payload.title.length).toBe(500);
  });

  it("forwards assignee_gid from channel config when present", () => {
    const payload = heartbeatToAsana({
      channelConfig: { project_gid: PROJECT_GID, assignee_gid: "u-42" },
      agentOutput: { summary: "s", alerts: [] },
    });
    expect(payload.assigneeGid).toBe("u-42");
  });

  it("omits assignee_gid when the channel config field is missing or empty", () => {
    const payload = heartbeatToAsana({
      channelConfig: { project_gid: PROJECT_GID, assignee_gid: "" },
      agentOutput: { summary: "s", alerts: [] },
    });
    expect(payload.assigneeGid).toBeUndefined();
  });

  it("throws when channel config is missing project_gid", () => {
    expect(() =>
      heartbeatToAsana({
        channelConfig: {} as never,
        agentOutput: { summary: "s", alerts: [] },
      }),
    ).toThrow(/project_gid/);
  });

  it("caps total html_notes at 32 KB", () => {
    // Build an output that produces an html_notes body larger
    // than the 32 KB cap. ~33 KB body of repeated alert text.
    const giantBody = "x".repeat(50_000);
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "huge",
        alerts: [{ title: "t", body: giantBody, citations: [] }],
      },
    });
    expect(payload.htmlNotes!.length).toBeLessThanOrEqual(32_768);
  });

  // ── Copilot triage #4 — sibling-boundary truncation ────────────────
  //
  // The old byte-walk `capHtmlBody` could slice the final `</body>`
  // close in half and could cut mid-HTML-entity (e.g. between
  // `&amp` and `;`), producing invalid XML that Asana 400s on.
  // The replacement truncates at SIBLING boundaries with a
  // reserved budget for the wrapper + a marker. These tests pin
  // that contract.

  it("truncates at sibling boundaries — never splits a tag or entity", () => {
    // A small first sibling (h2) + a giant second sibling (p) that
    // pushes the running total over the cap. The truncation must
    // drop the giant <p> wholesale, not slice into it.
    const giantBody = "x".repeat(50_000);
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "huge",
        alerts: [{ title: "T", body: giantBody, citations: [] }],
      },
    });
    const html = payload.htmlNotes!;
    // Body wrapper intact — the closing tag wasn't sliced.
    expect(html.startsWith("<body>")).toBe(true);
    expect(html.endsWith("</body>")).toBe(true);
    // No bare half-tag (we'd see e.g. `<p` without a closing `>`).
    expect(html).not.toMatch(/<[a-zA-Z][^>]*$/);
    // No half-escaped entity (e.g. `&am` or `&amp` without `;`).
    expect(html).not.toMatch(/&[a-zA-Z]+$/);
    // The small first sibling survived.
    expect(html).toContain("<h2>T</h2>");
    // The giant body was dropped wholesale — no run of 1000 xs.
    expect(html).not.toMatch(/x{1000}/);
  });

  it("appends a truncation marker when at least one sibling was dropped", () => {
    const giantBody = "x".repeat(50_000);
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "huge",
        alerts: [{ title: "T", body: giantBody, citations: [] }],
      },
    });
    expect(payload.htmlNotes!).toContain("<p>(truncated…)</p>");
  });

  it("does NOT add a truncation marker when content fits under the cap", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "small",
        alerts: [{ title: "T", body: "B", citations: ["c1"] }],
      },
    });
    expect(payload.htmlNotes!).not.toContain("(truncated");
  });

  it("produces a parseable body — open/close tag counts balance, no half-tags", () => {
    // Use many medium siblings so the cap kicks in mid-stream and
    // we can verify the surviving HTML is well-formed.
    const alerts = Array.from({ length: 200 }, (_, i) => ({
      title: `Alert ${i}`,
      body: "y".repeat(400),
      citations: ["c"],
    }));
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "many", alerts },
    });
    const html = payload.htmlNotes!;
    // Under cap.
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(32_768);
    // Body wrapper intact.
    expect(html.startsWith("<body>")).toBe(true);
    expect(html.endsWith("</body>")).toBe(true);
    // Each opening tag has its closing pair.
    const countTag = (re: RegExp): number => (html.match(re) ?? []).length;
    expect(countTag(/<h2>/g)).toBe(countTag(/<\/h2>/g));
    expect(countTag(/<p>/g)).toBe(countTag(/<\/p>/g));
    expect(countTag(/<ul>/g)).toBe(countTag(/<\/ul>/g));
    expect(countTag(/<li>/g)).toBe(countTag(/<\/li>/g));
    expect(countTag(/<body>/g)).toBe(1);
    expect(countTag(/<\/body>/g)).toBe(1);
    // Truncation marker present (we built much more than 32 KB
    // of siblings).
    expect(html).toContain("<p>(truncated…)</p>");
  });
});

describe("lintToAsana", () => {
  it("renders findings as sibling h2/p/ul triples", () => {
    const payload = lintToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        findings: [
          {
            kind: "contradiction",
            title: "Two sources disagree",
            body: "wiki-hr says X; wiki-ops says Y.",
            citations: ["wiki-hr/x.md", "wiki-ops/y.md"],
          },
        ],
      },
    });
    expect(payload.title).toMatch(/^Wiki lint findings — \d{4}-\d{2}-\d{2}$/);
    const html = payload.htmlNotes!;
    expect(html.startsWith("<body>")).toBe(true);
    expect(html).toContain("<h2>Two sources disagree</h2>");
    expect(html).toContain("<li>wiki-hr/x.md</li>");
  });

  it("renders empty-findings case with a default <p>", () => {
    const payload = lintToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { findings: [] },
    });
    expect(payload.htmlNotes).toContain("No findings.");
  });

  it("escapes finding title + body", () => {
    const payload = lintToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        findings: [
          {
            title: "<img src=x>",
            body: "edge & corner",
          },
        ],
      },
    });
    expect(payload.htmlNotes).not.toContain("<img");
    expect(payload.htmlNotes).toContain("&lt;img");
    expect(payload.htmlNotes).toContain("edge &amp; corner");
  });
});

describe("surfacerToAsana", () => {
  it("uses topic as title and renders rationale + citations", () => {
    const payload = surfacerToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        topic: "Automate weekly digest",
        rationale: "Sales asked for a digest in 4 of last 6 standups.",
        citations: ["wiki-executive/standup-2026-04-30.md"],
      },
    });
    expect(payload.title).toBe("Automate weekly digest");
    expect(payload.htmlNotes).toContain("<h2>Rationale</h2>");
    expect(payload.htmlNotes).toContain("<h2>Citations</h2>");
  });

  it("falls back to title or summary when topic is missing", () => {
    const t = surfacerToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { title: "T1", rationale: "r" },
    });
    expect(t.title).toBe("T1");
    const s = surfacerToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "S1", rationale: "r" },
    });
    expect(s.title).toBe("S1");
  });

  it("renders a default <p> when no rationale or citations are present", () => {
    const payload = surfacerToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { topic: "t" },
    });
    expect(payload.htmlNotes).toContain("Surfacer produced no rationale");
  });
});

describe("heartbeat/lint/surfacer → webhook (pass-through)", () => {
  it("heartbeat: wraps output in {event, data}", () => {
    const out = { summary: "s", alerts: [] };
    expect(heartbeatToWebhook({ channelConfig: {}, agentOutput: out })).toEqual({
      event: "agent.run.completed",
      data: out,
    });
  });

  it("lint: pass-through", () => {
    const out = { findings: [{ title: "x" }] };
    expect(lintToWebhook({ channelConfig: {}, agentOutput: out })).toEqual({
      event: "agent.run.completed",
      data: out,
    });
  });

  it("surfacer: pass-through", () => {
    const out = { topic: "t" };
    expect(surfacerToWebhook({ channelConfig: {}, agentOutput: out })).toEqual({
      event: "agent.run.completed",
      data: out,
    });
  });
});

describe("generic fallbacks", () => {
  it("mergeAsanaPayloadGeneric: pretty-prints JSON in notes (NOT htmlNotes)", () => {
    const payload = mergeAsanaPayloadGeneric({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { foo: "bar", arr: [1, 2] },
    });
    expect(payload.notes).toBeDefined();
    expect(payload.htmlNotes).toBeUndefined();
    expect(payload.notes!).toContain('"foo": "bar"');
  });

  it("mergeAsanaPayloadGeneric: uses summary as title when present", () => {
    const payload = mergeAsanaPayloadGeneric({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "from-generic" },
    });
    expect(payload.title).toBe("from-generic");
  });

  it("mergeAsanaPayloadGeneric: falls back to generic label when summary missing", () => {
    const payload = mergeAsanaPayloadGeneric({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {},
    });
    expect(payload.title).toBe("opencoo daily report");
  });

  it("mergeWebhookPayloadGeneric: returns {event, data}", () => {
    const out = { random: "thing" };
    expect(
      mergeWebhookPayloadGeneric({ channelConfig: {}, agentOutput: out }),
    ).toEqual({ event: "agent.run.completed", data: out });
  });
});

describe("mergePayloadFor dispatcher", () => {
  it("routes (heartbeat, asana) to heartbeatToAsana (htmlNotes set)", () => {
    const payload = mergePayloadFor({
      agentSlug: "heartbeat",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "x", alerts: [] },
    }) as { htmlNotes?: string; notes?: string };
    expect(payload.htmlNotes).toBeDefined();
    expect(payload.notes).toBeUndefined();
  });

  it("routes (lint, asana) to lintToAsana (htmlNotes set)", () => {
    const payload = mergePayloadFor({
      agentSlug: "lint",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { findings: [] },
    }) as { htmlNotes?: string; title?: string };
    expect(payload.htmlNotes).toBeDefined();
    expect(payload.title).toMatch(/^Wiki lint findings/);
  });

  it("routes (surfacer, asana) to surfacerToAsana", () => {
    const payload = mergePayloadFor({
      agentSlug: "surfacer",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { topic: "T" },
    }) as { htmlNotes?: string; title?: string };
    expect(payload.title).toBe("T");
    expect(payload.htmlNotes).toBeDefined();
  });

  it("routes (heartbeat, webhook) to heartbeatToWebhook", () => {
    const payload = mergePayloadFor({
      agentSlug: "heartbeat",
      adapterSlug: "webhook",
      channelConfig: {},
      agentOutput: { x: 1 },
    });
    expect(payload).toEqual({ event: "agent.run.completed", data: { x: 1 } });
  });

  it("unknown-agent fallback to mergeAsanaPayloadGeneric for asana", () => {
    const payload = mergePayloadFor({
      agentSlug: "unknown-agent",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "s" },
    }) as { notes?: string; htmlNotes?: string };
    // Generic uses `notes`, NOT `htmlNotes` — that's the
    // distinguishing fingerprint of the fallback path.
    expect(payload.notes).toBeDefined();
    expect(payload.htmlNotes).toBeUndefined();
  });

  it("unknown-agent fallback to mergeWebhookPayloadGeneric for webhook", () => {
    const payload = mergePayloadFor({
      agentSlug: "unknown",
      adapterSlug: "webhook",
      channelConfig: {},
      agentOutput: { foo: 1 },
    });
    expect(payload).toEqual({
      event: "agent.run.completed",
      data: { foo: 1 },
    });
  });

  it("empty agentSlug routes to the generic fallback (not the heartbeat closure)", () => {
    // The generic fallback fingerprint is `notes` (JSON dump);
    // the agent-specific fingerprint is `htmlNotes`. An empty
    // agentSlug must NOT accidentally hit `TRANSFORMERS[""]`
    // (which is undefined) — it must traverse to the generic
    // adapter-level fallback.
    const payload = mergePayloadFor({
      agentSlug: "",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "s" },
    }) as { notes?: string; htmlNotes?: string };
    expect(payload.notes).toBeDefined();
    expect(payload.htmlNotes).toBeUndefined();
  });

  it("throws OutputTransformerNotFoundError when neither agent-specific nor generic is registered", () => {
    expect(() =>
      mergePayloadFor({
        agentSlug: "heartbeat",
        adapterSlug: "unknown-adapter",
        channelConfig: {},
        agentOutput: {},
      }),
    ).toThrow(OutputTransformerNotFoundError);
  });
});
