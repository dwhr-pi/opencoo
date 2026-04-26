// Canonical list of injection-attack categories tested by the
// corpus. Sourced from THREAT-MODEL §4.2. Order is stable —
// the generator (regen-injection-fixtures.ts) emits files in
// this order so re-runs are byte-deterministic.

export const INJECTION_CATEGORIES = [
  "direct-injection",
  "indirect-via-quoted-content",
  "cross-domain-write",
  "path-traversal",
  "unicode-homoglyph",
  "data-exfiltration",
] as const;

export type InjectionCategory = (typeof INJECTION_CATEGORIES)[number];

export const INJECTION_LOCALES = ["en", "pl"] as const;
export type InjectionLocale = (typeof INJECTION_LOCALES)[number];
