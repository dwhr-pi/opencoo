/**
 * @opencoo/shared/prompts — Locale-keyed prompt loader. Bundles
 * Polish + English prompt bodies for the v0.1 ingestion pipelines
 * (classifier today; compiler / lint reuse the same loader in
 * subsequent PRs).
 *
 * Locale fallback (per Q7): `auto` → `en` with a one-time warn.
 * Unknown locales also fall back to `en` with a warn so a typo in
 * `domains.locale` doesn't crash the pipeline.
 */
import { describe, it, expect } from "vitest";

import {
  loadPrompt,
  PROMPT_NAMES,
  PROMPT_LOCALES,
  type PromptName,
  type PromptLocale,
} from "../src/prompts/index.js";

describe("@opencoo/shared/prompts — module shape", () => {
  it("exports loadPrompt as a function", () => {
    expect(typeof loadPrompt).toBe("function");
  });

  it("PROMPT_NAMES is a non-empty const tuple including 'classifier' and 'compiler'", () => {
    expect(PROMPT_NAMES.length).toBeGreaterThan(0);
    expect(PROMPT_NAMES).toContain("classifier");
    expect(PROMPT_NAMES).toContain("compiler");
  });

  it("PROMPT_LOCALES includes 'en', 'pl', and 'auto'", () => {
    expect(PROMPT_LOCALES).toContain("en");
    expect(PROMPT_LOCALES).toContain("pl");
    expect(PROMPT_LOCALES).toContain("auto");
  });

  it("type aliases compile against literals", () => {
    const n: PromptName = "classifier";
    const l: PromptLocale = "en";
    expect([n, l]).toEqual(["classifier", "en"]);
  });
});

