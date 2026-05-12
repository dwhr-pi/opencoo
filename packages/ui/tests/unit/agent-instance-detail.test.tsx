/**
 * AgentInstanceDetail + Agents route — PR-W2 (phase-a appendix
 * #13) unit tests.
 *
 * Pins:
 *   - Agents route renders empty-state, then a populated row.
 *   - The drill-down modal opens from a row keystroke.
 *   - Save-channels dispatches PATCH `{output_channel_ids}`.
 *   - Enable/Disable dispatches PATCH `{enabled}`.
 *   - Schedule-save dispatches PATCH `{schedule_cron}` only when
 *     the input value changed (button stays disabled when not
 *     dirty).
 */
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { AgentInstanceDetail } from "../../src/components/AgentInstanceDetail.js";
import { Agents } from "../../src/routes/Agents.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { AgentInstance, OutputChannel } from "../../src/types.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function makeStubFetch(opts: {
  readonly instances?: readonly AgentInstance[];
  readonly channels?: readonly OutputChannel[];
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
    if (url.includes("/api/admin/agent-instances")) {
      if (method === "GET") {
        return new Response(
          JSON.stringify({ rows: opts.instances ?? [] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (method === "PATCH") {
        return new Response(JSON.stringify({ updated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.includes("/api/admin/output-channels")) {
      return new Response(JSON.stringify({ rows: opts.channels ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

const SAMPLE_INSTANCE: AgentInstance = {
  id: "11111111-2222-4333-8444-555555555555",
  definitionSlug: "heartbeat",
  name: "Heartbeat 06:00",
  scheduleCron: "0 6 * * 1-5",
  enabled: true,
  outputChannelCount: 0,
  outputChannelIds: [],
  lastRunStartedAt: null,
  lastRunStatus: null,
};

const SAMPLE_CHANNEL_A: OutputChannel = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  adapterSlug: "asana",
  name: "daily-report",
  enabled: true,
  config: { project_gid: "PRJ" },
  createdAt: null,
  updatedAt: null,
};

const SAMPLE_CHANNEL_B: OutputChannel = {
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  adapterSlug: "asana",
  name: "weekly-digest",
  enabled: true,
  config: { project_gid: "PRJ2" },
  createdAt: null,
  updatedAt: null,
};

describe("Agents route", () => {
  it("renders empty-state when no instances exist", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({ instances: [] });
    render(<Agents fetchImpl={stub} />);
    await waitFor(() => {
      expect(screen.getByText(/No agent instances yet/i)).toBeTruthy();
    });
  });

  it("renders a row + opens drill-down on Enter", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      instances: [SAMPLE_INSTANCE],
      channels: [SAMPLE_CHANNEL_A],
    });
    render(<Agents fetchImpl={stub} />);
    await waitFor(() => {
      expect(screen.getByText("Heartbeat 06:00")).toBeTruthy();
    });
    const cells = await screen.findAllByLabelText(
      /Open agent instance Heartbeat 06:00/i,
    );
    expect(cells.length).toBeGreaterThan(0);
    fireEvent.keyDown(cells[0]!, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getAllByText(/Agent instance/i).length).toBeGreaterThan(0);
    });
  });
});

describe("AgentInstanceDetail", () => {
  it("Save channels dispatches PATCH {output_channel_ids}", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      channels: [SAMPLE_CHANNEL_A, SAMPLE_CHANNEL_B],
      calls,
    });
    render(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    // Wait for the channel catalog to load.
    await waitFor(() => {
      expect(screen.getByText("daily-report")).toBeTruthy();
    });

    // The save button is disabled until something is selected/dirty.
    const saveBtn = screen.getByText(/Save channels/i);
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

    // Tick channel A.
    const channelACheckbox = screen.getAllByRole("checkbox")[0]!;
    fireEvent.click(channelACheckbox);

    // Save now enabled.
    await waitFor(() => {
      expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.url.endsWith(`/api/admin/agent-instances/${SAMPLE_INSTANCE.id}`),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({
        output_channel_ids: [SAMPLE_CHANNEL_A.id],
      });
    });
  });

  it("Enable/Disable button dispatches PATCH {enabled}", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ channels: [], calls });
    render(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/^Disable$/i));

    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.url.endsWith(`/api/admin/agent-instances/${SAMPLE_INSTANCE.id}`),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ enabled: false });
    });
  });

  it("Schedule save dispatches PATCH {schedule_cron} only when dirty", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ channels: [], calls });
    render(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    const saveSchedule = screen.getByText(/Save schedule/i);
    // Pristine — save disabled.
    expect((saveSchedule as HTMLButtonElement).disabled).toBe(true);

    const cronInput = screen.getByPlaceholderText("0 6 * * 1-5");
    fireEvent.change(cronInput, { target: { value: "30 7 * * 1-5" } });
    await waitFor(() => {
      expect((saveSchedule as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(saveSchedule);

    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.body !== undefined &&
          typeof c.body === "object" &&
          "schedule_cron" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ schedule_cron: "30 7 * * 1-5" });
    });
  });

  it("pre-checks channels currently bound to the instance", async () => {
    setPat("test-pat");
    const stub = makeStubFetch({
      channels: [SAMPLE_CHANNEL_A, SAMPLE_CHANNEL_B],
    });
    render(
      <AgentInstanceDetail
        instance={{
          ...SAMPLE_INSTANCE,
          outputChannelCount: 1,
          outputChannelIds: [
            {
              adapter_slug: "asana",
              config: { channel_id: SAMPLE_CHANNEL_B.id },
            },
          ],
        }}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("weekly-digest")).toBeTruthy();
    });
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // Channel order matches the catalog GET — A first, B second.
    expect(checkboxes[0]?.checked).toBe(false);
    expect(checkboxes[1]?.checked).toBe(true);
  });
});
