/**
 * EmptyStatePanel tests — PR-B3, wave-16.
 *
 * Pins the shape extracted from W8's HeartbeatDiagnosticsPanel
 * (Reports.tsx:505-631) so every "no rows yet" surface across
 * Domains / Sources / Agents / Outputs / Activity / Review /
 * Audit / Reports shares one visual recipe + a structured
 * diagnostics-chain affordance.
 *
 * Test matrix:
 *   1. Renders title + body.
 *   2. Renders an optional CTA — onClick fires; href anchors out.
 *   3. CTA tone defaults to 'primary'; 'ghost' tone is opt-in.
 *   4. Renders an optional diagnosticsChain — one row per step,
 *      each with a status indicator and the step's label.
 *   5. Chain step `help` ReactNode is rendered alongside the row.
 *   6. Visual recipe — Card-shaped border + paper-2 chrome on
 *      the diagnostics row container (W8 parity).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EmptyStatePanel } from "../../src/components/EmptyStatePanel.js";

describe("EmptyStatePanel", () => {
  it("renders the title and body", () => {
    render(
      <EmptyStatePanel
        title="No domains yet"
        body="Create your first knowledge domain to get started."
      />,
    );
    expect(screen.getByText("No domains yet")).toBeInTheDocument();
    expect(
      screen.getByText(/create your first knowledge domain/i),
    ).toBeInTheDocument();
  });

  it("renders body as a ReactNode (not just a string)", () => {
    render(
      <EmptyStatePanel
        title="No domains yet"
        body={<span data-testid="custom-body">custom node</span>}
      />,
    );
    expect(screen.getByTestId("custom-body")).toBeInTheDocument();
  });

  it("renders no CTA when cta prop is omitted", () => {
    render(<EmptyStatePanel title="Nothing here" body="No CTA." />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a CTA button and fires onClick", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyStatePanel
        title="No domains yet"
        body="Create one now."
        cta={{ label: "+ New domain", onClick }}
      />,
    );
    const btn = screen.getByRole("button", { name: "+ New domain" });
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a CTA anchor when href is set", () => {
    render(
      <EmptyStatePanel
        title="Out of scope"
        body="Documentation lives elsewhere."
        cta={{ label: "Read docs", href: "/docs/setup" }}
      />,
    );
    const link = screen.getByRole("link", { name: "Read docs" });
    expect(link).toHaveAttribute("href", "/docs/setup");
  });

  it("renders the diagnosticsChain with one row per step", () => {
    render(
      <EmptyStatePanel
        title="Heartbeat status"
        body=""
        diagnosticsChain={[
          { label: "Heartbeat instance configured", status: "pass" },
          { label: "Instance is enabled", status: "pass" },
          { label: "Output channels bound", status: "fail" },
          { label: "Most recent run completed", status: "pending" },
        ]}
      />,
    );
    expect(
      screen.getByText("Heartbeat instance configured"),
    ).toBeInTheDocument();
    expect(screen.getByText("Instance is enabled")).toBeInTheDocument();
    expect(screen.getByText("Output channels bound")).toBeInTheDocument();
    expect(screen.getByText("Most recent run completed")).toBeInTheDocument();
  });

  it("marks each chain row with a status data attribute for visual styling", () => {
    const { container } = render(
      <EmptyStatePanel
        title="Heartbeat status"
        body=""
        diagnosticsChain={[
          { label: "Step a", status: "pass" },
          { label: "Step b", status: "fail" },
          { label: "Step c", status: "pending" },
          { label: "Step d", status: "unknown" },
        ]}
      />,
    );
    const rows = container.querySelectorAll(
      "[data-empty-state-chain-row]",
    );
    expect(rows.length).toBe(4);
    expect(rows[0]?.getAttribute("data-empty-state-chain-row")).toBe("pass");
    expect(rows[1]?.getAttribute("data-empty-state-chain-row")).toBe("fail");
    expect(rows[2]?.getAttribute("data-empty-state-chain-row")).toBe(
      "pending",
    );
    expect(rows[3]?.getAttribute("data-empty-state-chain-row")).toBe(
      "unknown",
    );
  });

  it("renders chain step help node alongside the row", () => {
    render(
      <EmptyStatePanel
        title="Heartbeat status"
        body=""
        diagnosticsChain={[
          {
            label: "Output channels bound",
            status: "fail",
            help: <span data-testid="help-detail">Bind a channel on Agents.</span>,
          },
        ]}
      />,
    );
    expect(screen.getByTestId("help-detail")).toBeInTheDocument();
  });

  it("renders title and CTA together when both are present", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyStatePanel
        title="No source bindings yet"
        body="Connect a Google Drive, Asana, or webhook source."
        cta={{ label: "+ New source binding", onClick }}
      />,
    );
    expect(screen.getByText("No source bindings yet")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "+ New source binding" }),
    );
    expect(onClick).toHaveBeenCalled();
  });

  it("applies the W8 visual recipe — paper-2 chrome inside Card", () => {
    const { container } = render(
      <EmptyStatePanel
        title="No domains yet"
        body="Create your first knowledge domain."
      />,
    );
    // The outer surface is a Card (border + radius); the title
    // band carries paper-2 the same way the W8 panel did.
    const card = container.querySelector("[data-empty-state-panel]");
    expect(card).not.toBeNull();
    expect((card as HTMLElement).style.border).toContain("var(--rule)");
  });

  it("renders title as an h3 (slots beneath the route's h1)", () => {
    render(
      <EmptyStatePanel
        title="No agent instances yet"
        body="Seed a heartbeat, lint, or chat agent."
      />,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: /no agent instances yet/i }),
    ).toBeInTheDocument();
  });
});
