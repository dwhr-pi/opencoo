#!/usr/bin/env node
/**
 * Locale-bundle CI fence (PR-C3, wave-16).
 *
 * Loads `packages/ui/src/locales/{en,pl}.json` and asserts:
 *   - every leaf key in `en.json` has a counterpart in `pl.json`
 *     (missing → reported)
 *   - for every (key, plValue) where `plValue === enValue`, the
 *     `plValue` must be "Polish-shaped" (Polish diacritic OR on
 *     an allowlist: proper nouns, short technical tokens, pure
 *     interpolation templates, glob/path fragments, cron patterns,
 *     or the `_lint_translate_c3` marker). Identical-but-not-
 *     shaped → untranslated. Non-identical values are not
 *     re-checked: if the operator changed the string at all, we
 *     trust they translated it.
 *   - nothing extra in `pl.json` that isn't in `en.json`
 *     (except metadata keys like `_comment` and i18next plural
 *     suffix keys whose base exists in en)
 *
 * Exits 1 on any failure; emits a list of offending keys to
 * stderr. Wired into the `lint` job of `.github/workflows/ci.yml`
 * via the `pnpm lint:i18n` root script.
 *
 * Native-Polish-speaker review is a separate post-wave-16 PR;
 * uncertain phrasings carry a `_lint_translate_c3` marker in the
 * value so the human-review pass can grep for them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** Result of comparing an en/pl bundle pair. */
