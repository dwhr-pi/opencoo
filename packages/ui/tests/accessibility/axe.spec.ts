/**
 * @axe-core/playwright walk for the management UI.
 *
 * PR-A7 (wave-16, phase-a appendix #16). Walks every route ×
 * every primary modal × supported locales (en + pl, driven by
 * the project matrix in `playwright.config.ts`). Asserts ZERO
 * `serious` or `critical` accessibility violations per WCAG 2.2
 * AA. The job is the certification gate for the wave-16
 * accessibility floor — wave-end approval depends on this spec
 * passing.
 *
 * Hermetic-by-design: every `/api/admin/*` request is short-
 * circuited via `installAdminApiMocks(page)` against the canned
 * fixtures in `./fixtures.ts`. The engine + Postgres + Gitea
 * compose stack is NOT booted; what matters for axe is rendered
 * DOM, not live data.
 *
 * Locale switching: the playwright config emits one project per
 * locale (`axe-en`, `axe-pl`). The before-each below reads the
 * locale via `test.info().project.metadata` and writes it to
 * `localStorage.opencoo_locale` BEFORE the SPA boots, so i18n's
 * `detectLocale()` picks it up on first render.
 *
 * Bypassing the PAT-entry modal: the auth-gate reads
 * `sessionStorage.opencoo_pat`. Setting it to a non-empty test
 * value lets the SPA proceed through `_csrf` and render the
 * authed shell. The PatEntryModal itself is exercised as one of
 * the modal scenes (a fresh tab with empty sessionStorage so the
 * gating modal renders).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { installAdminApiMocks } from "./fixtures.js";

const ROUTES = [
  "domains",
  "sources",
  "agents",
  "outputs",
  "llmPolicy",
  "prompts",
  "activity",
  "review",
  "reports",
  "audit",
  "cost",
] as const;
type RouteKey = (typeof ROUTES)[number];

/** Sidebar labels per locale. Keeping them inline here lets the
 *  spec stay readable without importing the i18n JSON (which
 *  would couple the test to the runtime bundle's path layout). */
const TAB_LABELS: Record<"en" | "pl", Record<RouteKey, string>> = {
  en: {
    domains: "Domains",
    sources: "Sources",
    agents: "Agents",
    outputs: "Outputs",
    llmPolicy: "LLM policy",
    prompts: "Prompts",
    activity: "Activity",
    review: "Review",
    reports: "Reports",
    audit: "Audit",
    cost: "Cost",
  },
  pl: {
    domains: "Domeny",
    sources: "Źródła",
    agents: "Agenci",
    outputs: "Wyjścia",
    llmPolicy: "Polityka LLM",
    prompts: "Prompty",
    activity: "Aktywność",
    review: "Przegląd",
    reports: "Raporty",
    audit: "Audyt",
    cost: "Koszty",
  },
};

/** Buttons that, when clicked, open the named modal. The values
 *  are tried as accessible-name regex matches in priority order
 *  so a locale swap doesn't require touching the test wiring. */
const MODAL_OPENERS: ReadonlyArray<{
  readonly name: string;
  readonly onRoute: RouteKey;
  readonly en: RegExp;
  readonly pl: RegExp;
}> = [
  {
    name: "NewDomainModal",
    onRoute: "domains",
    en: /\+ ?new domain/i,
    pl: /\+ ?nowa domena/i,
  },
  {
    name: "NewSourceBindingModal",
    onRoute: "sources",
    en: /\+ ?new binding/i,
    pl: /\+ ?nowe (powiązanie|wiązanie)/i,
  },
  {
    name: "NewAgentInstanceModal",
    onRoute: "agents",
    en: /\+ ?new agent instance/i,
    pl: /\+ ?nowa instancja agenta/i,
  },
  {
    name: "NewOutputChannelModal",
    onRoute: "outputs",
    en: /\+ ?new output channel/i,
    pl: /\+ ?nowy kanał wyjścia/i,
  },
];

function localeFor(testInfo: import("@playwright/test").TestInfo): "en" | "pl" {
  const meta = testInfo.project.metadata as { opencooLocale?: string };
  return meta.opencooLocale === "pl" ? "pl" : "en";
}

