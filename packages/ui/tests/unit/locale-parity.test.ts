/**
 * Cross-route locale parity test (PR-C3, wave-16).
 *
 * Asserts every English-bearing key in `en.json` has a
 * Polish-shaped counterpart in `pl.json`, tolerating the
 * proper-noun + technical-token + path-fragment allowlist baked
 * into `tools/i18n-check.ts`.
 *
 * Also verifies the i18next Polish plural-form rules resolve
 * for representative `_one` / `_few` / `_many` keys — the wave-16
 * scope-doc required `_one`/`_few`/`_many`/`_other` for every
 * count string.
 */
import { describe, expect, it } from "vitest";

import enBundle from "../../src/locales/en.json" with { type: "json" };
import plBundle from "../../src/locales/pl.json" with { type: "json" };
import {
  checkLocaleParity,
  collectLeafStrings,
} from "../../../../tools/i18n-check.js";
import i18n from "../../src/lib/i18n.js";

describe("pl.json — locale-bundle parity", () => {
  it("passes the same allowlist heuristic the CI fence uses", () => {
    const result = checkLocaleParity(
      enBundle as Record<string, unknown>,
      plBundle as Record<string, unknown>,
    );
    expect(result.untranslated).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("ships every leaf as a string (no undefined fallbacks)", () => {
    const plLeaves = collectLeafStrings(
      plBundle as Record<string, unknown>,
      "",
    );
    expect(plLeaves.length).toBeGreaterThan(700);
    for (const [, value] of plLeaves) {
      expect(typeof value).toBe("string");
    }
  });
});

describe("plural forms — i18next Polish rules", () => {
  it("renders distinct _one / _few / _many forms for count strings", async () => {
    await i18n.changeLanguage("pl");
    const one = i18n.t("outputs.bulkDelete.confirmTitle", { count: 1 });
    const few = i18n.t("outputs.bulkDelete.confirmTitle", { count: 2 });
    const many = i18n.t("outputs.bulkDelete.confirmTitle", { count: 5 });
    expect(one).toMatch(/1/);
    expect(few).toMatch(/2/);
    expect(many).toMatch(/5/);
    // The three forms must differ — confirming i18next picked up
    // the _one / _few / _many suffixes (not just _other).
    expect(one).not.toBe(few);
    expect(few).not.toBe(many);
  });

  it("renders distinct plural forms for audit-filter chip", async () => {
    await i18n.changeLanguage("pl");
    const one = i18n.t("audit.filters.actionSelected", { count: 1, n: 1 });
    const few = i18n.t("audit.filters.actionSelected", { count: 3, n: 3 });
    const many = i18n.t("audit.filters.actionSelected", {
      count: 12,
      n: 12,
    });
    expect(one).not.toBe(few);
    expect(few).not.toBe(many);
  });
});