export interface ParityResult {
  readonly ok: boolean;
  readonly untranslated: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/** Recursively walk a nested JSON object collecting leaf strings. */
export function collectLeafStrings(
  obj: Record<string, unknown>,
  prefix: string,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix === "" ? k : `${prefix}.${k}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...collectLeafStrings(v as Record<string, unknown>, path));
    } else if (typeof v === "string") {
      out.push([path, v]);
    }
  }
  return out;
}

/** Polish diacritic detector — at least one of these must appear
 *  in any "real Polish" translated string. */
const POLISH_DIACRITICS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

/** Proper nouns and brand names that are spelled the same in
 *  every locale. Spelling never changes; identical-to-en is fine. */
const PROPER_NOUN_ALLOWLIST = new Set([
  "opencoo",
  "Asana",
  "Gitea",
  "Google Drive",
  "Fireflies",
  "Webhook",
  "Slack",
  "Postgres",
  "PostgreSQL",
  "Redis",
  "BullMQ",
  "n8n",
  "GitHub",
  "Worker",
  "Thinker",
  "Light",
  "Heartbeat",
  "Lint",
  "Surfacer",
  "Builder",
  "Cmd-K",
  "PAT",
  "Polski",
  "English",
  "v0.1",
]);

/** Short technical tokens that survive untranslated. Includes
 *  English loanwords that are also the canonical word in Polish
 *  technical contexts (slug, status, adapter, model, agent…). */
const TECHNICAL_TOKENS = new Set([
  // Uppercase acronyms
  "OK",
  "JSON",
  "URL",
  "ID",
  "UUID",
  "API",
  "CRON",
  "UTC",
  "USD",
  "CSV",
  "PDF",
  "CSRF",
  "MCP",
  "LLM",
  "DLQ",
  "HMAC",
  "TLS",
  "DOM",
  "ARIA",
  "SDK",
  "TTL",
  "PR-W2",
  "PR-W3",
  "PR-X3",
  // English loanwords with no Polish-native equivalent in the
  // technical register operators use. These are spelled and read
  // identically in Polish UI strings (`slug`, `adapter`,
  // `pipeline`…), so an identical-to-en value here is on purpose,
  // not a missing translation.
  "slug",
  "status",
  "adapter",
  "model",
  "pipeline",
  "agent",
  "Agent",
  "prompt",
  "Prompt",
  "alert",
  "heartbeat",
  "cron",
  "Cron",
  "guard",
  "ip:",
  "ua:",
  "daily-report",
]);

/** Keys in `pl.json` that have no en counterpart but are
 *  permitted (metadata / convention markers). */
const ALLOWED_EXTRA_KEYS = new Set(["_comment"]);

/** Pure interpolation template (e.g. `{{n}}`) or numeric format
 *  string — same in every locale. Allows a short single-letter
 *  prefix/suffix (`P{{n}}:`, `v{{version}}`) since these are
 *  structural format markers, not translatable text. */
function isPureInterpolation(value: string): boolean {
  const stripped = value.replace(/\{\{[^}]+\}\}/g, "").trim();
  if (stripped === "") return true;
  // Single-letter prefix + punctuation (e.g. "P:", "v") — structural.
  if (/^[A-Za-z][.:·]?$/.test(stripped)) return true;
  return false;
}

/** Pure glob or unix-style path fragment — `meetings/**`,
 *  `**\/foo`, `**`, etc. Mixed sentences ("e.g. meetings/**") do
 *  NOT count. */
function isPurePathOrGlob(value: string): boolean {
  return /^[a-zA-Z0-9_\-./*]+$/.test(value) && value.includes("/");
}

/** Cron-like pattern — same in every locale (5 space-separated
 *  fields, each digits or *, optionally with - , / characters). */
function isCronPattern(value: string): boolean {
  return /^[0-9*\/,\-\s]+$/.test(value) && value.includes(" ");
}

/** Is the value "Polish-shaped"? Either has a Polish diacritic or
 *  fits an allowlist heuristic so it survives un-diacritic-ed. */
export function isPolishShaped(value: string): boolean {
  // Marker explicitly placed by the LLM translation pass — the
  // human-review post-wave-16 PR will sweep for this and remove
  // it once the phrasing is confirmed.
  if (value.includes("_lint_translate_c3")) return true;
  if (POLISH_DIACRITICS.test(value)) return true;
  const trimmed = value.trim();
  if (PROPER_NOUN_ALLOWLIST.has(trimmed)) return true;
  if (TECHNICAL_TOKENS.has(trimmed)) return true;
  if (isPureInterpolation(value)) return true;
  if (isPurePathOrGlob(value)) return true;
  if (isCronPattern(value)) return true;
  // Single-word ALL-CAPS technical tokens (acronyms / SHA-shaped
  // identifiers) — survive untranslated.
  if (/^[A-Z][A-Z0-9_-]{1,8}$/.test(trimmed)) return true;
  // Numbers, version strings, em-dash placeholders.
  if (/^[\d.,vV\-—–:/]+$/.test(trimmed)) return true;
  if (trimmed === "—" || trimmed === "–" || trimmed === "") return true;
  return false;
}

/** Check parity between an en bundle and a pl bundle. */
export function checkLocaleParity(
  en: Record<string, unknown>,
  pl: Record<string, unknown>,
): ParityResult {
  const enLeaves = new Map(collectLeafStrings(en, ""));
  const plLeaves = new Map(collectLeafStrings(pl, ""));

  const untranslated: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];

  for (const [key, enValue] of enLeaves) {
    const plValue = plLeaves.get(key);
    if (plValue === undefined) {
      missing.push(key);
      continue;
    }
    // If pl identical to en AND not Polish-shaped → untranslated.
    if (plValue === enValue && !isPolishShaped(plValue)) {
      untranslated.push(key);
    }
  }

  for (const [key] of plLeaves) {
    if (enLeaves.has(key)) continue;
    // i18next plural-form suffix keys (_one / _few / _many /
    // _other / _zero / _two) have no direct en counterpart when
    // the en bundle uses `_one`/`_other` — but we always check
    // both files have a counterpart at the literal key level.
    // The audit is bidirectional, so a missing en _few is fine
    // here (we want pl to have *more* plural forms than en).
    if (/_(zero|one|two|few|many|other)$/.test(key)) {
      const base = key.replace(/_(zero|one|two|few|many|other)$/, "");
      // Accept if at least one form of the base key exists in en.
      const enHasAnyForm = Array.from(enLeaves.keys()).some(
        (k) => k === base || k.startsWith(`${base}_`),
      );
      if (enHasAnyForm) continue;
    }
    // Per-leaf segment allowlist — `_comment` etc. at any depth.
    const lastSegment = key.split(".").pop() ?? "";
    if (ALLOWED_EXTRA_KEYS.has(lastSegment)) continue;
    extra.push(key);
  }

  return {
    ok: untranslated.length === 0 && missing.length === 0 && extra.length === 0,
    untranslated,
    missing,
    extra,
  };
}

// CLI entrypoint. ESM equivalent of `if (require.main === module)`.
const isMain = (() => {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    return resolve(here) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const enPath = resolve(here, "..", "packages/ui/src/locales/en.json");
  const plPath = resolve(here, "..", "packages/ui/src/locales/pl.json");
  const enBundle = JSON.parse(readFileSync(enPath, "utf8")) as Record<
    string,
    unknown
  >;
  const plBundle = JSON.parse(readFileSync(plPath, "utf8")) as Record<
    string,
    unknown
  >;
  const result = checkLocaleParity(enBundle, plBundle);

  if (result.ok) {
    process.stdout.write(
      `i18n-check: pl.json parity OK (${
        collectLeafStrings(plBundle, "").length
      } leaves checked)\n`,
    );
    process.exit(0);
  }

  process.stderr.write("i18n-check: pl.json parity FAILED\n");
  if (result.missing.length > 0) {
    process.stderr.write(
      `  missing in pl (${result.missing.length}):\n`,
    );
    for (const k of result.missing) process.stderr.write(`    ${k}\n`);
  }
  if (result.untranslated.length > 0) {
    process.stderr.write(
      `  untranslated (${result.untranslated.length}):\n`,
    );
    for (const k of result.untranslated) process.stderr.write(`    ${k}\n`);
  }
  if (result.extra.length > 0) {
    process.stderr.write(
      `  extra in pl (${result.extra.length}):\n`,
    );
    for (const k of result.extra) process.stderr.write(`    ${k}\n`);
  }
  process.exit(1);
}
