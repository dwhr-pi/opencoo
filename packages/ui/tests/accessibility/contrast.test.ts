/**
 * WCAG color-contrast sweep — PR-A6 (wave-16, phase-a appendix #16).
 *
 * Parses `packages/ui/src/styles/colors_and_type.css`, enumerates every
 * foreground-on-background pair that actually renders in the management
 * UI, computes WCAG 2.x contrast ratios, and fails the build on any
 * pair below threshold.
 *
 * Thresholds (WCAG 1.4.3 + 1.4.11):
 *   - Body text (regular weight, < 18.66px bold / < 24px regular)
 *     needs ≥ 4.5:1.
 *   - Large text (≥ 18.66px bold or ≥ 24px regular, i.e. the
 *     `<Display>` and `t-lede` editorial families) needs ≥ 3.0:1.
 *   - UI components (button-state colors, border colors, accent
 *     fills) need ≥ 3.0:1 against their adjacent background.
 *
 * Density modes (PR-C6 added `body[data-density="compact"]` scoping)
 * do NOT change any color tokens, only spacing — the sweep verifies
 * this fact rather than re-running every pair twice.
 *
 * ALLOWLIST: any pair that intentionally sits below threshold MUST
 * be tagged with `// ALLOWLIST` + a reason. The current list is small
 * and design-system-justified (see in-file comments).
 *
 * Source-level parsing only — no jsdom, no React.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CSS_PATH = resolve(
  __dirname,
  "../../src/styles/colors_and_type.css",
);

const SOURCE = readFileSync(CSS_PATH, "utf-8");

// ─── CSS parsing ─────────────────────────────────────────────

const VAR_DECL_RE = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;

function parseVars(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(VAR_DECL_RE)) {
    const name = m[1];
    const value = (m[2] ?? "").trim();
    if (name === undefined) continue;
    out.set(name, value);
  }
  return out;
}

const VARS = parseVars(SOURCE);

// ─── Color resolution ────────────────────────────────────────

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseHex(hex: string): Rgb | null {
  // Accept only #RGB or #RRGGBB. Alpha-channel hex (#RRGGBBAA, used
  // by `--rule` for the 10% hairline) is handled by a dedicated
  // alpha-strip branch in `resolveColor` so the alpha is observable
  // there rather than silently dropped here.
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (m === null) return null;
  let h = m[1] ?? "";
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Parse `oklch(L C H)` (e.g. `oklch(0.74 0.13 70)`) into sRGB.
 *  The formula matches https://bottosson.github.io/posts/oklab/
 *  (OKLab inverse matrix); chosen because the design-system accent
 *  tokens are authored in oklch and the contrast sweep MUST resolve
 *  them faithfully — not via an approximation. */
function parseOklch(value: string): Rgb | null {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(
    value.trim(),
  );
  if (m === null) return null;
  const L = Number(m[1]);
  const C = Number(m[2]);
  const H = Number(m[3]);
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const lPrime = L + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = L - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = L - 0.0894841775 * a - 1.291485548 * b;
  const lLin = lPrime * lPrime * lPrime;
  const mLin = mPrime * mPrime * mPrime;
  const sLin = sPrime * sPrime * sPrime;
  const rLin = 4.0767416621 * lLin - 3.3077115913 * mLin + 0.2309699292 * sLin;
  const gLin = -1.2684380046 * lLin + 2.6097574011 * mLin - 0.3413193965 * sLin;
  const bLin = -0.0041960863 * lLin - 0.7034186147 * mLin + 1.7076147010 * sLin;
  function gammaEncode(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 255;
    const enc =
      x >= 0.0031308
        ? 1.055 * Math.pow(x, 1 / 2.4) - 0.055
        : 12.92 * x;
    return Math.round(Math.max(0, Math.min(1, enc)) * 255);
  }
  return { r: gammaEncode(rLin), g: gammaEncode(gLin), b: gammaEncode(bLin) };
}