describe("loadPrompt — bundled prompts", () => {
  it("returns the English classifier prompt for locale='en'", () => {
    const p = loadPrompt({ name: "classifier", locale: "en" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("en");
    expect(p.name).toBe("classifier");
  });

  it("returns the Polish classifier prompt for locale='pl'", () => {
    const p = loadPrompt({ name: "classifier", locale: "pl" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("pl");
  });

  it("locale='auto' falls back to 'en' (Q7)", () => {
    const p = loadPrompt({ name: "classifier", locale: "auto" });
    expect(p.locale).toBe("en");
    expect(p.fallbackApplied).toBe(true);
  });

  it("unknown locale falls back to 'en' (defensive)", () => {
    const p = loadPrompt({
      name: "classifier",
      // Cast to bypass the literal check; the loader has to cope
      // with stored values that drift from the type.
      locale: "klingon" as unknown as PromptLocale,
    });
    expect(p.locale).toBe("en");
    expect(p.fallbackApplied).toBe(true);
  });

  it("fallbackApplied is false for explicit en/pl", () => {
    expect(loadPrompt({ name: "classifier", locale: "en" }).fallbackApplied).toBe(false);
    expect(loadPrompt({ name: "classifier", locale: "pl" }).fallbackApplied).toBe(false);
  });
});

describe("loadPrompt — bundled compiler prompts (PR 16 / plan #72)", () => {
  it("returns the English compiler prompt for locale='en'", () => {
    const p = loadPrompt({ name: "compiler", locale: "en" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("en");
    expect(p.name).toBe("compiler");
  });

  it("returns the Polish compiler prompt for locale='pl'", () => {
    const p = loadPrompt({ name: "compiler", locale: "pl" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("pl");
  });

  it("compiler prompt anchors merged_body schema and worldview_impact field", () => {
    const en = loadPrompt({ name: "compiler", locale: "en" });
    expect(en.body.toLowerCase()).toContain("merged_body");
    expect(en.body.toLowerCase()).toContain("worldview_impact");
    // Spotlighting contract carries through to the compiler too.
    expect(en.body.toLowerCase()).toContain("source_content");
  });
});

describe("loadPrompt — version field (PR 16 / plan #72)", () => {
  it("LoadedPrompt carries a non-empty `version` string", () => {
    const p = loadPrompt({ name: "classifier", locale: "en" });
    expect(typeof p.version).toBe("string");
    expect(p.version.length).toBeGreaterThan(0);
  });

  it("the version is the same shape (semver-ish) for en + pl of the same prompt name", () => {
    const en = loadPrompt({ name: "classifier", locale: "en" });
    const pl = loadPrompt({ name: "classifier", locale: "pl" });
    // EN and PL of the same prompt name move in lockstep — they
    // are different bodies of the same logical prompt, so they
    // must share a version string. Diverging versions would let
    // an EN bugfix ship without its PL counterpart.
    expect(pl.version).toBe(en.version);
  });

  it("version persists through the auto-locale fallback path", () => {
    const auto = loadPrompt({ name: "classifier", locale: "auto" });
    const en = loadPrompt({ name: "classifier", locale: "en" });
    expect(auto.version).toBe(en.version);
  });
});

describe("loadPrompt — content invariants", () => {
  it("English classifier prompt anchors the spotlighting contract", () => {
    const p = loadPrompt({ name: "classifier", locale: "en" });
    // The prompt MUST tell the model that <source_content> is
    // untrusted user input. Otherwise downstream injection
    // defenses are weakened.
    expect(p.body.toLowerCase()).toContain("source_content");
    expect(p.body.toLowerCase()).toMatch(/untrusted|do not follow|ignore/);
  });

  it("Polish classifier prompt also anchors the spotlighting contract", () => {
    const p = loadPrompt({ name: "classifier", locale: "pl" });
    expect(p.body.toLowerCase()).toContain("source_content");
    // Same anchor in Polish: 'niezaufan' (untrusted) or
    // 'nie wykonuj' (do not execute) variants.
    expect(p.body.toLowerCase()).toMatch(/niezaufan|nie wykonuj|nie postępuj/);
  });
});

// PR 20 (plan #92, part A) — heartbeat + lint prompts join the
// loader. Same module pattern as classifier/compiler: en/pl
// bodies share a version, locale fallback applies.
describe("loadPrompt — heartbeat prompts (PR 20)", () => {
  it("PROMPT_NAMES includes 'heartbeat'", () => {
    expect(PROMPT_NAMES).toContain("heartbeat");
  });

  it("returns the English heartbeat prompt for locale='en'", () => {
    const p = loadPrompt({ name: "heartbeat", locale: "en" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("en");
    expect(p.name).toBe("heartbeat");
  });

  it("returns the Polish heartbeat prompt for locale='pl'", () => {
    const p = loadPrompt({ name: "heartbeat", locale: "pl" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("pl");
  });

  it("anchors spotlighting + 5-alert cap + lead-with-priority-1 + read-only contract", () => {
    const en = loadPrompt({ name: "heartbeat", locale: "en" });
    const body = en.body.toLowerCase();
    expect(body).toContain("source_content");
    // Read-only contract — the agent must not propose writes.
    expect(body).toMatch(/read[- ]only|do not (write|modify|edit)/);
    // Cap of 5 alerts (architecture §9.4).
    expect(body).toMatch(/\b5\b|five/);
    // Lead with priority-1.
    expect(body).toMatch(/priority[- ]?1|highest priority|lead with/);
  });

  it("Polish heartbeat prompt also anchors spotlighting + read-only", () => {
    const pl = loadPrompt({ name: "heartbeat", locale: "pl" });
    const body = pl.body.toLowerCase();
    expect(body).toContain("source_content");
    // 'tylko do odczytu' or 'nie wykonuj zapisów'
    expect(body).toMatch(/tylko do odczytu|nie zapisuj|nie modyfikuj|niezaufan/);
  });

  it("EN and PL heartbeat versions move in lockstep", () => {
    const en = loadPrompt({ name: "heartbeat", locale: "en" });
    const pl = loadPrompt({ name: "heartbeat", locale: "pl" });
    expect(pl.version).toBe(en.version);
  });

  // PR-W6 (phase-a appendix #14) — empty-wiki branch instructs
  // the LLM to surface operational-health alerts from the
  // `system-health://` envelope when the wiki is sparse. A
  // future edit that drops this guidance would silently
  // regress the empty-wiki heartbeat back to "wiki is empty"
  // alerts — snapshot the load-bearing fragments so the diff
  // surfaces in review.
  it("EN heartbeat prompt anchors the operational-health (system-health://) empty-wiki branch", () => {
    const en = loadPrompt({ name: "heartbeat", locale: "en" });
    const body = en.body;
    // Reference to the spotlight envelope source.
    expect(body).toContain("system-health://");
    // Branch trigger: page_count < 5 — the prompt has to name
    // both the field path and the cutoff so the model knows
    // when to flip kinds.
    expect(body).toContain("wiki_stats.page_count");
    expect(body).toMatch(/fewer than 5|less than 5|under 5/i);
    // Anti-regurgitation directive — the most important new
    // rule; without it the model falls back to repeating the
    // worldview placeholder.
    expect(body.toLowerCase()).toContain("regurgitate");
    // summary_kind is named so the model knows to emit it.
    expect(body).toContain("summary_kind");
    expect(body).toContain('"operational"');
  });

  it("PL heartbeat prompt mirrors the operational-health empty-wiki branch", () => {
    const pl = loadPrompt({ name: "heartbeat", locale: "pl" });
    const body = pl.body;
    expect(body).toContain("system-health://");
    expect(body).toContain("wiki_stats.page_count");
    expect(body).toContain("summary_kind");
    // Polish anti-regurgitation directive — "NIE powtarzaj"
    // ("do NOT repeat") rather than "regurgitate" since Polish
    // has no idiom for the English word.
    expect(body.toLowerCase()).toContain("nie powtarzaj");
  });
});

describe("loadPrompt — lint prompts (PR 20)", () => {
  it("PROMPT_NAMES includes 'lint'", () => {
    expect(PROMPT_NAMES).toContain("lint");
  });

  it("returns the English lint prompt for locale='en'", () => {
    const p = loadPrompt({ name: "lint", locale: "en" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("en");
    expect(p.name).toBe("lint");
  });

  it("returns the Polish lint prompt for locale='pl'", () => {
    const p = loadPrompt({ name: "lint", locale: "pl" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("pl");
  });

  it("anchors spotlighting + contradictions framing + read-only contract", () => {
    const en = loadPrompt({ name: "lint", locale: "en" });
    const body = en.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toContain("contradict");
    expect(body).toMatch(/read[- ]only|do not (write|modify|edit)/);
  });

  it("Polish lint prompt also anchors spotlighting + read-only", () => {
    const pl = loadPrompt({ name: "lint", locale: "pl" });
    const body = pl.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/tylko do odczytu|nie zapisuj|nie modyfikuj|niezaufan/);
    // Polish for "contradiction" — sprzeczność / niezgodność
    expect(body).toMatch(/sprzeczn|niezgodn/);
  });

  it("EN and PL lint versions move in lockstep", () => {
    const en = loadPrompt({ name: "lint", locale: "en" });
    const pl = loadPrompt({ name: "lint", locale: "pl" });
    expect(pl.version).toBe(en.version);
  });
});

describe("loadPrompt — chat prompts (PR 20 part B / plan #97)", () => {
  it("PROMPT_NAMES includes 'chat'", () => {
    expect(PROMPT_NAMES).toContain("chat");
  });

  it("returns the English chat prompt for locale='en'", () => {
    const p = loadPrompt({ name: "chat", locale: "en" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("en");
    expect(p.name).toBe("chat");
  });

  it("returns the Polish chat prompt for locale='pl'", () => {
    const p = loadPrompt({ name: "chat", locale: "pl" });
    expect(typeof p.body).toBe("string");
    expect(p.body.length).toBeGreaterThan(0);
    expect(p.locale).toBe("pl");
  });

  it("anchors spotlighting + read-only contract + citations-required", () => {
    const en = loadPrompt({ name: "chat", locale: "en" });
    const body = en.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/read[- ]only|do not (write|modify|edit)/);
    expect(body).toMatch(/cit(ation|e)/);
  });

  it("Polish chat prompt also anchors spotlighting + read-only", () => {
    const pl = loadPrompt({ name: "chat", locale: "pl" });
    const body = pl.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/tylko do odczytu|nie zapisuj|nie modyfikuj|niezaufan/);
    expect(body).toMatch(/cytat|cytuj|odno[sś]nik|źród/);
  });

  it("EN and PL chat versions move in lockstep", () => {
    const en = loadPrompt({ name: "chat", locale: "en" });
    const pl = loadPrompt({ name: "chat", locale: "pl" });
    expect(pl.version).toBe(en.version);
  });
});

describe("loadPrompt — surfacer prompts (PR 21 / plan #102)", () => {
  it("PROMPT_NAMES includes 'surfacer'", () => {
    expect(PROMPT_NAMES).toContain("surfacer");
  });

  it("returns en/pl bodies and a non-empty version", () => {
    const en = loadPrompt({ name: "surfacer", locale: "en" });
    const pl = loadPrompt({ name: "surfacer", locale: "pl" });
    expect(en.body.length).toBeGreaterThan(0);
    expect(pl.body.length).toBeGreaterThan(0);
    expect(en.version).toBe(pl.version);
  });

  it("anchors spotlighting + 'proposed' Gate 1 wording (no 'approved' from agent)", () => {
    const en = loadPrompt({ name: "surfacer", locale: "en" });
    const body = en.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/propos/);
    // The agent must NOT pretend to approve / activate / deploy.
    expect(body).toMatch(/do not (approve|activate|deploy)|never (approve|activate)/);
  });

  it("Polish surfacer prompt also anchors spotlighting", () => {
    const pl = loadPrompt({ name: "surfacer", locale: "pl" });
    const body = pl.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/propon|kandydat|sugest/);
    expect(body).toMatch(/niezaufan|nie wykonuj/);
  });
});

describe("loadPrompt — builder prompts (PR 21 / plan #102)", () => {
  it("PROMPT_NAMES includes 'builder'", () => {
    expect(PROMPT_NAMES).toContain("builder");
  });

  it("returns en/pl bodies and a non-empty version", () => {
    const en = loadPrompt({ name: "builder", locale: "en" });
    const pl = loadPrompt({ name: "builder", locale: "pl" });
    expect(en.body.length).toBeGreaterThan(0);
    expect(pl.body.length).toBeGreaterThan(0);
    expect(en.version).toBe(pl.version);
  });

  it("anchors spotlighting + Gate 3 (no activation / never enable workflows)", () => {
    const en = loadPrompt({ name: "builder", locale: "en" });
    const body = en.body.toLowerCase();
    expect(body).toContain("source_content");
    // Builder produces a 'deployed' workflow; activation is
    // manual operator action in n8n. The prompt must say so.
    expect(body).toMatch(/never (activate|enable|toggle)|do not (activate|enable|toggle)/);
    expect(body).toMatch(/manual|operator|n8n/);
  });

  it("Polish builder prompt also anchors Gate 3", () => {
    const pl = loadPrompt({ name: "builder", locale: "pl" });
    const body = pl.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/nigdy nie (aktyw|włącz)|nie (aktywuj|włączaj)/);
  });
});

describe("loadPrompt — worldview-domain prompts (PR 22 / plan #106)", () => {
  it("PROMPT_NAMES includes 'worldview-domain'", () => {
    expect(PROMPT_NAMES).toContain("worldview-domain");
  });

  it("returns en/pl bodies and a non-empty version", () => {
    const en = loadPrompt({ name: "worldview-domain", locale: "en" });
    const pl = loadPrompt({ name: "worldview-domain", locale: "pl" });
    expect(en.body.length).toBeGreaterThan(0);
    expect(pl.body.length).toBeGreaterThan(0);
    expect(en.version).toBe(pl.version);
  });

  it("anchors spotlighting + 24KB cap + compress-further wording", () => {
    const en = loadPrompt({ name: "worldview-domain", locale: "en" });
    const body = en.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/24[, ]?000|24kb/);
    expect(body).toMatch(/compress further|compress|kompresuj/);
  });

  it("Polish worldview-domain prompt also anchors spotlighting + cap", () => {
    const pl = loadPrompt({ name: "worldview-domain", locale: "pl" });
    const body = pl.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/niezaufan|nie wykonuj/);
    expect(body).toMatch(/24[ ,]?000|24kb/);
  });

  // PR-W6 (phase-a appendix #14) — empty-wiki branch is
  // tightened to a single sentence so the Heartbeat agent's
  // system-health snapshot dominates the prompt on empty
  // domains. Snapshot the exact sentence so a future edit
  // that re-expands the empty-wiki text lights up in review.
  it("EN worldview-domain prompt's empty-wiki branch is the tightened single sentence", () => {
    const en = loadPrompt({ name: "worldview-domain", locale: "en" });
    expect(en.body).toContain(
      "Domain has no compiled pages yet. Operator should check the Sources tab for ingestion state.",
    );
  });

  it("PL worldview-domain prompt's empty-wiki branch is the tightened single sentence", () => {
    const pl = loadPrompt({ name: "worldview-domain", locale: "pl" });
    expect(pl.body).toContain(
      "Domena nie ma jeszcze skompilowanych stron. Operator powinien sprawdzić zakładkę Sources, by zobaczyć stan przetwarzania.",
    );
  });
});

describe("loadPrompt — worldview-company prompts (PR 22 / plan #106)", () => {
  it("PROMPT_NAMES includes 'worldview-company'", () => {
    expect(PROMPT_NAMES).toContain("worldview-company");
  });

  it("returns en/pl bodies", () => {
    const en = loadPrompt({ name: "worldview-company", locale: "en" });
    const pl = loadPrompt({ name: "worldview-company", locale: "pl" });
    expect(en.body.length).toBeGreaterThan(0);
    expect(pl.body.length).toBeGreaterThan(0);
    expect(en.version).toBe(pl.version);
  });

  it("anchors sovereignty (only worldview.md inputs) + spotlighting", () => {
    const en = loadPrompt({ name: "worldview-company", locale: "en" });
    const body = en.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/worldview\.md/);
    expect(body).toMatch(/sovereignty|llm[- ]policy|boundary/);
  });

  it("Polish worldview-company prompt also anchors sovereignty", () => {
    const pl = loadPrompt({ name: "worldview-company", locale: "pl" });
    const body = pl.body.toLowerCase();
    expect(body).toContain("source_content");
    expect(body).toMatch(/suwerenność|polityk/);
  });
});
