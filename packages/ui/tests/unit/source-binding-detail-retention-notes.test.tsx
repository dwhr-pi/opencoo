/**
 * SourceBindingDetail — RetentionOverridePanel + NotesPanel
 * (PR-W5-UI, phase-a appendix #15).
 *
 * Pins:
 *   1. Retention input renders the persisted override (or empty +
 *      placeholder when null).
 *   2. Retention save dispatches PATCH `/api/admin/source-bindings/:id`
 *      with `{retention_days_override: number}`.
 *   3. Retention clear (blank input) dispatches PATCH with
 *      `{retention_days_override: null}`.
 *   4. Retention 422 (out-of-range) surfaces an inline error and does
 *      NOT bump onChanged.
 *   5. Retention 200 + `noOp: true` surfaces the no-changes status and
 *      does NOT bump onChanged.
 *   6. Notes save dispatches PATCH with `{notes: <non-empty string>}`.
 *   7. Notes clear button dispatches PATCH with `{notes: null}`.
 *   8. Notes over-cap content blocks Save (no PATCH issued).
 */
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourceBindingDetail } from "../../src/components/SourceBindingDetail.js";
import type { SourceBinding } from "../../src/types.js";

const BINDING_ID = "bbbb1111-2222-3333-4444-555555555555";

function makeBinding(overrides: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: BINDING_ID,
    domainSlug: "wiki-test",
    adapterSlug: "drive",
    reviewMode: "auto",
    enabled: true,
    notes: null,
    name: "drive → wiki-test",
    status: "healthy",
    lastEventAt: null,
    lastError: null,
    pendingEventsCount: 0,
    sigFailCount24h: 0,
    retentionDaysOverride: null,
    domainRetentionDays: 90,
    ...overrides,
  };
}

interface PatchExpectation {
  readonly response: {
    readonly status: number;
    readonly body: Record<string, unknown>;
  };
}