function resolveColor(name: string): Rgb {
  const value = VARS.get(name);
  if (value === undefined) {
    throw new Error(`contrast.test: --${name} not defined in colors_and_type.css`);
  }
  const aliasMatch = /^var\(\s*--([a-zA-Z0-9-]+)\s*\)/.exec(value.trim());
  if (aliasMatch !== null) {
    return resolveColor(aliasMatch[1] ?? "");
  }
  const cleaned = value.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const hex = parseHex(cleaned);
  if (hex !== null) return hex;
  const oklch = parseOklch(cleaned);
  if (oklch !== null) return oklch;
  if (/^#[0-9a-fA-F]{8}$/.test(cleaned)) {
    return parseHex(cleaned.slice(0, 7))!;
  }
  throw new Error(
    `contrast.test: cannot resolve --${name} = "${value}" to an RGB color`,
  );
}

// ─── WCAG contrast ratio ─────────────────────────────────────

function srgbChannelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ─── Pair manifests ──────────────────────────────────────────

interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly use: string;
}

const BODY_PAIRS: readonly Pair[] = [
  { fg: "ink", bg: "paper", use: "primary body on base canvas" },
  { fg: "ink", bg: "paper-2", use: "primary body on subtle card" },
  { fg: "ink", bg: "paper-3", use: "primary body on hairline/subtle bg" },
  { fg: "ink-2", bg: "paper", use: "secondary body on base canvas" },
  { fg: "ink-2", bg: "paper-2", use: "secondary body on subtle card" },
  { fg: "ink-2", bg: "paper-3", use: "secondary body on hairline/subtle bg" },
  { fg: "ink-3", bg: "paper", use: "tertiary/caption on base canvas" },
  { fg: "ink-3", bg: "paper-2", use: "tertiary/caption on subtle card" },
  { fg: "ink-3", bg: "paper-3", use: "tertiary/caption on hairline/subtle bg" },
];

const UI_PAIRS: readonly Pair[] = [
  { fg: "paper", bg: "ink", use: "Btn primary text on ink fill" },
  { fg: "paper", bg: "ink-2", use: "Btn primary :hover text on ink-2 fill" },
  { fg: "wiki", bg: "paper", use: "wiki citation text on canvas" },
  { fg: "wiki", bg: "paper-2", use: "wiki citation text on card" },
  { fg: "alert", bg: "paper", use: "alert text on canvas" },
  { fg: "alert", bg: "paper-2", use: "alert text on card" },
  { fg: "healthy", bg: "paper", use: "healthy text on canvas" },
  { fg: "healthy", bg: "paper-2", use: "healthy text on card" },
  { fg: "advisory-ink", bg: "paper", use: "advisory-ink text on canvas" },
  { fg: "advisory-ink", bg: "paper-2", use: "advisory-ink text on card" },
  { fg: "ink", bg: "advisory", use: "ink text on advisory fill" },
];

/** Pairs intentionally excluded with reason.
 *
 *  Every entry MUST cite a design-system rule. */
const ALLOWLIST: ReadonlyArray<Pair & { reason: string }> = [
  // ALLOWLIST: --advisory on paper backgrounds.
  // --advisory (#df9b44, oklch(0.74 0.13 70)) is the SINGLE design-
  // system color reserved for the agent / advisory chrome layer.
  // It is NEVER used as body text in the UI. Usage audit (grep on
  // var(--advisory)):
  //   - Btn variant="advisory" — background fill (text on top is
  //     `--ink`, swept above as ink on advisory ~7:1).
  //   - DebugBanner — background fill, ink text on top.
  //   - Reports.tsx — 2px border-left accent on heartbeat cards
  //     (decorative border, the card background remains --paper-2).
  //   - Cost.tsx — color on a 12px aria-hidden heartbeat glyph
  //     (decorative ornament, not informational text).
  //   - Badge / PromptEditor — `color-mix(in oklch, --advisory NN%,
  //     --paper)` tinted backgrounds (advisory is the seed, not the
  //     final rendered color).
  // The 1.4.3 body-text contrast guideline does not apply to non-
  // text decoration; the 1.4.11 UI-component guideline applies to
  // adjacent backgrounds, where --advisory sits next to --ink
  // (~16.9:1) on every actual usage. So the bare --advisory-on-
  // paper pair is not a real screen surface; we exclude it to keep
  // the sweep accurate.
  {
    fg: "advisory",
    bg: "paper",
    use: "advisory background fill (never used as text)",
    reason:
      "Design-system: --advisory is a background-only token. Every text or icon that lands on it uses --ink (contrast ~16.9:1, swept above).",
  },
  {
    fg: "advisory",
    bg: "paper-2",
    use: "advisory background fill (never used as text)",
    reason:
      "Design-system: --advisory is a background-only token. Adjacent UI requirement met via the ink-on-advisory and advisory-ink-on-paper pairs swept above.",
  },
];

