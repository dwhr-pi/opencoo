/**
 * Tests for `validateCron` — wraps `cron-parser` so the dispatcher
 * can reject malformed `agent_instances.schedule_cron` rows at boot
 * with a clear message instead of crashing later when BullMQ
 * actually tries to fire the job (PR-M2, phase-a appendix #5).
 */
import { describe, expect, it } from "vitest";

import { nextFireAt, validateCron } from "../../src/scheduler/cron-validate.js";

describe("validateCron", () => {
  it("accepts a 5-field weekday-mornings pattern", () => {
    const result = validateCron("0 8 * * 1-5");
    expect(result.valid).toBe(true);
  });

  it("accepts a daily 7am pattern", () => {
    const result = validateCron("0 7 * * *");
    expect(result.valid).toBe(true);
  });

  it("rejects garbage with a structured error", () => {
    const result = validateCron("not-a-cron");
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe("string");
  });

  it("rejects empty string", () => {
    const result = validateCron("");
    expect(result.valid).toBe(false);
  });

  it("rejects an out-of-range minute field", () => {
    const result = validateCron("99 * * * *");
    expect(result.valid).toBe(false);
  });

  it("returns a sanitized error message that does not leak the raw exception stack", () => {
    const result = validateCron("totally invalid");
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    // The error should be a single concise line, not a stack trace.
    expect(result.error).not.toMatch(/\n.*at /);
  });
});

describe("nextFireAt — UTC timezone determinism (round-3 fix #5)", () => {
  // Reference time straddles a UTC↔local-zone date boundary so the
  // "host TZ leaks into output" failure mode is observable: Jan 1 2026
  // 00:30 UTC corresponds to Dec 31 2025 19:30 EST. A `0 8 * * *`
  // pattern firing at 8am UTC vs 8am local would land on different
  // calendar days from this reference.
  const REFERENCE_UTC = new Date("2026-01-01T00:30:00.000Z");

  it("daily 8am pattern fires at 08:00 UTC regardless of host TZ", () => {
    const next = nextFireAt("0 8 * * *", REFERENCE_UTC);
    expect(next).not.toBeNull();
    if (next === null) throw new Error("unreachable");
    // ISO format renders UTC time. After 00:30 UTC on Jan 1, the next
    // 8am UTC firing is Jan 1 08:00:00 UTC — same day, regardless of
    // whether `process.env.TZ` is `UTC`, `America/New_York`, or
    // `Europe/Warsaw`.
    expect(next.toISOString()).toBe("2026-01-01T08:00:00.000Z");
  });

  it("weekday-morning pattern (0 8 * * 1-5) skips weekends in UTC", () => {
    // Saturday Jan 3 2026 12:00 UTC → next firing is Monday Jan 5 08:00 UTC.
    // If the parser used local time on a US-host clock (-5h), Saturday
    // 12:00 UTC = Saturday 07:00 local → next firing would still resolve
    // to Monday but the wall-clock alignment would drift.
    const saturday = new Date("2026-01-03T12:00:00.000Z");
    const next = nextFireAt("0 8 * * 1-5", saturday);
    expect(next).not.toBeNull();
    if (next === null) throw new Error("unreachable");
    expect(next.toISOString()).toBe("2026-01-05T08:00:00.000Z");
  });

  it("weekly Monday 9am UTC schedule is deterministic across TZs", () => {
    // From a Sunday afternoon UTC reference, the next Monday 9am UTC
    // firing must land on the following calendar Monday.
    const sunday = new Date("2026-01-04T15:00:00.000Z");
    const next = nextFireAt("0 9 * * 1", sunday);
    expect(next).not.toBeNull();
    if (next === null) throw new Error("unreachable");
    expect(next.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("returns null for an invalid pattern (graceful degradation)", () => {
    expect(nextFireAt("not-a-cron")).toBeNull();
    expect(nextFireAt("99 99 99 99 99")).toBeNull();
  });
});
