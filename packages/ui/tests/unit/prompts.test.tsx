/**
 * Prompts UI tests — per-domain prompt-override editor
 * (PR-W7a, phase-a appendix #15).
 *
 * Pinned scenarios (only the load-bearing ones — the route is
 * UI-heavy, but the critical paths are the preview/apply
 * sovereignty flow + drift surfacing + isStale banner):
 *
 *   1. picks a prompt → loads baseline body for the default
 *      domain + EN locale
 *   2. preview → DiffPreviewDialog opens with the line-level
 *      diff + token countdown
 *   3. apply → POSTs apply with baselineVersion echoed back +
 *      shows the healthy-green applied toast
 *   4. apply that gets a 422 baseline_version_drifted → drift
 *      banner appears with previewBaselineVersion vs
 *      currentBaselineVersion + Re-fork button
 *   5. isStale=true override → stale badge renders
 *   6. lagging-overrides banner aggregates `isStale` rows
 *      across multiple domains
 *   7. revert (DELETE) — open modal, ack, confirm, DELETE
 *      fires, applied-toast updates
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Prompts } from "../../src/routes/Prompts.js";

const DOMAIN_A = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "wiki-exec",
  name: "Exec wiki",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: null,
  bindingCount: 0,
};

const DOMAIN_B = {
  id: "22222222-2222-2222-2222-222222222222",
  slug: "wiki-ops",
  name: "Ops wiki",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: null,
  bindingCount: 0,
};

const BASELINE_BODY = "the shipped baseline body";
const OVERRIDE_BODY = "the override body";
const PROPOSED_BODY = "the proposed body";

interface FetchSpec {
  /** Per-domain prompts list — keyed by domain id. */
  readonly overridesByDomain?: Readonly<Record<string, ReadonlyArray<{
    readonly name: string;
    readonly locale: string;
    readonly overridesVersion: string;
    readonly baselineVersion: string;
    readonly isStale: boolean;
    readonly updatedAt: string;
    readonly updatedByUsername: string | null;
  }>>>;
  /** GET single response. */
  readonly singleResponse?: {
    readonly name: string;
    readonly locale: string;
    readonly scope: string;
    readonly body: string;
    readonly version: string;
    readonly source: "baseline" | "override";
    readonly baselineVersion?: string;
    readonly isStale?: boolean;
  };
  /** Preview response shape. */
  readonly previewResponse?: {
    readonly diff: ReadonlyArray<{
      readonly op: "same" | "add" | "del";
      readonly line: string;
      readonly index: number;
    }>;
    readonly token: string;
    readonly expiresAt: number;
    readonly baselineVersion: string;
    readonly currentSource: "baseline" | "override";
  };
  /** Apply response — `{ok: true, ...}` for success; `{status:
   *  422, body: {...}}` for the drift path. */
  readonly applyResponse?:
    | { readonly ok: true }
    | { readonly status: number; readonly body: Record<string, unknown> };
  readonly onDelete?: () => void;
}

