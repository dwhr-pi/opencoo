/**
 * Cross-route Display-placement test — PR-C4 (wave-16,
 * phase-a appendix #16).
 *
 * Asserts the wave-16 contract that the editorial-serif
 * `<Display>` lands in EXACTLY three places in v0.1:
 *
 *   - `routes/Reports.tsx` — heartbeat lede above the report list
 *   - `routes/Prompts.tsx` — empty-state lede when no prompt picked
 *   - `routes/Domains.tsx` — tab top-line summary
 *
 * Other routes (Activity, Sources, Outputs, Audit, Agents,
 * LlmPolicy, Review, Cost) MUST NOT render a `.t-lede` OR
 * `.t-display` element. The negative list mirrors the full set of
 * v0.1 management-console tabs minus the three approved
 * placements; if a new route is added, this list needs updating
 * (the C7 cross-route snapshot test will replace this manual
 * listing once a shared tab registry exists).
 *
 * The check is structural: we render each route with a
 * minimum-viable fetch stub and look for `.t-lede` / `.t-display`
 * elements. Both classes are counted so `<Display level={1}>`
 * sneaking into a management-console route also fails — `level=1`
 * is reserved for a future docs site, never the in-console UI.
 */
import { describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";

import { Reports } from "../../src/routes/Reports.js";
import { Prompts } from "../../src/routes/Prompts.js";
import { Domains } from "../../src/routes/Domains.js";
import { Activity } from "../../src/routes/Activity.js";
import { Sources } from "../../src/routes/Sources.js";
import { Outputs } from "../../src/routes/Outputs.js";
import { Audit } from "../../src/routes/Audit.js";
import { Agents } from "../../src/routes/Agents.js";
import { LlmPolicy } from "../../src/routes/LlmPolicy.js";
import { Review } from "../../src/routes/Review.js";
import { Cost } from "../../src/routes/Cost.js";
import { ToastProvider } from "../../src/components/Toast.js";

/** PR-B7 wired `useToast` into Outputs.tsx; any route that calls
 *  `useToast` throws if it isn't mounted under <ToastProvider>.
 *  Cheaper to wrap every route unconditionally than to maintain a
 *  per-route allow-list of which routes need the provider. */
function withToastProvider(el: ReactElement): ReactElement {
  return <ToastProvider>{el}</ToastProvider>;
}

/** Returns an empty/healthy 200 envelope for any URL the route asks for. */
function makeEmptyFetch(): typeof fetch {
  return vi.fn(async () => {
    const body = {
      rows: [],
      entries: [],
      reports: [],
      events: [],
      runs: [],
      channels: [],
      bindings: [],
      instances: [],
      ok: true,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** Counts `<Display level=2|3>` placements (`.t-lede`) inside a
 *  rendered route. The typescale class is the load-bearing marker;
 *  the tag varies because `as="p"` is legitimate in non-heading
 *  contexts (Prompts empty-pane lede, Domains tab summary). */
function countLedeNodes(container: HTMLElement): number {
  return container.querySelectorAll(".t-lede").length;
}

/** Counts `<Display level=1>` placements (`.t-display`). v0.1
 *  management-console routes MUST NOT render any — the class is
 *  reserved for a future docs site. */
function countDisplayLevel1Nodes(container: HTMLElement): number {
  return container.querySelectorAll(".t-display").length;
}

describe("Display placement contract (PR-C4, wave-16)", () => {
  it("Reports route renders exactly one <Display level=2>", () => {
    const { container } = render(
      withToastProvider(<Reports fetchImpl={makeEmptyFetch()} />),
    );
    expect(countLedeNodes(container)).toBe(1);
    // And no level=1 sneak — the display typescale is docs-site only.
    expect(countDisplayLevel1Nodes(container)).toBe(0);
  });

  it("Prompts route renders exactly one <Display level=2> (empty-state lede)", () => {
    const { container } = render(
      withToastProvider(<Prompts fetchImpl={makeEmptyFetch()} />),
    );
    expect(countLedeNodes(container)).toBe(1);
    expect(countDisplayLevel1Nodes(container)).toBe(0);
  });

  it("Domains route renders exactly one <Display level=2>", () => {
    const { container } = render(
      withToastProvider(<Domains fetchImpl={makeEmptyFetch()} />),
    );
    expect(countLedeNodes(container)).toBe(1);
    expect(countDisplayLevel1Nodes(container)).toBe(0);
  });

  it.each([
    ["Activity", Activity],
    ["Sources", Sources],
    ["Outputs", Outputs],
    ["Audit", Audit],
    ["Agents", Agents],
    ["LlmPolicy", LlmPolicy],
    ["Review", Review],
    ["Cost", Cost],
  ] as const)(
    "%s route renders NO <Display> (not a strategic placement)",
    (_label, RouteComponent) => {
      const fetchImpl = makeEmptyFetch();
      // Each route takes a `fetchImpl` test-seam prop. Cast through
      // unknown — the shared shape is { fetchImpl?: typeof fetch }
      // for every admin-API consumer.
      const { container } = render(
        withToastProvider(
          <RouteComponent
            {...({ fetchImpl } as unknown as Record<string, unknown>)}
          />,
        ),
      );
      // Reject BOTH t-lede (levels 2/3) and t-display (level 1) so
      // any sneaky <Display level={1}> in a non-approved route also
      // fails — addresses Copilot's level-1 unguarded concern.
      expect(countLedeNodes(container)).toBe(0);
      expect(countDisplayLevel1Nodes(container)).toBe(0);
      cleanup();
    },
  );
});
