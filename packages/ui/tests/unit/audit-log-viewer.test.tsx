/**
 * Audit-log viewer (PR-R4, phase-a appendix #10).
 *
 * Test-first artifact for the new /Audit route. The viewer is a
 * read-only consumer of `GET /api/admin/audit-log` — no backend
 * changes ship in R4. The route already returns rows sanitised
 * at write time; the UI's job is filtering, expansion, and
 * pagination.
 *
 * Pin matrix:
 *   1. Renders rows from a mocked GET response.
 *   2. Action-type multi-select narrows to selected actions.
 *   3. Actor free-text matches against caller_username substring
 *      AND against the full user UUID.
 *   4. Resource free-text matches across the metadata top-level
 *      keys (slug, binding_id, domain_id, id).
 *   5. Date-range filter excludes rows outside the from/to window.
 *   6. Pagination Next sends `?offset=50`; Prev returns to `?offset=0`.
 *   7. Row click expands an accordion that renders the full
 *      sanitised JSON in JetBrains Mono with a Copy button.
 *   8. Payloads larger than 50 KB render the "Show full" toggle.
 *   9. Empty state when zero rows match the filter.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { Audit } from "../../src/routes/Audit.js";

interface AuditFixtureRow {
  readonly id: string;
  readonly action: string;
  readonly userId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

function makeRow(overrides: Partial<AuditFixtureRow> & { id: string }): AuditFixtureRow {
  return {
    id: overrides.id,
    action: overrides.action ?? "domain.update",
    userId: overrides.userId ?? "11111111-1111-1111-1111-111111111111",
    metadata: overrides.metadata ?? {
      slug: "wiki-pilot",
      caller_username: "alice",
    },
    sourceIp: overrides.sourceIp ?? "127.0.0.1",
    userAgent: overrides.userAgent ?? "test/0.0",
    createdAt: overrides.createdAt ?? new Date("2026-05-01T10:00:00Z").toISOString(),
  };
}

function makeFetch(rowsByOffset: Record<number, AuditFixtureRow[]>): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admin/audit-log")) {
      const u = new URL(url, "http://localhost");
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const rows = rowsByOffset[offset] ?? [];
      return new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("404", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("Audit route — initial render", () => {
  it("renders rows returned by GET /api/admin/audit-log", async () => {
    const rows = [
      makeRow({ id: "r1", action: "domain.update", metadata: { slug: "wiki-pilot", caller_username: "alice" } }),
      makeRow({ id: "r2", action: "source_binding.create", metadata: { binding_id: "b-22", caller_username: "bob" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));
    expect(screen.getByText("domain.update")).toBeInTheDocument();
    expect(screen.getByText("source_binding.create")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("shows the empty state when zero rows are returned", async () => {
    const fetchImpl = makeFetch({ 0: [] });
    render(<Audit fetchImpl={fetchImpl} />);

    // PR-B3 (wave-16) — the empty-deployment + no-filters case
    // now renders the EmptyStatePanel ("No audit entries yet")
    // rather than the muted "no rows match filters" notice. The
    // legacy notice is still used when filters are active or the
    // operator paginates past page 1.
    await waitFor(() => {
      expect(
        screen.getByText(/no audit entries yet/i),
      ).toBeInTheDocument();
    });
  });
});

describe("Audit route — action filter", () => {
  it("hides rows whose action is not in the selected set", async () => {
    const rows = [
      makeRow({ id: "r1", action: "domain.update", metadata: { slug: "wiki-pilot" } }),
      makeRow({ id: "r2", action: "source_binding.create", metadata: { slug: "src-x" } }),
      makeRow({ id: "r3", action: "domain.llm_policy.apply", metadata: { slug: "wiki-pilot" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));

    // Click the action multi-select to open it, then pick only one action.
    const actionDropdown = screen.getByTestId("audit-filter-action");
    fireEvent.click(actionDropdown);

    // Pick `domain.update` from the dropdown options.
    const opt = await screen.findByTestId("audit-filter-action-option-domain.update");
    fireEvent.click(opt);

    // After selection only `domain.update` rows remain in the table.
    // (The action multi-select dropdown still lists every action seen on
    // the page so the operator can multi-pick — we assert against the
    // table body specifically, not the whole document.)
    const tableRows = screen.getAllByTestId(/^audit-row-r/);
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0]?.textContent).toContain("domain.update");
  });
});

describe("Audit route — actor filter", () => {
  it("substring-matches caller_username", async () => {
    const rows = [
      makeRow({ id: "r1", action: "domain.update", metadata: { slug: "wiki-pilot", caller_username: "alice" } }),
      makeRow({ id: "r2", action: "domain.update", metadata: { slug: "wiki-other", caller_username: "bob" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("alice"));

    const actorInput = screen.getByPlaceholderText(/username substring or user UUID/i);
    fireEvent.change(actorInput, { target: { value: "ali" } });

    expect(screen.queryByText("bob")).not.toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("exact-matches the full userId UUID", async () => {
    const aliceUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const bobUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const rows = [
      makeRow({ id: "r1", userId: aliceUuid, action: "domain.update", metadata: { slug: "wiki-pilot", caller_username: "alice" } }),
      makeRow({ id: "r2", userId: bobUuid, action: "domain.update", metadata: { slug: "wiki-other", caller_username: "bob" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("alice"));

    const actorInput = screen.getByPlaceholderText(/username substring or user UUID/i);
    fireEvent.change(actorInput, { target: { value: aliceUuid } });

    expect(screen.queryByText("bob")).not.toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });
});

describe("Audit route — resource filter", () => {
  it("matches against any of slug / binding_id / domain_id / id keys", async () => {
    const rows = [
      makeRow({ id: "r1", action: "domain.update", metadata: { slug: "wiki-pilot", caller_username: "alice" } }),
      makeRow({ id: "r2", action: "source_binding.create", metadata: { binding_id: "b-22", caller_username: "alice" } }),
      makeRow({ id: "r3", action: "domain.update", metadata: { domain_id: "d-99", caller_username: "alice" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("wiki-pilot"));

    const resourceInput = screen.getByPlaceholderText(/slug, binding id, or domain id/i);

    // Substring across `slug` field.
    fireEvent.change(resourceInput, { target: { value: "pilot" } });
    expect(screen.queryByText("b-22")).not.toBeInTheDocument();
    expect(screen.queryByText("d-99")).not.toBeInTheDocument();
    expect(screen.getByText("wiki-pilot")).toBeInTheDocument();

    // Substring across `binding_id` field.
    fireEvent.change(resourceInput, { target: { value: "b-22" } });
    expect(screen.queryByText("wiki-pilot")).not.toBeInTheDocument();
    expect(screen.queryByText("d-99")).not.toBeInTheDocument();
    expect(screen.getByText("b-22")).toBeInTheDocument();

    // Substring across `domain_id` field.
    fireEvent.change(resourceInput, { target: { value: "d-99" } });
    expect(screen.queryByText("wiki-pilot")).not.toBeInTheDocument();
    expect(screen.queryByText("b-22")).not.toBeInTheDocument();
    expect(screen.getByText("d-99")).toBeInTheDocument();
  });
});

describe("Audit route — date-range filter", () => {
  it("excludes rows outside the from / to window", async () => {
    const rows = [
      makeRow({ id: "r1", action: "domain.update", createdAt: "2026-04-01T10:00:00Z", metadata: { slug: "wiki-april" } }),
      makeRow({ id: "r2", action: "domain.update", createdAt: "2026-05-05T10:00:00Z", metadata: { slug: "wiki-may" } }),
      makeRow({ id: "r3", action: "domain.update", createdAt: "2026-06-10T10:00:00Z", metadata: { slug: "wiki-june" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("wiki-april"));

    const fromInput = screen.getByTestId("audit-filter-from");
    const toInput = screen.getByTestId("audit-filter-to");

    fireEvent.change(fromInput, { target: { value: "2026-05-01" } });
    fireEvent.change(toInput, { target: { value: "2026-05-31" } });

    expect(screen.queryByText("wiki-april")).not.toBeInTheDocument();
    expect(screen.queryByText("wiki-june")).not.toBeInTheDocument();
    expect(screen.getByText("wiki-may")).toBeInTheDocument();
  });
});

describe("Audit route — pagination", () => {
  it("Next fetches with offset=50; Prev returns to offset=0", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      makeRow({ id: `p1-${i}`, action: "domain.update", metadata: { slug: `slug-p1-${i}` } }),
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: `p2-${i}`, action: "domain.update", metadata: { slug: `slug-p2-${i}` } }),
    );
    const fetchImpl = makeFetch({ 0: page1, 50: page2 });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("slug-p1-0"));

    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => screen.getByText("slug-p2-0"));
    expect(screen.queryByText("slug-p1-0")).not.toBeInTheDocument();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("offset=50"),
      expect.anything(),
    );

    fireEvent.click(screen.getByRole("button", { name: /prev/i }));

    await waitFor(() => screen.getByText("slug-p1-0"));
    expect(screen.queryByText("slug-p2-0")).not.toBeInTheDocument();
  });
});

describe("Audit route — row expand + copy", () => {
  it("clicking the row reveals the full sanitised JSON in mono", async () => {
    const rows = [
      makeRow({
        id: "r1",
        action: "domain.update",
        metadata: { slug: "wiki-pilot", caller_username: "alice", changed_fields: ["display_name"] },
      }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));

    fireEvent.click(screen.getByTestId("audit-row-r1"));

    const json = await screen.findByTestId("audit-row-r1-json");
    expect(json).toBeInTheDocument();
    expect(json.textContent).toContain("\"slug\": \"wiki-pilot\"");
    expect(json.textContent).toContain("\"changed_fields\"");
    // JetBrains Mono mandate (CLAUDE.md design system).
    expect(window.getComputedStyle(json).fontFamily).toMatch(/mono/i);
  });

  it("copy button writes the JSON to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const rows = [
      makeRow({
        id: "r1",
        action: "domain.update",
        metadata: { slug: "wiki-pilot" },
      }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));
    fireEvent.click(screen.getByTestId("audit-row-r1"));

    const expanded = await screen.findByTestId("audit-row-r1-detail");
    const copyBtn = within(expanded).getByRole("button", { name: /copy json/i });
    fireEvent.click(copyBtn);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("\"slug\": \"wiki-pilot\"");
  });
});

describe("Audit route — large payload", () => {
  it("payloads above 50 KB render with a 'Show full' toggle", async () => {
    // Build a metadata entry whose JSON exceeds 50 KB.
    const big = "x".repeat(60_000);
    const rows = [
      makeRow({
        id: "r-big",
        action: "domain.update",
        metadata: { slug: "wiki-pilot", _huge: big },
      }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));
    fireEvent.click(screen.getByTestId("audit-row-r-big"));

    const detail = await screen.findByTestId("audit-row-r-big-detail");
    // The truncation toggle is present when the payload exceeds 50 KB.
    expect(within(detail).getByRole("button", { name: /show full/i })).toBeInTheDocument();
    // The JSON view is initially truncated — should not contain the full
    // 60k character blob in one shot (rendered text is shorter than 60k).
    const json = within(detail).getByTestId("audit-row-r-big-json");
    expect(json.textContent?.length ?? 0).toBeLessThan(60_000);

    // Clicking "Show full" expands it.
    fireEvent.click(within(detail).getByRole("button", { name: /show full/i }));
    const fullJson = within(detail).getByTestId("audit-row-r-big-json");
    expect(fullJson.textContent?.length ?? 0).toBeGreaterThanOrEqual(60_000);
  });
});

describe("Audit route — Clear filters button", () => {
  it("resets all filter inputs", async () => {
    const rows = [
      makeRow({ id: "r1", action: "domain.update", metadata: { slug: "wiki-pilot", caller_username: "alice" } }),
      makeRow({ id: "r2", action: "domain.update", metadata: { slug: "wiki-other", caller_username: "bob" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("alice"));

    const actorInput = screen.getByPlaceholderText(/username substring or user UUID/i) as HTMLInputElement;
    fireEvent.change(actorInput, { target: { value: "ali" } });
    expect(screen.queryByText("bob")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(actorInput.value).toBe("");
    expect(screen.getByText("bob")).toBeInTheDocument();
  });
});

// ─── PR-R4 Copilot triage fix-ups ─────────────────────────────────────────────

describe("Audit route — fetch race (PR-R4 fix-up Issue 1)", () => {
  it("a late stale response does not overwrite the newer rendered page", async () => {
    // Race scenario: user clicks Next (offset=50, slow fetch),
    // then Prev (offset=0, fast fetch). If the late offset=50
    // response resolves AFTER the user is back on page 1, it
    // would clobber `rows` with page-2 data without the cancelled
    // guard.
    const page1 = Array.from({ length: 50 }, (_, i) =>
      makeRow({ id: `p1-${i}`, action: "domain.update", metadata: { slug: `slug-p1-${i}` } }),
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: `p2-${i}`, action: "domain.update", metadata: { slug: `slug-p2-${i}` } }),
    );

    let page2Calls = 0;
    type ResolveFn = (r: Response) => void;
    let resolvePage2: ResolveFn | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      const u = new URL(url, "http://localhost");
      const offset = Number(u.searchParams.get("offset") ?? "0");
      if (offset === 50) {
        page2Calls += 1;
        // First page-2 call: defer; second + : resolve immediately.
        if (page2Calls === 1) {
          return await new Promise<Response>((resolve) => {
            resolvePage2 = resolve;
          });
        }
      }
      const rows = offset === 0 ? page1 : page2;
      return new Response(JSON.stringify({ rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    render(<Audit fetchImpl={fetchImpl} />);

    // Page 1 lands and Next becomes enabled.
    await waitFor(() => screen.getByText("slug-p1-0"));

    // Click Next — page-2 fetch is now in flight (deferred).
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(resolvePage2).not.toBeNull());

    // Click Prev — re-fetches page 1 (resolves immediately).
    fireEvent.click(screen.getByRole("button", { name: /prev/i }));
    await waitFor(() => screen.getByText("slug-p1-0"));
    expect(screen.queryByText("slug-p2-0")).not.toBeInTheDocument();

    // NOW release the late page-2 response.
    const releasePage2 = resolvePage2 as ResolveFn | null;
    if (releasePage2 === null) throw new Error("page-2 fetch never reached the deferred branch");
    releasePage2(
      new Response(JSON.stringify({ rows: page2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    // Give microtasks a chance to flush the (would-be-stale) writes.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The user is still on page 1 — late page-2 response was discarded.
    expect(screen.getByText("slug-p1-0")).toBeInTheDocument();
    expect(screen.queryByText("slug-p2-0")).not.toBeInTheDocument();
  });
});

describe("Audit route — clipboard rejection (PR-R4 fix-up Issue 2)", () => {
  it("Copy button flips to 'Copy failed' (--alert) when writeText rejects, then reverts", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("nope"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const rows = [
      makeRow({
        id: "r1",
        action: "domain.update",
        metadata: { slug: "wiki-pilot" },
      }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));
    fireEvent.click(screen.getByTestId("audit-row-r1"));
    const detail = await screen.findByTestId("audit-row-r1-detail");
    const copyBtn = within(detail).getByRole("button", { name: /copy json/i });
    fireEvent.click(copyBtn);

    // The rejected writeText flips the button to "Copy failed".
    await waitFor(() => {
      expect(within(detail).getByRole("button", { name: /copy failed/i })).toBeInTheDocument();
    });
    const failedBtn = within(detail).getByRole("button", { name: /copy failed/i });
    // --alert color must come through. jsdom doesn't resolve CSS
    // var() in computed style, so we assert the inline style
    // declaration directly.
    expect(failedBtn.style.color).toBe("var(--alert)");

    // After the 2s revert window, the label is back to idle.
    // (Generous timeout — the component schedules setTimeout(... , 2000).)
    await waitFor(
      () => {
        expect(within(detail).getByRole("button", { name: /copy json/i })).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});

describe("Audit route — row keyboard a11y (PR-R4 fix-up Issue 3)", () => {
  it("Enter on a focused row toggles aria-expanded; second Enter collapses", async () => {
    const rows = [
      makeRow({
        id: "r1",
        action: "domain.update",
        metadata: { slug: "wiki-pilot" },
      }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));

    const rowEl = screen.getByTestId("audit-row-r1");
    expect(rowEl).toHaveAttribute("role", "button");
    expect(rowEl).toHaveAttribute("tabIndex", "0");
    expect(rowEl).toHaveAttribute("aria-expanded", "false");
    expect(rowEl).toHaveAttribute("aria-controls", "audit-row-r1-detail");

    // Enter expands.
    rowEl.focus();
    fireEvent.keyDown(rowEl, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("audit-row-r1")).toHaveAttribute("aria-expanded", "true");
    });
    const detail = screen.getByTestId("audit-row-r1-detail");
    // The expanded row's id matches aria-controls and carries role=region.
    const containerRow = detail.closest("tr");
    expect(containerRow).toHaveAttribute("id", "audit-row-r1-detail");
    expect(containerRow).toHaveAttribute("role", "region");

    // Second Enter collapses.
    fireEvent.keyDown(screen.getByTestId("audit-row-r1"), { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("audit-row-r1")).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("Space on a focused row toggles expansion (mirrors Enter)", async () => {
    const rows = [
      makeRow({ id: "r1", action: "domain.update", metadata: { slug: "wiki-pilot" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));
    const rowEl = screen.getByTestId("audit-row-r1");
    rowEl.focus();
    fireEvent.keyDown(rowEl, { key: " " });
    await waitFor(() => {
      expect(screen.getByTestId("audit-row-r1")).toHaveAttribute("aria-expanded", "true");
    });
  });
});

describe("Audit route — ISO-UTC timestamp (PR-R4 fix-up Issue 4)", () => {
  it("renders createdAt as YYYY-MM-DD HH:mm:ss UTC, not toLocaleString", async () => {
    const rows = [
      makeRow({
        id: "r1",
        action: "domain.update",
        createdAt: "2026-05-09T08:30:45.123Z",
        metadata: { slug: "wiki-pilot" },
      }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));
    expect(screen.getByText("2026-05-09 08:30:45 UTC")).toBeInTheDocument();
  });

  it("falls back to the raw ISO string for an unparseable timestamp", async () => {
    const rows = [
      makeRow({
        id: "r1",
        action: "domain.update",
        createdAt: "not-an-iso",
        metadata: { slug: "wiki-pilot" },
      }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));
    expect(screen.getByText("not-an-iso")).toBeInTheDocument();
  });
});

describe("Audit route — action filter dropdown keyboard (PR-R4 fix-up Issue 5)", () => {
  it("checkboxes inside the dropdown are natively focusable and Space-toggleable", async () => {
    const rows = [
      makeRow({ id: "r1", action: "domain.update", metadata: { slug: "wiki-pilot" } }),
      makeRow({ id: "r2", action: "source_binding.create", metadata: { slug: "src-x" } }),
    ];
    const fetchImpl = makeFetch({ 0: rows });
    render(<Audit fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("domain.update"));

    fireEvent.click(screen.getByTestId("audit-filter-action"));

    const optLabel = await screen.findByTestId("audit-filter-action-option-domain.update");
    const checkbox = within(optLabel).getByRole("checkbox") as HTMLInputElement;

    // Natively focusable — neither tabIndex=-1 nor pointer-events:none.
    expect(checkbox.tabIndex).toBe(0);
    expect(checkbox.style.pointerEvents).not.toBe("none");

    // Toggling via the checkbox's own change event narrows the rows.
    fireEvent.click(checkbox);
    const tableRows = screen.getAllByTestId(/^audit-row-r/);
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0]?.textContent).toContain("domain.update");
  });
});