/** Set the bypass tokens BEFORE the SPA boots so:
 *  - `detectLocale()` picks up the project locale on the very
 *    first render (the project boots into i18next with the
 *    matching language).
 *  - The auth-gate `getPat() !== null` check passes, so the
 *    PatEntryModal does not gate every spec.
 *
 *  `addInitScript` runs in every navigation context — including
 *  the one before `page.goto`. */
async function primeAuthedSession(
  page: Page,
  locale: "en" | "pl",
): Promise<void> {
  await page.addInitScript(
    ({ pat, loc }: { pat: string; loc: string }) => {
      try {
        window.sessionStorage.setItem("opencoo_pat", pat);
      } catch {
        /* sandboxed contexts — ignored, the SPA's own try/catch absorbs it */
      }
      try {
        window.localStorage.setItem("opencoo_locale", loc);
        // PR-B6 — the onboarding wizard renders inline on Domains
        // when domains.length === 0 AND not previously dismissed.
        // Our fixtures return non-empty domain rows already, but
        // we set the dismissed flag too so a flake on the route
        // list endpoint doesn't accidentally bring the wizard up
        // and shift the axe-walk surface.
        window.localStorage.setItem("opencoo_onboarding_dismissed", "1");
      } catch {
        /* same */
      }
    },
    { pat: "test-pat-bypass", loc: locale },
  );
}

/** Run axe against the current page, scoped to the document root
 *  (default). We constrain to the WCAG 2.2 AA tagset and assert
 *  zero `serious`/`critical` violations. `moderate` and `minor`
 *  are surfaced as a warning in the test report but do NOT fail
 *  the build per the wave-16 acceptance criteria. */
async function expectNoSeriousOrCritical(
  page: Page,
  context: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  if (blocking.length > 0) {
    const summary = blocking
      .map(
        (v) =>
          `  - ${v.impact}: ${v.id} (${v.help}) — ${v.nodes.length} node(s)\n` +
          v.nodes
            .map(
              (n) =>
                `      target: ${JSON.stringify(n.target)} | failure: ${n.failureSummary ?? ""}`,
            )
            .join("\n"),
      )
      .join("\n");
    throw new Error(
      `axe found ${blocking.length} serious/critical violation(s) on ${context}:\n${summary}`,
    );
  }
  // Soft-warn moderate/minor in CI logs so the wave-end gate can
  // triage them as candidate work for a follow-up PR.
  if (results.violations.length > 0) {
    console.warn(
      `[axe@${context}] ${results.violations.length} non-blocking violation(s): ` +
        results.violations.map((v) => `${v.impact}:${v.id}`).join(", "),
    );
  }
  // Force assertion so the report flags the test as "expected zero,
  // got zero" — Playwright otherwise prints nothing on a pure side-
  // effect-driven test, which can mask a no-op.
  expect(blocking.length).toBe(0);
}

/** Wait until the SPA's shell has settled. The lazy-route
 *  Suspense fallback is the route-level Skeleton, which carries
 *  aria-busy=true; we wait until no aria-busy=true element
 *  remains inside <main> AND the network has gone idle. The
 *  network-idle predicate is the secondary cue because routes
 *  like Reports / Audit fetch their data via NoticeRow-style
 *  loading text rather than aria-busy. */
async function waitForRouteReady(
  page: Page,
  tabLabel: string,
): Promise<void> {
  // The sidebar's `aria-current="page"` button is the canonical
  // signal of "this tab is now active" (Copilot triage on PR-A7).
  // Every sidebar button is visible immediately, so a visibility
  // wait is racy — we wait for the active state explicitly
  // instead. The CSS-attribute selector matches the
  // `aria-current` value the App.tsx sidebar sets on the active
  // tab.
  await page
    .locator(
      `button[aria-current="page"]:has-text("${tabLabel}")`,
    )
    .waitFor({ state: "visible", timeout: 10_000 });
  // Network-idle is a strong settle signal: every `/api/admin/*`
  // request resolves synchronously from the page.route handler so
  // the only outstanding connection should be the SSE EventSource
  // (which Playwright considers `networkidle`-compatible because
  // it's a long-poll, not a chunked-pending request).
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => {
      // Some routes keep SSE-style streams open; networkidle never
      // fires. Fall through to the aria-busy probe in that case.
    });
  await page
    .waitForFunction(
      () => {
        // The aria-busy probe is best-effort: a `<main>` landmark
        // appears once the App shell mounts (PR-A2 wave-16 wired
        // the explicit `<main aria-labelledby>`); a missing
        // landmark therefore means "still booting" and we'll
        // retry. After the landmark exists, we wait for any
        // Suspense / Skeleton `aria-busy="true"` to clear.
        const main = document.querySelector("main");
        if (!main) return false;
        const busy = document.querySelectorAll('[aria-busy="true"]').length;
        return busy === 0;
      },
      null,
      { timeout: 5_000 },
    )
    .catch(() => {
      // Some surfaces keep a transient `aria-busy` on a Field
      // validating-state that won't ever resolve in fixture mode
      // (no debounced async resolves against a 204 mock). Fall
      // through; axe will still walk the page in its current
      // state — the validating field doesn't block accessibility
      // assessment.
    });
  // Small grace so any one-shot mount transitions complete; the
  // design system's only loop is the heartbeat pulse, which axe
  // treats as static.
  await page.waitForTimeout(150);
}

