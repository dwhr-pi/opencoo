/**
 * Sources route — `+ New binding` button wiring (phase-a appendix #2).
 *
 * Pins:
 *   - Button is present at the page header.
 *   - Click opens NewSourceBindingModal (role='dialog' appears).
 *   - Refetches /api/admin/source-bindings after a successful
 *     create.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sources } from "../../src/routes/Sources.js";

const ADAPTERS_RESPONSE = {
  adapters: [
    {
      slug: "drive",
      mode: "polling",
      credentialSchema: {
        type: "object",
        properties: {
          service_account_json: { type: "string", secret: true },
          root_folder_id: { type: "string" },
        },
        required: ["service_account_json", "root_folder_id"],
      },
    },
  ],
};

const DOMAINS_RESPONSE = {
  rows: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      slug: "wiki-main",
      name: "Main",
      class: "knowledge",
      locale: "en",
      llmPolicy: {},
      isAggregator: false,
    },
  ],
};

function makeFetchMock(): {
  fetchImpl: ReturnType<typeof vi.fn>;
  bindingsListCount: () => number;
} {
  let bindingsListCount = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/admin/source-bindings" && method === "GET") {
      bindingsListCount += 1;
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/adapters" && method === "GET") {
      return new Response(JSON.stringify(ADAPTERS_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/domains" && method === "GET") {
      return new Response(JSON.stringify(DOMAINS_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/source-bindings" && method === "POST") {
      return new Response(
        JSON.stringify({ id: "00000000-0000-0000-0000-000000000099" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("404", { status: 404 });
  });
  return { fetchImpl, bindingsListCount: () => bindingsListCount };
}

describe("Sources route — + New binding button", () => {
  it("button is present at the page header", async () => {
    const { fetchImpl } = makeFetchMock();
    render(<Sources fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: /\+ New binding|New binding/i }),
    ).toBeInTheDocument();
  });

  it("opens the modal on click", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(<Sources fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await user.click(
      screen.getByRole("button", { name: /\+ New binding|New binding/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toBeInTheDocument(),
    );
  });

  it("refetches the bindings list after a successful create", async () => {
    const { fetchImpl, bindingsListCount } = makeFetchMock();
    const user = userEvent.setup();
    render(<Sources fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() => expect(bindingsListCount()).toBeGreaterThan(0));
    const initial = bindingsListCount();
    await user.click(
      screen.getByRole("button", { name: /\+ New binding|New binding/i }),
    );
    // Wait for the modal hydration (adapter + domain pickers
    // populated from the GET responses).
    await waitFor(() =>
      expect(
        document.querySelector("select[name='adapter_slug']"),
      ).not.toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: /^Next$/i }));
    await waitFor(() =>
      expect(
        document.querySelector("input[name='service_account_json']"),
      ).not.toBeNull(),
    );
    await user.type(
      document.querySelector("input[name='service_account_json']")!,
      "secret",
    );
    await user.type(
      document.querySelector("input[name='root_folder_id']")!,
      "1XYZ",
    );
    // PR-Q9: credentials → config (the fixture has no
    // bindingConfigSchema so the config step is empty).
    await user.click(screen.getByRole("button", { name: /^Next$/i }));
    await user.click(screen.getByRole("button", { name: /create binding/i }));
    await waitFor(() => expect(bindingsListCount()).toBeGreaterThan(initial));
  });
});
