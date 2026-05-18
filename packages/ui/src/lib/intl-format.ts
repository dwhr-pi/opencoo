/**
 * Locale-aware formatters (PR-C3, wave-16).
 *
 * Lifted from `routes/Cost.tsx:127-153` (W9-era helpers) and
 * expanded with date / number / relative-time formatters so every
 * surface that needs an Intl call resolves through a single
 * locale-binding helper. Consumers call these with
 * `i18n.language` rather than hard-coding `en-US`.
 *
 * BCP-47 mapping: i18next's two supported locales (`en`, `pl`)
 * map onto `en-US` / `pl-PL` so number grouping matches operator
 * expectations (`1,234.56` vs `1 234,56`). Unknown codes fall
 * back to `en-US` so a missing translation never produces
 * malformed output. Currency stays USD because the engine bills
 * in USD (the dashboard semantics are always USD).
 */

/** Map an i18next locale code onto a BCP-47 tag. */
export function intlLocale(language: string): string {
  if (language.toLowerCase().startsWith("pl")) return "pl-PL";
  return "en-US";
}

/** Format a USD amount with two decimals + locale-grouped digits.
 *  Negative amounts render with a leading `-`. */
export function formatUsd(amount: number, locale: string): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}$${abs.toLocaleString(intlLocale(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a plain number with locale-appropriate grouping. */
export function formatNumber(n: number, locale: string): string {
  return n.toLocaleString(intlLocale(locale));
}

/** Format a date-time using `Intl.DateTimeFormat`. Defaults to
 *  the locale's short numeric date + short time of day — matches
 *  the density of the surfaces that previously called
 *  `toLocaleString()` (Reports run cards, Activity runs table,
 *  redaction events). */
export function formatDateTime(
  date: Date | string | number,
  locale: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = typeof date === "object" ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat(intlLocale(locale), options ?? {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(d);
}

/** Format just the time-of-day portion (replaces unparameterised
 *  `toLocaleTimeString()` calls). */
export function formatTime(
  date: Date | string | number,
  locale: string,
): string {
  const d = typeof date === "object" ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return fmt.format(d);
}

/** Format just the date portion (replaces unparameterised
 *  `toLocaleDateString()` calls). */
export function formatDate(
  date: Date | string | number,
  locale: string,
): string {
  const d = typeof date === "object" ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return fmt.format(d);
}

/** Format a date as a relative-time phrase ("3 hours ago" / "in
 *  5 minutes" / "3 godziny temu"). Picks the largest unit that
 *  produces a value ≥1.
 *
 *  `now` is injectable for deterministic tests. */
export function formatRelativeTime(
  date: Date | string | number,
  locale: string,
  now: Date = new Date(),
): string {
  const target =
    typeof date === "object" && date instanceof Date
      ? date
      : new Date(date as string | number);
  const diffSec = Math.round((target.getTime() - now.getTime()) / 1000);
  const fmt = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  });

  const abs = Math.abs(diffSec);
  if (abs < 45) return fmt.format(diffSec, "second");
  if (abs < 45 * 60) return fmt.format(Math.round(diffSec / 60), "minute");
  if (abs < 22 * 60 * 60)
    return fmt.format(Math.round(diffSec / 3600), "hour");
  if (abs < 26 * 24 * 60 * 60)
    return fmt.format(Math.round(diffSec / 86400), "day");
  if (abs < 320 * 24 * 60 * 60)
    return fmt.format(Math.round(diffSec / (86400 * 30)), "month");
  return fmt.format(Math.round(diffSec / (86400 * 365)), "year");
}
