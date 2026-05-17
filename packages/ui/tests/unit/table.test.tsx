/**
 * Table primitive (PR-W9, phase-a appendix #15).
 *
 * Pin matrix:
 *   1. Renders headers and rows with the supplied labels.
 *   2. The default cell renderer pulls `row[col.key]` when no
 *      `render` callback is supplied.
 *   3. `cellStyle` as a static object overrides the chrome colour.
 *   4. `cellStyle` as a per-row callback receives the row.
 *   5. `rowAttrs` forwards `role`, `tabIndex`, `aria-expanded`,
 *      `aria-controls`, `data-testid`, click + keyDown to the
 *      rendered `<tr>` and merges its `style` over the default
 *      rule-bottom.
 *   6. `renderAfterRow` content lands directly after the row's
 *      primary `<tr>` inside the same tbody, in render order.
 *   7. `testId` + `dataAttrs` propagate to the outer `<table>`.
 *   8. No `dangerouslySetInnerHTML` reaches the DOM (smoke check
 *      on a row that returns a span via `render`).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { Table, type TableColumn } from "../../src/components/Table.js";

interface Row {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

const ROWS: readonly Row[] = [
  { id: "a", name: "alpha", count: 1 },
  { id: "b", name: "beta", count: 2 },
];

const COLUMNS: ReadonlyArray<TableColumn<Row>> = [
  { key: "name", label: "name", mono: true },
  { key: "count", label: "count", mono: true, align: "right" },
];

describe("Table — render", () => {
  it("renders headers and the default cell for each row", () => {
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        testId="t-default"
      />,
    );

    const table = screen.getByTestId("t-default");
    expect(within(table).getByText("name")).toBeInTheDocument();
    expect(within(table).getByText("count")).toBeInTheDocument();
    expect(within(table).getByText("alpha")).toBeInTheDocument();
    expect(within(table).getByText("beta")).toBeInTheDocument();
    expect(within(table).getByText("1")).toBeInTheDocument();
    expect(within(table).getByText("2")).toBeInTheDocument();
  });

  it("applies a static cellStyle override on top of the chrome", () => {
    const columns: ReadonlyArray<TableColumn<Row>> = [
      {
        key: "name",
        label: "name",
        cellStyle: { color: "var(--alert)" },
        render: (row) => row.name,
      },
    ];
    render(
      <Table
        columns={columns}
        rows={ROWS}
        rowKey={(r) => r.id}
        testId="t-static"
      />,
    );
    const td = within(screen.getByTestId("t-static")).getByText("alpha");
    expect(td.getAttribute("style")).toContain("color: var(--alert)");
  });

  it("applies a per-row cellStyle callback", () => {
    const columns: ReadonlyArray<TableColumn<Row>> = [
      {
        key: "name",
        label: "name",
        cellStyle: (row) => ({
          color: row.count > 1 ? "var(--alert)" : "var(--healthy)",
        }),
        render: (row) => row.name,
      },
    ];
    render(
      <Table
        columns={columns}
        rows={ROWS}
        rowKey={(r) => r.id}
        testId="t-cb"
      />,
    );
    const alphaCell = within(screen.getByTestId("t-cb")).getByText("alpha");
    const betaCell = within(screen.getByTestId("t-cb")).getByText("beta");
    expect(alphaCell.getAttribute("style")).toContain("color: var(--healthy)");
    expect(betaCell.getAttribute("style")).toContain("color: var(--alert)");
  });
});

describe("Table — rowAttrs + renderAfterRow", () => {
  it("forwards click + keyboard + a11y attrs to the row's <tr>", () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        rowAttrs={(row) => ({
          "data-testid": `row-${row.id}`,
          role: "button",
          tabIndex: 0,
          "aria-expanded": row.id === "a",
          "aria-controls": `detail-${row.id}`,
          onClick,
          onKeyDown,
          style: { background: "var(--paper-2)" },
        })}
      />,
    );

    const rowA = screen.getByTestId("row-a");
    expect(rowA).toHaveAttribute("role", "button");
    expect(rowA).toHaveAttribute("tabIndex", "0");
    expect(rowA).toHaveAttribute("aria-expanded", "true");
    expect(rowA).toHaveAttribute("aria-controls", "detail-a");
    // The default 1px --rule bottom is still present; the caller's
    // background overlay is merged in alongside.
    const style = rowA.getAttribute("style") ?? "";
    expect(style).toContain("border-bottom");
    expect(style).toContain("var(--paper-2)");

    fireEvent.click(rowA);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(rowA, { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("renders renderAfterRow content directly after the primary <tr>", () => {
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        rowAttrs={(row) => ({ "data-testid": `row-${row.id}` })}
        renderAfterRow={(row) =>
          row.id === "a" ? (
            <tr data-testid="detail-a">
              <td colSpan={2}>detail for {row.name}</td>
            </tr>
          ) : null
        }
      />,
    );

    const detail = screen.getByTestId("detail-a");
    expect(detail).toBeInTheDocument();
    expect(detail.textContent).toContain("detail for alpha");
    // Detail row only rendered for row "a".
    expect(screen.queryByTestId("detail-b")).not.toBeInTheDocument();
  });
});

describe("Table — table-level data attrs + safety", () => {
  it("propagates dataAttrs to the <table> element", () => {
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        testId="t-data"
        dataAttrs={{ "data-groupby": "domain" }}
      />,
    );
    const table = screen.getByTestId("t-data");
    expect(table.tagName.toLowerCase()).toBe("table");
    expect(table).toHaveAttribute("data-groupby", "domain");
  });

  it("never reaches DOM via dangerouslySetInnerHTML — cells are React text", () => {
    const columns: ReadonlyArray<TableColumn<Row>> = [
      {
        key: "name",
        label: "name",
        render: (row) => <span>{`<script>${row.name}</script>`}</span>,
      },
    ];
    render(
      <Table
        columns={columns}
        rows={[{ id: "a", name: "alpha", count: 1 }]}
        rowKey={(r) => r.id}
        testId="t-safe"
      />,
    );
    const table = screen.getByTestId("t-safe");
    // The rendered text is the literal angle-bracketed string,
    // never a parsed <script> element — React escapes text nodes.
    expect(table.querySelector("script")).toBeNull();
    expect(within(table).getByText("<script>alpha</script>")).toBeInTheDocument();
  });
});