function makeFetchMock(spec: FetchSpec): {
  readonly fetchImpl: ReturnType<typeof vi.fn>;
  readonly applyCalls: () => Array<unknown>;
} {
  const applyCalls: Array<unknown> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/admin/prompts" && method === "GET") {
      return new Response(
        JSON.stringify({
          entries: [
            { name: "heartbeat", locales: [{ locale: "en", version: "1.2.0" }] },
            { name: "classifier", locales: [{ locale: "en", version: "1.0.0" }] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "/api/admin/domains" && method === "GET") {
      return new Response(
        JSON.stringify({ rows: [DOMAIN_A, DOMAIN_B] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const listMatch = url.match(/^\/api\/admin\/domains\/([^/]+)\/prompts$/);
    if (listMatch !== null && method === "GET") {
      const domainId = listMatch[1]!;
      const overrides = spec.overridesByDomain?.[domainId] ?? [];
      return new Response(
        JSON.stringify({ overrides, baselines: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const singleMatch = url.match(
      /^\/api\/admin\/domains\/([^/]+)\/prompts\/([^/]+)\/([^/]+)$/,
    );
    if (singleMatch !== null && method === "GET") {
      return new Response(
        JSON.stringify(spec.singleResponse ?? {
          name: singleMatch[2],
          locale: singleMatch[3],
          scope: "domains",
          body: BASELINE_BODY,
          version: "1.2.0",
          source: "baseline",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      singleMatch === null &&
      url.match(/^\/api\/admin\/domains\/[^/]+\/prompts\/[^/]+\/[^/]+\/preview$/) !==
        null &&
      method === "POST"
    ) {
      return new Response(
        JSON.stringify(spec.previewResponse ?? {
          diff: [{ op: "add", line: "new line", index: 0 }],
          token: "test.token",
          expiresAt: Date.now() + 300_000,
          baselineVersion: "1.2.0",
          currentSource: "baseline",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url.match(/^\/api\/admin\/domains\/[^/]+\/prompts\/[^/]+\/[^/]+\/apply$/) !==
        null &&
      method === "POST"
    ) {
      let bodyJson: unknown = null;
      try {
        bodyJson = init?.body ? JSON.parse(init.body as string) : null;
      } catch {
        // ignore
      }
      applyCalls.push(bodyJson);
      const r = spec.applyResponse ?? { ok: true };
      if ("ok" in r) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }
    const deleteMatch = url.match(
      /^\/api\/admin\/domains\/[^/]+\/prompts\/[^/]+\/[^/]+$/,
    );
    if (deleteMatch !== null && method === "DELETE") {
      spec.onDelete?.();
      return new Response(JSON.stringify({ ok: true, deleted: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/admin/_csrf") {
      return new Response(
        JSON.stringify({ csrfToken: "csrf-1", username: "alice" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl, applyCalls: (): Array<unknown> => applyCalls };
}

describe("Prompts route (PR-W7a)", () => {
  it("picks a prompt and shows the baseline body in the editor", async () => {
    const user = userEvent.setup();
    const { fetchImpl } = makeFetchMock({});
    render(<Prompts fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() =>
      expect(screen.getByTestId("prompt-pick-heartbeat")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("prompt-pick-heartbeat"));
    await waitFor(() =>
      expect(
        screen.getByTestId("prompt-body-textarea") as HTMLTextAreaElement,
      ).toHaveValue(BASELINE_BODY),
    );
    expect(screen.getByTestId("source-chip-baseline")).toBeInTheDocument();
  });

  it("preview → DiffPreviewDialog with line-level diff", async () => {
    const user = userEvent.setup();
    const { fetchImpl } = makeFetchMock({});
    render(<Prompts fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() =>
      expect(screen.getByTestId("prompt-pick-heartbeat")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("prompt-pick-heartbeat"));
    const textarea = (await screen.findByTestId(
      "prompt-body-textarea",
    )) as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, PROPOSED_BODY);
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(screen.getByTestId("diff-list")).toBeInTheDocument(),
    );
    // Line-level diff rendered with `+ new line` marker.
    expect(screen.getByTestId("line-pro-add-0")).toBeInTheDocument();
  });

  it("apply success → POSTs body with baselineVersion echoed + shows applied toast", async () => {
    const user = userEvent.setup();
    const { fetchImpl, applyCalls } = makeFetchMock({});
    render(<Prompts fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() =>
      expect(screen.getByTestId("prompt-pick-heartbeat")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("prompt-pick-heartbeat"));
    const textarea = (await screen.findByTestId(
      "prompt-body-textarea",
    )) as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, PROPOSED_BODY);
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(screen.getByTestId("diff-list")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() => expect(applyCalls()).toHaveLength(1));
    const body = applyCalls()[0] as {
      proposedBody: string;
      token: string;
      confirmDiff: boolean;
      baselineVersion: string;
    };
    expect(body.proposedBody).toBe(PROPOSED_BODY);
    expect(body.token).toBe("test.token");
    expect(body.confirmDiff).toBe(true);
    expect(body.baselineVersion).toBe("1.2.0");
    await waitFor(() =>
      expect(screen.getByTestId("applied-notice")).toBeInTheDocument(),
    );
  });

  it("apply 422 baseline_version_drifted → drift banner + Re-fork", async () => {
    const user = userEvent.setup();
    const { fetchImpl } = makeFetchMock({
      applyResponse: {
        status: 422,
        body: {
          error: "baseline_version_drifted",
          previewBaselineVersion: "1.2.0",
          currentBaselineVersion: "1.3.0",
        },
      },
    });
    render(<Prompts fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() =>
      expect(screen.getByTestId("prompt-pick-heartbeat")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("prompt-pick-heartbeat"));
    const textarea = (await screen.findByTestId(
      "prompt-body-textarea",
    )) as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.type(textarea, "drift-body");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(screen.getByTestId("diff-list")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() =>
      expect(screen.getByTestId("drift-banner")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("drift-banner").textContent).toMatch(/1\.2\.0/);
    expect(screen.getByTestId("drift-banner").textContent).toMatch(/1\.3\.0/);
    expect(
      screen.getByRole("button", { name: /re-fork from new baseline/i }),
    ).toBeInTheDocument();
  });

  it("renders the isStale badge when the override is stale", async () => {
    const user = userEvent.setup();
    const { fetchImpl } = makeFetchMock({
      singleResponse: {
        name: "heartbeat",
        locale: "en",
        scope: "domains",
        body: OVERRIDE_BODY,
        version: "1.0.1",
        source: "override",
        baselineVersion: "1.0.0",
        isStale: true,
      },
    });
    render(<Prompts fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() =>
      expect(screen.getByTestId("prompt-pick-heartbeat")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("prompt-pick-heartbeat"));
    await waitFor(() =>
      expect(screen.getByTestId("stale-badge")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("stale-badge").textContent).toMatch(/1\.0\.0/);
  });

  it("lagging-overrides banner aggregates isStale rows across domains", async () => {
    const { fetchImpl } = makeFetchMock({
      overridesByDomain: {
        [DOMAIN_A.id]: [
          {
            name: "heartbeat",
            locale: "en",
            overridesVersion: "1.0.0",
            baselineVersion: "0.9.0",
            isStale: true,
            updatedAt: "2026-01-01T00:00:00Z",
            updatedByUsername: "alice",
          },
        ],
        [DOMAIN_B.id]: [
          {
            name: "compiler",
            locale: "pl",
            overridesVersion: "1.0.2",
            baselineVersion: "0.8.0",
            isStale: true,
            updatedAt: "2026-01-02T00:00:00Z",
            updatedByUsername: "bob",
          },
        ],
      },
    });
    render(<Prompts fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() =>
      expect(screen.getByTestId("prompts-diff-banner")).toBeInTheDocument(),
    );
    const banner = screen.getByTestId("prompts-diff-banner");
    expect(banner.textContent).toContain("heartbeat");
    expect(banner.textContent).toContain("compiler");
    expect(banner.textContent).toContain("wiki-exec");
    expect(banner.textContent).toContain("wiki-ops");
  });

  it("revert flow: opens modal, requires ack, DELETE fires on confirm", async () => {
    const user = userEvent.setup();
    let deleted = false;
    const { fetchImpl } = makeFetchMock({
      singleResponse: {
        name: "heartbeat",
        locale: "en",
        scope: "domains",
        body: OVERRIDE_BODY,
        version: "1.0.1",
        source: "override",
        baselineVersion: "1.2.0",
        isStale: false,
      },
      onDelete: (): void => {
        deleted = true;
      },
    });
    render(<Prompts fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await waitFor(() =>
      expect(screen.getByTestId("prompt-pick-heartbeat")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("prompt-pick-heartbeat"));
    await waitFor(() =>
      expect(screen.getByTestId("revert-btn")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("revert-btn"));
    // Confirm button starts disabled until the ack box is ticked.
    const confirmBtn = (await screen.findByTestId(
      "revert-confirm-btn",
    )) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    await user.click(screen.getByTestId("revert-ack-checkbox"));
    expect(confirmBtn.disabled).toBe(false);
    await user.click(confirmBtn);
    await waitFor(() => expect(deleted).toBe(true));
  });
});
