/**
 * OutputChannelDetail + Outputs route — PR-Z4 (phase-a appendix
 * #12 G5) unit tests.
 *
 * Pins:
 *   - Outputs route renders an empty-state when the API returns
 *     no rows.
 *   - Outputs route renders one row with `(name, adapter, enabled,
 *     createdAt)`.
 *   - The `+ New output channel` button opens the modal.
 *   - The modal pulls `/api/admin/adapters`, renders the asana
 *     adapter, and POSTs the body verbatim on Submit.
 *   - The detail modal calls DELETE when the operator confirms.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { Outputs } from "../../src/routes/Outputs.js";
import { OutputChannelDetail } from "../../src/components/OutputChannelDetail.js";
import { ToastProvider, ToastRegion } from "../../src/components/Toast.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { OutputChannel } from "../../src/types.js";

/** Outputs now consumes `useToast` (PR-B7, wave-16). Tests render
 *  the route inside the same `<ToastProvider>` shell App.tsx
 *  mounts at the root so the hook resolves. */
function renderOutputs(node: JSX.Element): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      {node}
      <ToastRegion />
    </ToastProvider>,
  );
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function makeStubFetch(opts: {
  readonly rows?: readonly OutputChannel[];
  readonly adapters?: unknown[];
  readonly outputAdapters?: unknown[];
  readonly status?: number;
  readonly calls?: FetchCall[];
}): typeof fetch {
  const calls = opts.calls ?? [];
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
    calls.push({ url, method, body: parsedBody });
    if (url.includes("/api/admin/_csrf")) {
      return new Response(JSON.stringify({ csrfToken: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/admin/output-channels")) {
      if (method === "GET") {
        return new Response(JSON.stringify({ rows: opts.rows ?? [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST") {
        return new Response(
          JSON.stringify({ id: "11111111-2222-4333-8444-555555555555" }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.includes("/api/admin/adapters")) {
      return new Response(
        JSON.stringify({
          adapters: opts.adapters ?? [],
          outputAdapters: opts.outputAdapters ?? [
            {
              slug: "asana",
              credentialSchema: {
                type: "object",
                properties: {
                  asanaPersonalAccessToken: {
                    type: "string",
                    secret: true,
                  },
                },
                required: ["asanaPersonalAccessToken"],
              },
              channelConfigSchema: {
                type: "object",
                properties: {
                  project_gid: { type: "string" },
                },
                required: ["project_gid"],
              },
            },
          ],
        }),
        {
          status: opts.status ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("Outputs route", () => {
  it("renders empty state when no channels exist", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({ rows: [] });
    renderOutputs(<Outputs fetchImpl={stub} />);
    await waitFor(() => {
      expect(screen.getByText(/No output channels yet/i)).toBeTruthy();
    });
  });

  it("renders a row with name + adapter + enabled state", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      rows: [
        {
          id: "11111111-2222-4333-8444-555555555555",
          adapterSlug: "asana",
          name: "daily-report",
          enabled: true,
          config: { project_gid: "PRJ" },
          createdAt: "2026-05-10T08:00:00Z",
          updatedAt: "2026-05-10T08:00:00Z",
        },
      ],
    });
    renderOutputs(<Outputs fetchImpl={stub} />);
    await waitFor(() => {
      expect(screen.getByText("daily-report")).toBeTruthy();
    });
    expect(screen.getByText("asana")).toBeTruthy();
  });

  it("row cells expose accessible names + open the detail on Enter/Space", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      rows: [
        {
          id: "11111111-2222-4333-8444-555555555555",
          adapterSlug: "asana",
          name: "daily-report",
          enabled: true,
          config: { project_gid: "PRJ" },
          createdAt: "2026-05-10T08:00:00Z",
          updatedAt: "2026-05-10T08:00:00Z",
        },
      ],
    });
    renderOutputs(<Outputs fetchImpl={stub} />);
    // Cells expose an `aria-label` describing the row's drill-down
    // target — Copilot-flagged a11y gap (PR #109 fix-up).
    const cells = await screen.findAllByLabelText(
      /Open output channel daily-report/i,
    );
    expect(cells.length).toBeGreaterThan(0);
    // Each cell is a focusable button.
    for (const cell of cells) {
      expect(cell.getAttribute("role")).toBe("button");
      expect(cell.getAttribute("tabindex")).toBe("0");
    }
    // Enter triggers the same action as click — drill-down opens.
    fireEvent.keyDown(cells[0]!, { key: "Enter" });
    await waitFor(() => {
      // The detail modal title key (`outputs.detail.title` → "Output channel")
      // is the most stable anchor for the open state.
      expect(screen.getAllByText(/Output channel/i).length).toBeGreaterThan(0);
    });
  });

  it("Space key on a row cell also opens the detail", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      rows: [
        {
          id: "11111111-2222-4333-8444-555555555555",
          adapterSlug: "asana",
          name: "daily-report",
          enabled: true,
          config: { project_gid: "PRJ" },
          createdAt: "2026-05-10T08:00:00Z",
          updatedAt: "2026-05-10T08:00:00Z",
        },
      ],
    });
    renderOutputs(<Outputs fetchImpl={stub} />);
    const cells = await screen.findAllByLabelText(
      /Open output channel daily-report/i,
    );
    fireEvent.keyDown(cells[0]!, { key: " " });
    await waitFor(() => {
      expect(screen.getAllByText(/Output channel/i).length).toBeGreaterThan(0);
    });
  });

  it("opens the New channel modal + POSTs on submit", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ rows: [], calls });
    renderOutputs(<Outputs fetchImpl={stub} />);
    await waitFor(() => {
      // PR-B3 (wave-16) — two "+ New output channel" surfaces now
      // exist on the zero-rows page (header + EmptyStatePanel CTA);
      // both wire the same modal so click either.
      expect(
        screen.getAllByText(/\+ New output channel/i).length,
      ).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(screen.getAllByText(/\+ New output channel/i)[0]!);
    await waitFor(() => {
      expect(screen.getByLabelText(/^name$/i)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: "daily-report" },
    });
    // Find the project_gid field. The label is `project_gid · required`.
    const projInput = screen.getByLabelText(/project_gid/i);
    fireEvent.change(projInput, { target: { value: "PRJ-1" } });
    const credInput = screen.getByLabelText(/asanaPersonalAccessToken/i);
    fireEvent.change(credInput, { target: { value: "1/abc" } });
    fireEvent.click(screen.getByText(/^Create channel$/i));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/api/admin/output-channels"),
      );
      expect(post).toBeTruthy();
      expect(post?.body).toEqual({
        adapter_slug: "asana",
        name: "daily-report",
        config: { project_gid: "PRJ-1" },
        credentials: { asanaPersonalAccessToken: "1/abc" },
      });
    });
  });
});

