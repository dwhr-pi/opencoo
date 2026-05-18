/**
 * Tests for `tools/i18n-check.ts` — the PR-C3 CI fence that
 * fails the build if `pl.json` carries English-shaped values for
 * keys whose English source is also non-trivial.
 *
 * Pin matrix:
 *   1. Identical key trees pass (sanity).
 *   2. A pl value that is structurally identical to the en value
 *      AND is not on the allowlist → reported as untranslated.
 *   3. A pl value with a Polish diacritic → passes.
 *   4. A pl value identical to en BUT on the proper-noun allowlist
 *      (e.g. "opencoo", "Asana", "Gitea") → passes.
 *   5. A pl value that is a single short technical token
 *      ("OK", "JSON", "URL") → passes.
 *   6. A pl value that is purely a number-format interpolation
 *      template ("{{n}}") → passes.
 *   7. A pl value that is purely a glob / path fragment
 *      ("meetings/**") → passes.
 *   8. Missing key in pl.json → reported as missing.
 *   9. Extra key in pl.json (no en counterpart) → reported as extra.
 *  10. A pl value tagged with the `_lint_translate_c3` marker
 *      passes (operator-acknowledged uncertain phrasing).
 */
import { describe, expect, it } from "vitest";

import { checkLocaleParity } from "./i18n-check.js";

describe("checkLocaleParity", () => {
  it("passes when every pl key is translated", () => {
    const en = { greeting: "Hello", farewell: "Goodbye" };
    const pl = { greeting: "Cześć", farewell: "Do widzenia" };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(true);
    expect(result.untranslated).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("reports a pl value identical to en as untranslated", () => {
    const en = { greeting: "Hello there friend" };
    const pl = { greeting: "Hello there friend" };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(false);
    expect(result.untranslated).toContain("greeting");
  });

  it("accepts a Polish-diacritic value", () => {
    const en = { greeting: "Welcome" };
    const pl = { greeting: "Witamy w aplikacji" };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(true);
  });

  it("allowlists proper nouns even when identical to en", () => {
    const en = {
      product: "opencoo",
      vendor1: "Asana",
      vendor2: "Gitea",
    };
    const pl = {
      product: "opencoo",
      vendor1: "Asana",
      vendor2: "Gitea",
    };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(true);
  });

  it("allowlists short technical tokens", () => {
    const en = { ok: "OK", fmt: "JSON", proto: "URL" };
    const pl = { ok: "OK", fmt: "JSON", proto: "URL" };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(true);
  });

  it("allowlists pure interpolation templates", () => {
    const en = { count: "{{n}}", days: "{{days}}" };
    const pl = { count: "{{n}}", days: "{{days}}" };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(true);
  });

  it("allowlists glob and path fragments", () => {
    const en = { glob: "meetings/**", placeholder: "e.g. meetings/**" };
    const pl = { glob: "meetings/**", placeholder: "e.g. meetings/**" };
    const result = checkLocaleParity(en, pl);
    // "meetings/**" is on the allowlist; "e.g. meetings/**" is not
    // a pure glob (it has English "e.g.") and must be translated.
    expect(result.untranslated).toContain("placeholder");
    expect(result.untranslated).not.toContain("glob");
  });

  it("reports keys missing in pl", () => {
    const en = { a: "Apple", b: "Banana" };
    const pl = { a: "Jabłko" };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("b");
  });

  it("reports keys extra in pl that have no en counterpart", () => {
    const en = { a: "Apple" };
    const pl = { a: "Jabłko", b: "Banan" };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(false);
    expect(result.extra).toContain("b");
  });

  it("accepts a pl value with the `_lint_translate_c3` marker", () => {
    // Operators acknowledged that the phrasing is uncertain and
    // will be revisited in the post-wave-16 native-speaker review.
    // The marker preserves the English placeholder until then;
    // the CI fence does NOT report it as untranslated.
    const en = { phrase: "An idiomatic operator-y phrase" };
    const pl = {
      phrase: "An idiomatic operator-y phrase /*_lint_translate_c3*/",
    };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(true);
  });

  it("walks nested objects (leaf-only comparison)", () => {
    const en = {
      domains: { title: "Domains", body: "Knowledge surfaces compiled." },
    };
    const pl = {
      domains: { title: "Domeny", body: "Knowledge surfaces compiled." },
    };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(false);
    expect(result.untranslated).toContain("domains.body");
  });

  it("treats `_comment` and metadata keys as allowlisted", () => {
    // The pl.json bundle currently carries a top-level `_comment`
    // string explaining the placeholder convention. Allow it.
    const en = { real: "Save changes" };
    const pl = {
      _comment: "placeholder pl bundle — see lib/i18n.ts",
      real: "Zapisz zmiany",
    };
    const result = checkLocaleParity(en, pl);
    expect(result.ok).toBe(true);
    expect(result.extra).not.toContain("_comment");
  });
});
