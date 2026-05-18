/**
 * Playwright config (PR 29 / plan #131, decision Q9 — separate
 * `e2e` tag; runs on PR + main only).
 *
 * The original e2e suite is intentionally minimal in v0.1 — the
 * UI is use-case-tested via Vitest + JSDOM, and the live-browser
 * smoke test lands in PR 32. This config exists so the
 * `test:e2e` script wires when an operator (or CI) runs it
 * locally with a Chromium binary installed.
 *
 * PR-A7 (wave-16, phase-a appendix #16) — extended with a second
 * test directory `tests/accessibility/` that hosts the
 * `@axe-core/playwright` walk. Two projects are emitted, one per
 * supported locale (en + pl); the spec sets
 * `localStorage.opencoo_locale` before each `page.goto` to drive
 * the locale switch. Single browser (chromium) — opencoo is a
 * desktop operator console. See
 * `docs/plan-appendix/phase-a-16-impeccable-ux.md` PR-A7.
 */
import { defineConfig, devices } from "@playwright/test";

// Test-only preview port + host. Hardcoded so this config does
// not touch `process.env` — the `opencoo/no-feature-env-vars`
// rule rejects new test-only env vars per the THREAT-MODEL §2
// allow-list. 5174 sits above Vite's default `5173` so a
// developer running `vite dev` for daily UI work can run the
// axe walk in parallel without a port clash.
//
// `127.0.0.1` (not `localhost`) matches the host vite-preview
// binds to in the webServer command below; on dual-stack
// systems where `localhost` resolves to `::1`, Playwright would
// otherwise dial v6 and never reach the v4-bound server
// (Copilot triage on PR-A7).
const PORT = 5174;
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  // Both the legacy `tests/e2e/` placeholder and the new
  // `tests/accessibility/` walk live under `./tests`; per-project
  // `testDir` narrows the scope each project picks up.
  testDir: "./tests",
  // Per-test cap. The axe walk does ~20 page loads per project;
  // the dominant cost is route render + axe analyse. 120s gives
  // CI a comfortable margin against cold network blips without
  // masking a regression.
  timeout: 120_000,
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  // `webServer.command` boots the built UI via `vite preview`
  // before the suite starts and tears it down at the end. The
  // accessibility job in CI builds the bundle ahead of time so
  // every retry doesn't re-bundle.
  webServer: {
    command: `pnpm exec vite preview --host ${HOST} --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    // Legacy placeholder spec keeps running on a single
    // unparameterised chromium project so the existing
    // `test:e2e` workflow shape doesn't drift.
    {
      name: "e2e-legacy",
      testDir: "./tests/e2e",
      use: { ...devices["Desktop Chrome"] },
    },
    // PR-A7 — one project per supported locale. The spec switches
    // locale by writing `localStorage.opencoo_locale` before each
    // navigation; the project name flows into the report so a
    // failure surfaces "axe@pl: route X violation Y" verbatim.
    //
    // `testMatch` is scoped to `*.spec.ts` so the Playwright
    // runner does NOT pick up A6's `contrast.test.ts` (a Vitest
    // unit test that lives in the same directory). Loading a
    // Vitest test under Playwright trips a
    // `Cannot redefine property: Symbol($$jest-matchers-object)`
    // global-state clash. The convention going forward:
    // `*.spec.ts` = Playwright; `*.test.ts` = Vitest.
    {
      name: "axe-en",
      testDir: "./tests/accessibility",
      testMatch: /\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], locale: "en-US" },
      metadata: { opencooLocale: "en" },
    },
    {
      name: "axe-pl",
      testDir: "./tests/accessibility",
      testMatch: /\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], locale: "pl-PL" },
      metadata: { opencooLocale: "pl" },
    },
  ],
});