function makeFetchImpl(expected: PatchExpectation): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (
      url === `/api/admin/source-bindings/${BINDING_ID}` &&
      init?.method === "PATCH"
    ) {
      return new Response(JSON.stringify(expected.response.body), {
        status: expected.response.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("SourceBindingDetail — RetentionOverridePanel (PR-W5-UI)", () => {
  it("renders the current override value when set", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({ retentionDaysOverride: 30 })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const input = document.querySelector(
      "[data-testid='retention-override-input']",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("30");
  });

  it("renders empty input when override is null and surfaces domain default in helper", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({
          retentionDaysOverride: null,
          domainRetentionDays: 90,
        })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const input = document.querySelector(
      "[data-testid='retention-override-input']",
    ) as HTMLInputElement;
    expect(input.value).toBe("");
    // The helper copy interpolates the domain default into the text.
    const panel = document.querySelector(
      "[data-testid='retention-override-panel']",
    ) as HTMLElement;
    expect(panel.textContent).toContain("90");
  });

  it("Save dispatches PATCH with the typed value and bumps onChanged", async () => {
    const user = userEvent.setup();
    const fetchImpl = makeFetchImpl({
      response: {
        status: 200,
        body: { id: BINDING_ID, retention_days_override: 45 },
      },
    });
    const onChanged = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding({ retentionDaysOverride: null })}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const input = document.querySelector(
      "[data-testid='retention-override-input']",
    ) as HTMLInputElement;
    await user.type(input, "45");
    const panel = document.querySelector(
      "[data-testid='retention-override-panel']",
    ) as HTMLElement;
    const saveBtn = panel.querySelector("button")!;
    await user.click(saveBtn);
    await waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true);
    });
    const patchCall = fetchImpl.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body).toEqual({ retention_days_override: 45 });
    expect(onChanged).toHaveBeenCalled();
  });

  it("blank input dispatches PATCH with retention_days_override: null", async () => {
    const user = userEvent.setup();
    const fetchImpl = makeFetchImpl({
      response: {
        status: 200,
        body: { id: BINDING_ID, retention_days_override: null },
      },
    });
    render(
      <SourceBindingDetail
        binding={makeBinding({ retentionDaysOverride: 30 })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const input = document.querySelector(
      "[data-testid='retention-override-input']",
    ) as HTMLInputElement;
    await user.clear(input);
    const panel = document.querySelector(
      "[data-testid='retention-override-panel']",
    ) as HTMLElement;
    await user.click(panel.querySelector("button")!);
    await waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true);
    });
    const patchCall = fetchImpl.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body).toEqual({ retention_days_override: null });
  });

  it("client-side gate rejects out-of-range values (>365) without dispatching PATCH", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn(
      async (
        input: RequestInfo,
        init?: RequestInit,
      ): Promise<Response> => {
        void input;
        void init;
        return new Response("nope", { status: 404 });
      },
    );
    render(
      <SourceBindingDetail
        binding={makeBinding({ retentionDaysOverride: null })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const input = document.querySelector(
      "[data-testid='retention-override-input']",
    ) as HTMLInputElement;
    await user.type(input, "9999");
    const panel = document.querySelector(
      "[data-testid='retention-override-panel']",
    ) as HTMLElement;
    await user.click(panel.querySelector("button")!);
    expect(
      fetchImpl.mock.calls.some(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(false);
    const errorEl = document.querySelector(
      "[data-testid='retention-override-error']",
    );
    expect(errorEl).not.toBeNull();
  });

  it("422 from server surfaces inline error and does NOT bump onChanged", async () => {
    const user = userEvent.setup();
    // Bypass the client-side gate by typing a value the gate allows
    // (within 1..365), then have the server reject with 422 — this
    // pins the error-mapping branch.
    const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === `/api/admin/source-bindings/${BINDING_ID}` &&
        init?.method === "PATCH"
      ) {
        return new Response(JSON.stringify({ error: "validation_failed" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const onChanged = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding({ retentionDaysOverride: null })}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const input = document.querySelector(
      "[data-testid='retention-override-input']",
    ) as HTMLInputElement;
    await user.type(input, "30");
    const panel = document.querySelector(
      "[data-testid='retention-override-panel']",
    ) as HTMLElement;
    await user.click(panel.querySelector("button")!);
    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='retention-override-error']"),
      ).not.toBeNull();
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("200 + noOp surfaces the no-changes status and does NOT bump onChanged", async () => {
    const user = userEvent.setup();
    const fetchImpl = makeFetchImpl({
      response: {
        status: 200,
        body: { id: BINDING_ID, noOp: true },
      },
    });
    const onChanged = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding({ retentionDaysOverride: 30 })}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const panel = document.querySelector(
      "[data-testid='retention-override-panel']",
    ) as HTMLElement;
    await user.click(panel.querySelector("button")!);
    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='retention-override-noop']"),
      ).not.toBeNull();
    });
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("SourceBindingDetail — NotesPanel (PR-W5-UI)", () => {
  it("pre-fills the textarea with persisted notes", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    render(
      <SourceBindingDetail
        binding={makeBinding({ notes: "ops-only pilot" })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl}
      />,
    );
    const ta = document.querySelector(
      "[data-testid='notes-textarea']",
    ) as HTMLTextAreaElement;
    expect(ta.value).toBe("ops-only pilot");
  });

  it("Save dispatches PATCH with non-empty notes string", async () => {
    const user = userEvent.setup();
    const fetchImpl = makeFetchImpl({
      response: {
        status: 200,
        body: { id: BINDING_ID, updated: true },
      },
    });
    const onChanged = vi.fn();
    render(
      <SourceBindingDetail
        binding={makeBinding({ notes: null })}
        onClose={() => undefined}
        onChanged={onChanged}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const ta = document.querySelector(
      "[data-testid='notes-textarea']",
    ) as HTMLTextAreaElement;
    await user.type(ta, "ops-only pilot");
    const panel = document.querySelector(
      "[data-testid='notes-panel']",
    ) as HTMLElement;
    const saveBtn = panel.querySelector("button")!;
    await user.click(saveBtn);
    await waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true);
    });
    const patchCall = fetchImpl.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body).toEqual({ notes: "ops-only pilot" });
    expect(onChanged).toHaveBeenCalled();
  });

  it("Clear notes dispatches PATCH with notes: null", async () => {
    const user = userEvent.setup();
    const fetchImpl = makeFetchImpl({
      response: {
        status: 200,
        body: { id: BINDING_ID, updated: true },
      },
    });
    render(
      <SourceBindingDetail
        binding={makeBinding({ notes: "old label" })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const panel = document.querySelector(
      "[data-testid='notes-panel']",
    ) as HTMLElement;
    // The panel has two buttons: Save (index 0) and Clear (index 1).
    const buttons = panel.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const clearBtn = buttons.item(1) as HTMLButtonElement;
    await user.click(clearBtn);
    await waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(
          (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true);
    });
    const patchCall = fetchImpl.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body).toEqual({ notes: null });
  });

  it("over-cap content blocks Save and surfaces inline error", () => {
    const fetchImpl = vi.fn(
      async (
        input: RequestInfo,
        init?: RequestInit,
      ): Promise<Response> => {
        void input;
        void init;
        return new Response("nope", { status: 404 });
      },
    );
    // Pre-populate notes with a value > 4096 chars so the panel renders
    // in over-cap state without needing user-event to type a long string
    // (slow in jsdom). The Save button is disabled in this state and the
    // char-count chip carries the over-cap value.
    const over = "a".repeat(4097);
    render(
      <SourceBindingDetail
        binding={makeBinding({ notes: over })}
        onClose={() => undefined}
        onChanged={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const panel = document.querySelector(
      "[data-testid='notes-panel']",
    ) as HTMLElement;
    const saveBtn = panel.querySelector("button") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    const chip = document.querySelector(
      "[data-testid='notes-char-count']",
    ) as HTMLElement;
    expect(chip.textContent).toContain("4097");
    expect(
      fetchImpl.mock.calls.some(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(false);
  });
});
