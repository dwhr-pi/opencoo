/**
 * Table — props-driven shared table primitive (PR-W9, phase-a #15).
 *
 * Replaces three open-coded `<table>` instances (Reports redaction
 * events, Cost bucket breakdown, Audit log) with one component
 * sharing the design-system chrome: mono uppercase 10px column
 * headers · 13px font-sans body · 1px --rule row separators.
 *
 * The component is intentionally minimal — no sorting, no
 * pagination, no built-in click-row semantics. Each consumer
 * threads its own behaviour through `rowAttrs` (Audit's keyboard
 * + a11y + click handlers) and `renderAfterRow` (Audit's
 * accordion drill-down); the chrome is the only thing the
 * primitive owns.
 *
 * Security/design constraints:
 *   - Cells render via React text nodes only — no
 *     `dangerouslySetInnerHTML`. Callers passing a `render`
 *     callback return ReactNode trees, again via React's normal
 *     escaping.
 *   - i18n strings are resolved by the caller (each column's
 *     `label` arrives already translated). The primitive itself
 *     is locale-agnostic so the same Table renders correctly in
 *     en, pl, or any future locale.
 */
import { Fragment, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

// ─── Style tokens shared by every consumer ───────────────────────────────────

const TABLE_STYLE: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
};

const HEADER_ROW_STYLE: CSSProperties = {
  borderBottom: "1px solid var(--rule)",
};

const HEADER_CELL_BASE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  padding: "6px 8px",
};

// ─── Column / row props ──────────────────────────────────────────────────────

export interface TableColumn<R> {
  /** Stable React key for the column + arbitrary identifier the
   *  caller can match in tests / debugging. */
  readonly key: string;
  /** Already-i18n-resolved column header text. */
  readonly label: ReactNode;
  /** Optional cell renderer. Defaults to the row's `[key]` field
   *  rendered as a plain string. */
  readonly render?: (row: R) => ReactNode;
  /** When true, the cell renders monospaced (paths / IDs / counts). */
  readonly mono?: boolean;
  /** Horizontal alignment for both the header and the cells. */
  readonly align?: "left" | "right";
  /** Per-cell style overlay. Either a static CSS object or a
   *  per-row callback (rows whose tone changes — e.g. the action
   *  color in the Audit table — supply the callback). Merged on
   *  top of the computed cell style; callers can override `color`,
   *  `fontSize`, `whiteSpace` etc. without losing the table's
   *  chrome. */
  readonly cellStyle?: CSSProperties | ((row: R) => CSSProperties);
}

/** Attributes the caller injects on the row's `<tr>` element.
 *  Audit uses this for `data-testid`, `role`, `tabIndex`, the
 *  click + keyboard handlers, and the dynamic
 *  `aria-expanded`/`aria-controls` pair that ties the row to its
 *  expansion. Keeps the Table primitive ignorant of expansion
 *  semantics — the parent owns them. */
export interface TableRowAttrs {
  readonly "data-testid"?: string;
  readonly role?: string;
  readonly tabIndex?: number;
  readonly "aria-expanded"?: boolean;
  readonly "aria-controls"?: string;
  readonly style?: CSSProperties;
  readonly onClick?: () => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTableRowElement>) => void;
}

export interface TableProps<R> {
  readonly columns: ReadonlyArray<TableColumn<R>>;
  readonly rows: readonly R[];
  /** Per-row React key. Required — there is no row.id assumption. */
  readonly rowKey: (row: R) => string;
  /** Optional rendered fallback for an empty `rows` array. When
   *  omitted, an empty `<tbody>` is rendered (no fallback) — every
   *  current consumer renders its own empty state above the table
   *  for tone reasons, so leaving this opt-in keeps the migration
   *  byte-identical. */
  readonly emptyState?: ReactNode;
  /** Pass-through `data-testid` so callers can target the table
   *  (e.g. Cost's bucket-table assertion). */
  readonly testId?: string;
  /** Arbitrary additional data-* attributes passed verbatim to the
   *  `<table>` element. Used by Cost to carry `data-groupby`. */
  readonly dataAttrs?: Readonly<Record<`data-${string}`, string>>;
  /** Per-row `<tr>` attribute overrides. Audit threads its click +
   *  keyboard + a11y attributes through here so the primitive
   *  stays click-target agnostic. */
  readonly rowAttrs?: (row: R) => TableRowAttrs;
  /** Optional content rendered AFTER each row's primary `<tr>`. The
   *  return value must be valid <tbody> children (typically a
   *  single `<tr>` carrying an expanded detail panel). Audit uses
   *  this for the accordion drill-down. */
  readonly renderAfterRow?: (row: R) => ReactNode;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Table<R>(props: TableProps<R>): JSX.Element {
  const dataAttrs = props.dataAttrs ?? {};
  return (
    <table
      {...(props.testId !== undefined ? { "data-testid": props.testId } : {})}
      {...dataAttrs}
      style={TABLE_STYLE}
    >
      <thead>
        <tr style={HEADER_ROW_STYLE}>
          {props.columns.map((col) => (
            <th
              key={col.key}
              style={{
                ...HEADER_CELL_BASE,
                textAlign: col.align ?? "left",
              }}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.length === 0 && props.emptyState !== undefined ? (
          <tr>
            <td colSpan={props.columns.length} style={{ padding: 0 }}>
              {props.emptyState}
            </td>
          </tr>
        ) : (
          props.rows.map((row) => {
            const key = props.rowKey(row);
            const attrs = props.rowAttrs?.(row);
            // Caller-supplied attrs (e.g. an Audit row whose own
            // border collapses when expanded so the detail row
            // doesn't double-rule) override the default. Falling
            // back to the design-system rule means a caller that
            // doesn't pass `style` still gets the 1px --rule
            // separator below the row.
            const trStyle: CSSProperties = {
              borderBottom: "1px solid var(--rule)",
              ...(attrs?.style ?? {}),
            };
            return (
              <Fragment key={key}>
                <tr {...(attrs ?? {})} style={trStyle}>
                  {props.columns.map((col) => {
                    const overlay =
                      typeof col.cellStyle === "function"
                        ? col.cellStyle(row)
                        : (col.cellStyle ?? {});
                    return (
                      <td
                        key={col.key}
                        style={{ ...cellStyle(col), ...overlay }}
                      >
                        {col.render !== undefined
                          ? col.render(row)
                          : defaultRender(row, col.key)}
                      </td>
                    );
                  })}
                </tr>
                {props.renderAfterRow?.(row)}
              </Fragment>
            );
          })
        )}
      </tbody>
    </table>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cellStyle<R>(col: TableColumn<R>): CSSProperties {
  return {
    padding: "8px 8px",
    fontFamily: col.mono === true ? "var(--font-mono)" : "var(--font-sans)",
    fontSize: 12,
    color: "var(--ink-2)",
    textAlign: col.align ?? "left",
  };
}

function defaultRender<R>(row: R, key: string): ReactNode {
  if (typeof row === "object" && row !== null && key in (row as object)) {
    const value = (row as Record<string, unknown>)[key];
    if (value === null || value === undefined) return "";
    return String(value);
  }
  return "";
}