// ─── Routes ───────────────────────────────────────────────────

test.describe("axe — routes", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const locale = localeFor(testInfo);
    await installAdminApiMocks(page);
    await primeAuthedSession(page, locale);
  });

  for (const tab of ROUTES) {
    test(`route: ${tab}`, async ({ page }, testInfo) => {
      const locale = localeFor(testInfo);
      const label = TAB_LABELS[locale][tab];
      await page.goto("/");
      // First load lands on Domains. Click the sidebar button to
      // navigate. For the Domains route itself this still works
      // (the button stays clickable; no nav happens).
      await page.getByRole("button", { name: label }).first().click();
      await waitForRouteReady(page, label);
      await expectNoSeriousOrCritical(page, `route:${tab}@${locale}`);
    });
  }
});

// ─── Modals ───────────────────────────────────────────────────

test.describe("axe — modals", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const locale = localeFor(testInfo);
    await installAdminApiMocks(page);
    await primeAuthedSession(page, locale);
  });

  for (const opener of MODAL_OPENERS) {
    test(`modal: ${opener.name}`, async ({ page }, testInfo) => {
      const locale = localeFor(testInfo);
      const tabLabel = TAB_LABELS[locale][opener.onRoute];
      const openerPattern = locale === "pl" ? opener.pl : opener.en;
      await page.goto("/");
      await page.getByRole("button", { name: tabLabel }).first().click();
      await waitForRouteReady(page, tabLabel);

      // Open the modal. `getByRole("button", { name })` matches
      // both `aria-label` and visible text, so the same selector
      // works for "+ New domain" / "+ Nowa domena".
      const openerBtn = page.getByRole("button", { name: openerPattern });
      await openerBtn.first().click();

      // Wait for the dialog. PR-A1 (wave-16) collapsed every modal
      // onto the native `<dialog>` shell; `role="dialog"` is the
      // canonical landmark.
      const dialog = page.getByRole("dialog").first();
      await dialog.waitFor({ state: "visible", timeout: 5_000 });
      // Allow a tick for focus-trap + initial focus to land.
      await page.waitForTimeout(100);

      await expectNoSeriousOrCritical(
        page,
        `modal:${opener.name}@${locale}`,
      );
    });
  }
});

// ─── Unauthenticated PAT-entry surface ─────────────────────────
//
// The only surface a non-operator can reach. Wave-16's
// confirmed-violation set originated here; the A1+A3 work
// already collapsed it onto the shared <dialog> shell + wired
// the aria-describedby chain. This spec keeps it on the gate.

test.describe("axe — auth surface", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const locale = localeFor(testInfo);
    await installAdminApiMocks(page);
    // NOTE: do NOT set opencoo_pat here. The PatEntryModal
    // gates render when getPat() === null.
    await page.addInitScript(
      ({ loc }: { loc: string }) => {
        try {
          window.localStorage.setItem("opencoo_locale", loc);
        } catch {
          /* same */
        }
      },
      { loc: locale },
    );
  });

  test("modal: PatEntryModal", async ({ page }, testInfo) => {
    const locale = localeFor(testInfo);
    await page.goto("/");
    const dialog = page.getByRole("dialog").first();
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(100);
    await expectNoSeriousOrCritical(page, `modal:PatEntryModal@${locale}`);
  });
});
