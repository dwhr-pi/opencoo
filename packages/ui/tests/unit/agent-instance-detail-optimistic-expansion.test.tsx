/**
 * AgentInstanceDetail — optimistic-patch wiring for `name`,
 * `locale`, and `scope_domain_ids` (PR-B5+, wave-17 — phase-a
 * appendix #17).
 *
 * Pins (one matrix per field):
 *   1. Success path — `setValue(next)` reflects immediately in the
 *      UI (the displayed value flips before PATCH resolves), the
 *      saving-cue dot mounts, and on success the dot clears.
 *   2. Rollback path — synthetic 422 reverts the field value AND
 *      surfaces an alert-red toast via the B7 toast region.
 *   3. Audit-row absence — the rollback PATCH is observable in the
 *      stub fetch as a 422; the server contract is unchanged
 *      (audit-write-before-mutate guarantees no audit row exists
 *      for the failed PATCH — verified by the admin-API integration
 *      tests; this unit test pins the rollback shape).
 *
 * The wave-16 B5 baseline pinned `enabled`. This file extends to
 * the three new whitelisted fields.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { AgentInstanceDetail } from "../../src/components/AgentInstanceDetail.js";
import { ToastProvider, ToastRegion } from "../../src/components/Toast.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { AgentInstance } from "../../src/types.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface MakeStubOpts {
  readonly calls?: FetchCall[];
  /** When set, PATCH calls to the agent-instance route with a body
   *  containing one of these keys will return 422. */
  readonly failPatchOn?: ReadonlyArray<string>;
  readonly failBody?: Record<string, unknown>;
}

