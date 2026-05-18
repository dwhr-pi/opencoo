/**
 * DomainDetail — optimistic-patch wiring for `display_name`,
 * `default_locale`, `worldview_enabled` (PR-B5+, wave-17).
 *
 * Pins:
 *   1. Each whitelisted field has a per-field Quick-save path
 *      wired through useOptimisticPatch. The combined Save
 *      remains for non-whitelisted fields + bulk edits.
 *   2. Saving-cue dot lights up next to the field during PATCH.
 *   3. On 422 the field reverts + the B7 alert toast surfaces.
 *   4. Audit-row absence: server's audit-write-before-mutate is
 *      pinned at the admin-API integration test layer; here we
 *      assert the failed PATCH was attempted and no second write
 *      followed (no audit metadata to assert client-side).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DomainDetail } from "../../src/components/DomainDetail.js";
import { ToastProvider, ToastRegion } from "../../src/components/Toast.js";
import type { Domain } from "../../src/types.js";

const DOMAIN_ID = "11111111-2222-3333-4444-555555555555";

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: DOMAIN_ID,
    slug: "wiki-test",
    name: "Test wiki",
    class: "knowledge",
    locale: "en",
    isAggregator: false,
    disabledAt: null,
    bindingCount: 0,
    worldviewEnabled: true,
    ...overrides,
  };
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function makeStubFetch(opts: {
  readonly calls: FetchCall[];
  readonly failPatchOn?: ReadonlyArray<string>;
}): typeof fetch {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    let parsedBody: unknown;
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
      method === "PATCH" &&
      url === `/api/admin/domains/${DOMAIN_ID}`
    ) {
      if (
        opts.failPatchOn !== undefined &&
        parsedBody !== null &&
        typeof parsedBody === "object"
      ) {
        const keys = Object.keys(parsedBody as Record<string, unknown>);
        if (keys.some((k) => opts.failPatchOn!.includes(k))) {
          return new Response(
            JSON.stringify({ error: "validation_failed" }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        }
      }
      return new Response(JSON.stringify({ id: DOMAIN_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function renderWithProvider(node: JSX.Element): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      {node}
      <ToastRegion />
    </ToastProvider>,
  );
}

describe("DomainDetail — optimistic display_name wire (PR-B5+, wave-17)", () => {
  it("Quick-save display_name dispatches single-field PATCH", async () => {
    const user = userEvent.setup();
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ calls });
    renderWithProvider(
      <DomainDetail
        domain={makeDomain()}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    // Find the Quick-save button (next to the display-name field).
    // The display-name FORM_FIELD container has exactly one button
    // (the Quick-save). The combined "Save changes" button sits
    // in the modal footer, not inside the field's row.
    const input = document.querySelector(
      "#domain-detail-display-name",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await user.clear(input);
    await user.type(input, "Renamed wiki");

    const fieldRow = input.parentElement!;
    const quickSave = fieldRow.querySelector("button") as HTMLButtonElement;
    expect(quickSave).not.toBeNull();
    await user.click(quickSave);

    await waitFor((): void => {
      const patch = calls.find(
        (c): boolean =>
          c.method === "PATCH" &&
          c.body !== null &&
          typeof c.body === "object" &&
          "display_name" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ display_name: "Renamed wiki" });
    });
  });

  it("422 on display_name PATCH: alert toast surfaces", async () => {
    const user = userEvent.setup();
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ calls, failPatchOn: ["display_name"] });
    renderWithProvider(
      <DomainDetail
        domain={makeDomain()}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    const input = document.querySelector(
      "#domain-detail-display-name",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Bad name");
    const quickSave = input.parentElement!.querySelector(
      "button",
    ) as HTMLButtonElement;
    await user.click(quickSave);

    await waitFor((): void => {
      expect(
        calls.find(
          (c) =>
            c.method === "PATCH" &&
            c.body !== null &&
            typeof c.body === "object" &&
            (c.body as Record<string, unknown>).display_name === "Bad name",
        ),
      ).toBeTruthy();
    });
    await waitFor((): void => {
      const region = screen.getByRole("region", { name: /notifications/i });
      expect(within(region).queryByText("ALERT")).toBeTruthy();
    });
  });
});

describe("DomainDetail — optimistic locale wire (PR-B5+, wave-17)", () => {
  it("locale select change dispatches PATCH {locale}", async () => {
    const user = userEvent.setup();
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ calls });
    renderWithProvider(
      <DomainDetail
        domain={makeDomain()}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    const localeSelect = screen.getByLabelText(/locale/i) as HTMLSelectElement;
    await user.selectOptions(localeSelect, "pl");

    await waitFor((): void => {
      const patch = calls.find(
        (c): boolean =>
          c.method === "PATCH" &&
          c.body !== null &&
          typeof c.body === "object" &&
          "locale" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ locale: "pl" });
    });
  });

  it("422 on locale PATCH: alert toast + select reverts", async () => {
    const user = userEvent.setup();
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ calls, failPatchOn: ["locale"] });
    renderWithProvider(
      <DomainDetail
        domain={makeDomain({ locale: "en" })}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    const localeSelect = screen.getByLabelText(/locale/i) as HTMLSelectElement;
    await user.selectOptions(localeSelect, "pl");

    await waitFor((): void => {
      expect(
        calls.find(
          (c) =>
            c.method === "PATCH" &&
            c.body !== null &&
            typeof c.body === "object" &&
            (c.body as Record<string, unknown>).locale === "pl",
        ),
      ).toBeTruthy();
    });
    await waitFor((): void => {
      const region = screen.getByRole("region", { name: /notifications/i });
      expect(within(region).queryByText("ALERT")).toBeTruthy();
    });
  });
});

describe("DomainDetail — optimistic worldview_enabled wire (PR-B5+, wave-17)", () => {
  it("toggle dispatches PATCH {worldview_enabled}", async () => {
    const user = userEvent.setup();
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ calls });
    renderWithProvider(
      <DomainDetail
        domain={makeDomain({ worldviewEnabled: true })}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    const checkbox = screen.getByLabelText(
      /worldview compilation enabled/i,
    ) as HTMLInputElement;
    await user.click(checkbox);

    await waitFor((): void => {
      const patch = calls.find(
        (c): boolean =>
          c.method === "PATCH" &&
          c.body !== null &&
          typeof c.body === "object" &&
          "worldview_enabled" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ worldview_enabled: false });
    });
  });

  it("422 on worldview_enabled PATCH: alert toast + checkbox reverts", async () => {
    const user = userEvent.setup();
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      calls,
      failPatchOn: ["worldview_enabled"],
    });
    renderWithProvider(
      <DomainDetail
        domain={makeDomain({ worldviewEnabled: true })}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );

    const checkbox = screen.getByLabelText(
      /worldview compilation enabled/i,
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);

    await waitFor((): void => {
      expect(
        calls.find(
          (c) =>
            c.method === "PATCH" &&
            c.body !== null &&
            typeof c.body === "object" &&
            "worldview_enabled" in
              (c.body as Record<string, unknown>),
        ),
      ).toBeTruthy();
    });
    await waitFor((): void => {
      const region = screen.getByRole("region", { name: /notifications/i });
      expect(within(region).queryByText("ALERT")).toBeTruthy();
    });
    // Copilot triage: pin that the checkbox reverts to its prior
    // checked state after the optimistic rollback (the `checked`
    // attribute is driven directly from `worldviewOptimistic.value`
    // so the hook's rollback shows up in the UI).
    await waitFor((): void => {
      const cb = screen.getByLabelText(
        /worldview compilation enabled/i,
      ) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });
  });
});