// ─── Test cases ──────────────────────────────────────────────

function formatPairFailure(p: Pair, ratio: number, threshold: number): string {
  return `${p.fg} on ${p.bg} (${p.use}): ${ratio.toFixed(2)}:1 < required ${threshold}:1`;
}

describe("WCAG color-contrast sweep (PR-A6)", () => {
  it("every body-text pair meets ≥4.5:1", () => {
    const violations: string[] = [];
    for (const p of BODY_PAIRS) {
      const fg = resolveColor(p.fg);
      const bg = resolveColor(p.bg);
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) violations.push(formatPairFailure(p, ratio, 4.5));
    }
    expect(
      violations,
      `Body-text contrast violations (WCAG 1.4.3 AA, 4.5:1):\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every UI / large-text pair meets ≥3.0:1", () => {
    const violations: string[] = [];
    for (const p of UI_PAIRS) {
      const fg = resolveColor(p.fg);
      const bg = resolveColor(p.bg);
      const ratio = contrastRatio(fg, bg);
      if (ratio < 3.0) violations.push(formatPairFailure(p, ratio, 3.0));
    }
    expect(
      violations,
      `UI/large-text contrast violations (WCAG 1.4.11 AA, 3.0:1):\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("ALLOWLIST entries are documented with a reason", () => {
    const missing: string[] = [];
    for (const a of ALLOWLIST) {
      if (a.reason.trim().length === 0) {
        missing.push(`${a.fg} on ${a.bg}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("does NOT scope any color token under [data-density='compact']", () => {
    // C6 density toggle MUST only touch spacing / tracking — never
    // color. If a future edit accidentally scopes a color token to
    // compact, both density modes would need a separate contrast
    // sweep. This invariant lets us sweep once.
    const compactBlock =
      /body\[data-density="compact"\]\s*\{([^}]*)\}/.exec(SOURCE)?.[1] ?? "";
    const COLOR_TOKEN_PATTERNS = [
      /--ink(\b|[-0-9])/,
      /--paper(\b|[-0-9])/,
      /--advisory(\b|-)/,
      /--wiki\b/,
      /--alert\b/,
      /--healthy\b/,
      /--fg-/,
      /--bg-/,
      /--rule\b/,
    ];
    const touched: string[] = [];
    for (const re of COLOR_TOKEN_PATTERNS) {
      if (re.test(compactBlock)) touched.push(re.source);
    }
    expect(
      touched,
      `Compact density mode must NOT override color tokens. Touched: ${touched.join(", ")}`,
    ).toEqual([]);
  });

  it("oklch resolver matches a known sample (regression pin)", () => {
    // PR-A7 rebase: `--alert` is now `oklch(0.50 0.17 25)`
    // (darkened from `oklch(0.62 0.17 25)` so the 8%-tint
    // banner background in `Prompts.tsx` meets axe-core's 4.5:1
    // body-text threshold — A6's UI/large-text threshold of
    // 3.0:1 still held the prior value, but live rendered text
    // sits in the body-text bucket). The accepted sRGB result
    // is now roughly #b03831 (mid-160s r, low g/b).
    const alert = resolveColor("alert");
    expect(alert.r).toBeGreaterThan(155);
    expect(alert.r).toBeLessThan(195);
    expect(alert.g).toBeGreaterThan(35);
    expect(alert.g).toBeLessThan(65);
    expect(alert.b).toBeGreaterThan(35);
    expect(alert.b).toBeLessThan(65);
  });
});