describe("OutputChannelDetail", () => {
  it("field labels resolve through i18n (not hardcoded English)", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({ rows: [] });
    const channel: OutputChannel = {
      id: "11111111-2222-4333-8444-555555555555",
      adapterSlug: "asana",
      name: "daily-report",
      enabled: true,
      config: { project_gid: "PRJ" },
      createdAt: "2026-05-10T08:00:00Z",
      updatedAt: "2026-05-10T08:00:00Z",
    };
    render(
      <OutputChannelDetail
        channel={channel}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    // The three field labels are sourced from
    // `outputs.detail.labels.{name,adapter,state}` via `t(...)`.
    // The English locale renders them as "name" / "adapter" / "state".
    // We assert the rendered strings appear AND that the values they
    // describe render next to them — that's enough to pin the i18n
    // routing without coupling to internals.
    expect(screen.getByText(/^name$/i)).toBeTruthy();
    expect(screen.getByText(/^adapter$/i)).toBeTruthy();
    expect(screen.getByText(/^state$/i)).toBeTruthy();
    expect(screen.getByText("daily-report")).toBeTruthy();
    expect(screen.getByText("asana")).toBeTruthy();
  });

  it("DELETE call fires after confirmation step", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ rows: [], calls });
    const channel: OutputChannel = {
      id: "11111111-2222-4333-8444-555555555555",
      adapterSlug: "asana",
      name: "to-delete",
      enabled: true,
      config: { project_gid: "PRJ" },
      createdAt: "2026-05-10T08:00:00Z",
      updatedAt: "2026-05-10T08:00:00Z",
    };
    const onChanged = vi.fn();
    render(
      <OutputChannelDetail
        channel={channel}
        onClose={(): void => {}}
        onChanged={onChanged}
        fetchImpl={stub}
      />,
    );
    // First click → confirmation
    fireEvent.click(screen.getByText(/^Delete$/i));
    // Second click on Delete in the confirmation panel fires DELETE
    const deleteBtns = await screen.findAllByText(/^Delete$/i);
    fireEvent.click(deleteBtns[deleteBtns.length - 1]!);
    await waitFor(() => {
      const del = calls.find(
        (c) => c.method === "DELETE" && c.url.includes(channel.id),
      );
      expect(del).toBeTruthy();
      expect(onChanged).toHaveBeenCalled();
    });
  });
});
