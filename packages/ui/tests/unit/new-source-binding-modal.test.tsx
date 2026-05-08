/**
 * NewSourceBindingModal tests — phase-a appendix #2.
 *
 * Two-step modal:
 *   1. Adapter picker + target_domain picker + review_mode prefill
 *   2. <CredentialForm> for the picked adapter's credentialSchema
 *
 * Webhook adapters render auth.* AND webhook_secret.* fields;
 * the submit body splits them under those top-level keys.
 *
 * Pins:
 *   - Adapter picker is populated from the server's
 *     /api/admin/adapters response (mock that fetch).
 *   - Step transitions: picker → credentials form, with a
 *     `back` button.
 *   - Submit composes the right body shape for polling AND
 *     webhook adapters.
 *   - review_mode prefill follows defaultReviewModeFor().
 *   - Secret fields render with `data-secret="true"`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewSourceBindingModal } from "../../src/components/NewSourceBindingModal.js";

const ADAPTERS_RESPONSE = {
  adapters: [
    {
      slug: "drive",
      mode: "polling" as const,
      credentialSchema: {
        type: "object",
        properties: {
          service_account_json: { type: "string", secret: true, description: "JSON key" },
          root_folder_id: { type: "string", description: "Folder id" },
        },
        required: ["service_account_json", "root_folder_id"],
      },
    },
    {
      slug: "fireflies",
      mode: "webhook" as const,
      credentialSchema: {
        type: "object",
        properties: {
          auth: {
            type: "object",
            properties: {
              api_key: { type: "string", secret: true, description: "API key" },
            },
            required: ["api_key"],
          },
          webhook_secret: {
            type: "object",
            properties: {
              signing_secret: { type: "string", secret: true, description: "Signing secret" },
            },
            required: ["signing_secret"],
          },
        },
        required: ["auth", "webhook_secret"],
      },
    },
  ],
};

const DOMAINS_RESPONSE = {
  rows: [
    { id: "11111111-1111-1111-1111-111111111111", slug: "wiki-main", name: "Main", class: "knowledge", locale: "en", llmPolicy: {}, isAggregator: false },
    { id: "22222222-2222-2222-2222-222222222222", slug: "wiki-meet", name: "Meetings", class: "knowledge", locale: "en", llmPolicy: {}, isAggregator: false },
  ],
};

function makeFetchMock(): {
  fetchImpl: ReturnType<typeof vi.fn>;
  postCalls: () => Array<[string, RequestInit]>;
} {
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
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
    return new Response("not found", { status: 404 });
  });
  const postCalls = (): Array<[string, RequestInit]> =>
    fetchImpl.mock.calls
      .filter(
        (c) =>
          (((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() ===
          "POST"),
      )
      .map((c) => [String(c[0]), c[1] as RequestInit]);
  return { fetchImpl, postCalls };
}

describe("NewSourceBindingModal", () => {
  it("loads adapter + domain pickers from /api/admin/adapters and /api/admin/domains", async () => {
    const { fetchImpl } = makeFetchMock();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      const adapterSelect = document.querySelector(
        "select[name='adapter_slug']",
      ) as HTMLSelectElement;
      expect(adapterSelect.options.length).toBeGreaterThan(0);
    });
    const adapter = document.querySelector(
      "select[name='adapter_slug']",
    ) as HTMLSelectElement;
    const adapterValues = Array.from(adapter.options).map((o) => o.value);
    expect(adapterValues).toContain("drive");
    expect(adapterValues).toContain("fireflies");

    const domain = document.querySelector(
      "select[name='target_domain_slug']",
    ) as HTMLSelectElement;
    const domainValues = Array.from(domain.options).map((o) => o.value);
    expect(domainValues).toContain("wiki-main");
    expect(domainValues).toContain("wiki-meet");
  });

  it("step 2 renders the credential form for a polling adapter", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector("select[name='adapter_slug']"),
      ).not.toBeNull(),
    );
    // Default is the first adapter alphabetically (drive). Click Next.
    await user.click(screen.getByRole("button", { name: /next/i }));
    // Credential form fields rendered.
    await waitFor(() => {
      expect(
        document.querySelector("input[name='service_account_json']"),
      ).not.toBeNull();
      expect(
        document.querySelector("input[name='root_folder_id']"),
      ).not.toBeNull();
    });
  });

  it("submits a polling-adapter binding with flat `credentials` body", async () => {
    const { fetchImpl, postCalls } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector("select[name='adapter_slug']"),
      ).not.toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() =>
      expect(
        document.querySelector("input[name='service_account_json']"),
      ).not.toBeNull(),
    );
    await user.type(
      document.querySelector("input[name='service_account_json']")!,
      "secret-json",
    );
    await user.type(
      document.querySelector("input[name='root_folder_id']")!,
      "1XYZ",
    );
    // PR-Q9: credentials → config (the fixture's adapters have no
    // `bindingConfigSchema`, so the config step renders no inputs
    // and the operator clicks Create binding immediately).
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /create binding/i }));

    await waitFor(() => expect(postCalls().length).toBe(1));
    const [, init] = postCalls()[0]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      adapter_slug: "drive",
      target_domain_slug: "wiki-main",
      credentials: {
        service_account_json: "secret-json",
        root_folder_id: "1XYZ",
      },
    });
  });

  it("submits a webhook-adapter binding with split auth + webhook_secret credentials", async () => {
    const { fetchImpl, postCalls } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector("select[name='adapter_slug']"),
      ).not.toBeNull(),
    );
    // Pick fireflies.
    await user.selectOptions(
      document.querySelector("select[name='adapter_slug']")!,
      "fireflies",
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    // Both auth + webhook_secret inputs render.
    await waitFor(() => {
      expect(document.querySelector("input[name='auth.api_key']")).not.toBeNull();
      expect(
        document.querySelector("input[name='webhook_secret.signing_secret']"),
      ).not.toBeNull();
    });
    await user.type(
      document.querySelector("input[name='auth.api_key']")!,
      "key-aaa",
    );
    await user.type(
      document.querySelector("input[name='webhook_secret.signing_secret']")!,
      "sig-zzz",
    );
    // PR-Q9: credentials → config (the fixture has no
    // bindingConfigSchema, so config step is empty).
    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /create binding/i }));

    await waitFor(() => expect(postCalls().length).toBe(1));
    const [, init] = postCalls()[0]!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      adapter_slug: "fireflies",
      target_domain_slug: "wiki-main",
      credentials: {
        auth: { api_key: "key-aaa" },
        webhook_secret: { signing_secret: "sig-zzz" },
      },
    });
  });

  it("review_mode prefill follows defaultReviewModeFor (knowledge × fireflies → 'approve')", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector("select[name='adapter_slug']"),
      ).not.toBeNull(),
    );
    await user.selectOptions(
      document.querySelector("select[name='adapter_slug']")!,
      "fireflies",
    );
    // The review_mode prefilled select is on the same step.
    const reviewMode = document.querySelector(
      "select[name='review_mode']",
    ) as HTMLSelectElement;
    expect(reviewMode.value).toBe("approve");
  });

  it("secret fields render with type=password + data-secret='true'", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <NewSourceBindingModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector("select[name='adapter_slug']"),
      ).not.toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      const secret = document.querySelector(
        "input[name='service_account_json']",
      ) as HTMLInputElement;
      expect(secret).not.toBeNull();
      expect(secret.type).toBe("password");
      expect(secret.dataset["secret"]).toBe("true");
    });
  });
});