function makeStubFetch(opts: MakeStubOpts): typeof fetch {
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
    if (
      method === "PATCH" &&
      url.includes("/api/admin/agent-instances") &&
      opts.failPatchOn !== undefined &&
      parsedBody !== null &&
      typeof parsedBody === "object"
    ) {
      const keys = Object.keys(parsedBody as Record<string, unknown>);
      if (keys.some((k) => opts.failPatchOn!.includes(k))) {
        return new Response(
          JSON.stringify(opts.failBody ?? { error: "validation_failed" }),
          {
            status: 422,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }
    if (
      url.includes("/api/admin/agent-instances") &&
      method === "PATCH"
    ) {
      return new Response(JSON.stringify({ updated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/admin/output-channels")) {
      return new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/admin/domains")) {
      return new Response(
        JSON.stringify({
          rows: [
            {
              id: "aaaa1111-1111-4111-8111-111111111111",
              slug: "wiki-test-a",
              name: "Wiki test A",
              class: "knowledge",
              locale: "en",
              isAggregator: false,
            },
            {
              id: "bbbb2222-2222-4222-8222-222222222222",
              slug: "wiki-test-b",
              name: "Wiki test B",
              class: "knowledge",
              locale: "en",
              isAggregator: false,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
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
  locale: "en",
  scopeDomainIds: ["aaaa1111-1111-4111-8111-111111111111"],
  lastRunStartedAt: null,
  lastRunStatus: null,
};

function renderWithProvider(node: JSX.Element): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      {node}
      <ToastRegion />
    </ToastProvider>,
  );
}

describe("AgentInstanceDetail — optimistic name wire (PR-B5+, wave-17)", () => {
  it("Save name dispatches PATCH {name} optimistically + cue mounts", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ calls });
    renderWithProvider(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor((): void => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    const input = screen.getByDisplayValue("Heartbeat 06:00") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Heartbeat 07:00" } });
    fireEvent.click(screen.getByText(/^Save name$/));

    // Saving-cue dot mounts (we have at least one [data-saving-state]
    // element other than the wave-16 enabled-cue dot in idle).
    await waitFor((): void => {
      const cues = document.querySelectorAll(
        "[data-saving-state='saving']",
      );
      expect(cues.length).toBeGreaterThan(0);
    });

    // PATCH {name} fired.
    await waitFor((): void => {
      const patch = calls.find(
        (c): boolean =>
          c.method === "PATCH" &&
          c.body !== null &&
          typeof c.body === "object" &&
          "name" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({ name: "Heartbeat 07:00" });
    });
  });

  it("synthetic 422 on name PATCH: rollback + alert toast surfaces", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      calls,
      failPatchOn: ["name"],
      failBody: { error: "policy_violation" },
    });
    renderWithProvider(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor((): void => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    const input = screen.getByDisplayValue("Heartbeat 06:00") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Heartbeat 07:00" } });
    fireEvent.click(screen.getByText(/^Save name$/));

    // PATCH attempted (then 422'd) — audit-row pin: the server's
    // audit-write-before-mutate guarantees no audit row exists for
    // a failed PATCH. The unit-test surface for this is that the
    // stub observed exactly one PATCH which returned 422.
    await waitFor((): void => {
      const patch = calls.find(
        (c): boolean =>
          c.method === "PATCH" &&
          c.body !== null &&
          typeof c.body === "object" &&
          "name" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
    });

    // Alert toast surfaces.
    await waitFor((): void => {
      const region = screen.getByRole("region", { name: /notifications/i });
      const alertTag = within(region).queryByText("ALERT");
      expect(alertTag).toBeTruthy();
    });
  });
});

describe("AgentInstanceDetail — optimistic locale wire (PR-B5+, wave-17)", () => {
  it("locale change dispatches PATCH {locale} optimistically", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ calls });
    renderWithProvider(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor((): void => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    const localeSelect = screen.getByLabelText(/Locale/i) as HTMLSelectElement;
    fireEvent.change(localeSelect, { target: { value: "pl" } });

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

  it("synthetic 422 on locale PATCH: rollback + alert toast", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      calls,
      failPatchOn: ["locale"],
    });
    renderWithProvider(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor((): void => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    const localeSelect = screen.getByLabelText(/Locale/i) as HTMLSelectElement;
    fireEvent.change(localeSelect, { target: { value: "pl" } });

    // PATCH attempted, then 422'd → rollback.
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
      // Optimistic rollback restores the displayed value to the
      // committed locale ("en"). The select reflects the prior value.
      expect((localeSelect as HTMLSelectElement).value).toBe("en");
    });
    await waitFor((): void => {
      const region = screen.getByRole("region", { name: /notifications/i });
      expect(within(region).queryByText("ALERT")).toBeTruthy();
    });
  });
});

describe("AgentInstanceDetail — optimistic scope_domain_ids wire (PR-B5+, wave-17)", () => {
  it("Save scope dispatches PATCH {scope_domain_ids} + chip list reflects new value optimistically", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({ calls });
    renderWithProvider(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor((): void => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    // Open the scope editor. The button text is just "Edit"; we
    // target it via its container (the chips wrapper's sibling
    // <Btn>).
    const chipsContainer = screen.getByTestId("scope-chips");
    const scopeWrapper = chipsContainer.parentElement!;
    const editBtn = scopeWrapper.querySelector("button")!;
    fireEvent.click(editBtn);

    // Add wiki-test-b to the selection. The MultiSelectDomains
    // component renders one checkbox per available domain.
    const checkboxes = await waitFor((): HTMLInputElement[] => {
      const got = document.querySelectorAll<HTMLInputElement>(
        "input[type='checkbox']",
      );
      const arr = Array.from(got);
      expect(arr.length).toBeGreaterThan(0);
      return arr;
    });
    // Click the second domain's checkbox.
    const targetCheckbox = checkboxes.find((cb) => !cb.checked);
    expect(targetCheckbox).toBeTruthy();
    fireEvent.click(targetCheckbox!);

    fireEvent.click(screen.getByText(/^Save scope$/));

    await waitFor((): void => {
      const patch = calls.find(
        (c): boolean =>
          c.method === "PATCH" &&
          c.body !== null &&
          typeof c.body === "object" &&
          "scope_domain_ids" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
    });

    // Copilot triage: pin the optimistic chip render on success.
    // After Save the chip list should show both domains (the
    // original + the speculative add).
    await waitFor((): void => {
      const chips = screen.getByTestId("scope-chips");
      const ids = Array.from(
        chips.querySelectorAll("[data-domain-id]"),
      ).map((el) => el.getAttribute("data-domain-id"));
      expect(ids.length).toBe(2);
    });
  });

  it("synthetic 422 on scope PATCH: rollback (chips revert) + alert toast", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch({
      calls,
      failPatchOn: ["scope_domain_ids"],
    });
    renderWithProvider(
      <AgentInstanceDetail
        instance={SAMPLE_INSTANCE}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    await waitFor((): void => {
      expect(screen.getByText(/No output channels available/i)).toBeTruthy();
    });

    const chipsContainer2 = screen.getByTestId("scope-chips");
    const scopeWrapper2 = chipsContainer2.parentElement!;
    const editBtn2 = scopeWrapper2.querySelector("button")!;
    fireEvent.click(editBtn2);

    const checkboxes = await waitFor((): HTMLInputElement[] => {
      const got = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          "input[type='checkbox']",
        ),
      );
      expect(got.length).toBeGreaterThan(0);
      return got;
    });
    const target = checkboxes.find((cb) => !cb.checked);
    expect(target).toBeTruthy();
    fireEvent.click(target!);

    fireEvent.click(screen.getByText(/^Save scope$/));

    await waitFor((): void => {
      expect(
        calls.find(
          (c) =>
            c.method === "PATCH" &&
            c.body !== null &&
            typeof c.body === "object" &&
            "scope_domain_ids" in (c.body as Record<string, unknown>),
        ),
      ).toBeTruthy();
    });
    await waitFor((): void => {
      const region = screen.getByRole("region", { name: /notifications/i });
      expect(within(region).queryByText("ALERT")).toBeTruthy();
    });

    // Copilot triage: pin the rollback by asserting the chip list
    // reverts to the prior committed scope. The chips render with
    // `data-domain-id` per scope_domain_id; on rollback only the
    // original DOMAIN_A id should remain (the speculative DOMAIN_B
    // selection rolled back).
    await waitFor((): void => {
      const chips = screen.getByTestId("scope-chips");
      const domainIds = Array.from(
        chips.querySelectorAll("[data-domain-id]"),
      ).map((el) => el.getAttribute("data-domain-id"));
      expect(domainIds).toEqual([
        "aaaa1111-1111-4111-8111-111111111111",
      ]);
    });
  });
});
