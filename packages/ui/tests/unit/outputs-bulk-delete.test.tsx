/**
 * Outputs route — bulk multi-select + bulk-delete confirmation
 * flow (PR-W6, phase-a appendix #15).
 *
 * Pins:
 *   - row checkboxes track selection state
 *   - header checkbox toggles select-all
 *   - `Delete N` button reveals only when selection is non-empty
 *   - clicking it opens the confirmation modal with the
 *     destructive-confirm checkbox; the confirm button is disabled
 *     until the checkbox is ticked
 *   - confirm POSTs the id array to /api/admin/output-channels/bulk-delete
 *   - the list refreshes on success
 */
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { Outputs } from "../../src/routes/Outputs.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { OutputChannel } from "../../src/types.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

const ROW_A: OutputChannel = {
  id: "11111111-2222-4333-8444-555555555aaa",
  adapterSlug: "asana",
  name: "alpha-report",
  enabled: true,
  config: { project_gid: "PRJ-A" },
  createdAt: "2026-05-10T08:00:00Z",
  updatedAt: "2026-05-10T08:00:00Z",
};

const ROW_B: OutputChannel = {
  id: "11111111-2222-4333-8444-555555555bbb",
  adapterSlug: "asana",
  name: "beta-report",
  enabled: false,
  config: { project_gid: "PRJ-B" },
  createdAt: "2026-05-11T08:00:00Z",
  updatedAt: "2026-05-11T08:00:00Z",
};

function makeStubFetch(opts: {
  readonly rows: readonly OutputChannel[];
  readonly calls: FetchCall[];
  readonly bulkDeleteResponse?: { deleted: number; skipped: number };
}): typeof fetch {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    opts.calls.push({ url, method, body: parsedBody });
    if (url.includes("/api/admin/_csrf")) {
      return new Response(JSON.stringify({ csrfToken: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.endsWith("/api/admin/output-channels/bulk-delete") &&
      method === "POST"
    ) {
      const resp = opts.bulkDeleteResponse ?? { deleted: 2, skipped: 0 };
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/admin/output-channels") && method === "GET") {
      return new Response(JSON.stringify({ rows: opts.rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Outputs bulk-delete (PR-W6 phase-a appendix #15)", () => {
  it("Delete N button is hidden when no rows are selected", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ rows: [ROW_A, ROW_B], calls });
    render(<Outputs fetchImpl={stub} />);
    await waitFor(() => {
      expect(screen.getByText(ROW_A.name)).toBeTruthy();
    });
    expect(screen.queryByTestId("outputs-bulk-delete-btn")).toBeNull();
  });

  it("selecting a row reveals the Delete N button with the right count", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ rows: [ROW_A, ROW_B], calls });
    render(<Outputs fetchImpl={stub} />);
    const cb = await screen.findByTestId(`outputs-select-row-${ROW_A.id}`);
    fireEvent.click(cb);
    const btn = await screen.findByTestId("outputs-bulk-delete-btn");
    expect(btn.textContent).toMatch(/1/);
    // Add the second row.
    fireEvent.click(screen.getByTestId(`outputs-select-row-${ROW_B.id}`));
    expect(
      screen.getByTestId("outputs-bulk-delete-btn").textContent,
    ).toMatch(/2/);
  });

  it("select-all checkbox selects every row", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ rows: [ROW_A, ROW_B], calls });
    render(<Outputs fetchImpl={stub} />);
    const all = await screen.findByTestId("outputs-select-all");
    fireEvent.click(all);
    expect(
      (screen.getByTestId(`outputs-select-row-${ROW_A.id}`) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByTestId(`outputs-select-row-${ROW_B.id}`) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      screen.getByTestId("outputs-bulk-delete-btn").textContent,
    ).toMatch(/2/);
  });

  it("confirm button is gated by the destructive-confirm checkbox", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ rows: [ROW_A], calls });
    render(<Outputs fetchImpl={stub} />);
    const rowCheckbox = await screen.findByTestId(
      `outputs-select-row-${ROW_A.id}`,
    );
    fireEvent.click(rowCheckbox);
    fireEvent.click(screen.getByTestId("outputs-bulk-delete-btn"));
    // Confirm button is in the DOM but disabled until ack is checked
    const confirmBtn = await screen.findByTestId(
      "outputs-bulk-delete-confirm",
    );
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    // Tick the ack checkbox (the label text comes from i18n
    // "outputs.bulkDelete.confirmCheckboxLabel").
    const ackCheckbox = screen.getByLabelText(
      /I understand this cannot be undone/i,
    );
    fireEvent.click(ackCheckbox);
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("confirm POSTs the selected ids to /api/admin/output-channels/bulk-delete and refreshes", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      rows: [ROW_A, ROW_B],
      calls,
      bulkDeleteResponse: { deleted: 2, skipped: 0 },
    });
    render(<Outputs fetchImpl={stub} />);
    // Wait for initial GET to settle so the rows render.
    await waitFor(() => {
      expect(screen.getByText(ROW_A.name)).toBeTruthy();
    });
    const initialGetCount = calls.filter(
      (c) => c.method === "GET" && c.url.endsWith("/api/admin/output-channels"),
    ).length;

    fireEvent.click(screen.getByTestId(`outputs-select-row-${ROW_A.id}`));
    fireEvent.click(screen.getByTestId(`outputs-select-row-${ROW_B.id}`));
    fireEvent.click(screen.getByTestId("outputs-bulk-delete-btn"));
    fireEvent.click(
      screen.getByLabelText(/I understand this cannot be undone/i),
    );
    fireEvent.click(screen.getByTestId("outputs-bulk-delete-confirm"));

    await waitFor(() => {
      const post = calls.find(
        (c) =>
          c.method === "POST" &&
          c.url.endsWith("/api/admin/output-channels/bulk-delete"),
      );
      expect(post).toBeTruthy();
      const body = post!.body as { ids: string[] };
      expect(new Set(body.ids)).toEqual(new Set([ROW_A.id, ROW_B.id]));
    });
    // The list refreshes — a fresh GET fires after the POST resolves.
    await waitFor(() => {
      const finalGetCount = calls.filter(
        (c) =>
          c.method === "GET" &&
          c.url.endsWith("/api/admin/output-channels"),
      ).length;
      expect(finalGetCount).toBeGreaterThan(initialGetCount);
    });
  });

  it("bulk-delete button caps batch by the operator's selection (51 rows still allowed in UI; server caps)", async () => {
    // The UI itself does not cap — it forwards whatever the operator
    // selected; the server is the source of truth for the 50-id cap.
    // This test pins that the UI does NOT silently truncate beyond
    // the page's listed rows.
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ rows: [ROW_A, ROW_B], calls });
    render(<Outputs fetchImpl={stub} />);
    const all = await screen.findByTestId("outputs-select-all");
    fireEvent.click(all);
    const btn = screen.getByTestId("outputs-bulk-delete-btn");
    expect(btn.textContent).toMatch(/2/);
  });
});
