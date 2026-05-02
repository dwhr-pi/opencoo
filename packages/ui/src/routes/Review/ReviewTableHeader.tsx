/**
 * Shared `<thead>` row for the three Review Dashboard sub-views.
 *
 * Renders mono-uppercase column labels with the design-system rule
 * border below — the same chrome SourceBindingsReview, LintFindings,
 * and SurfacerCandidates each need.
 */
export interface ReviewTableHeaderProps {
  readonly columns: readonly string[];
}

export function ReviewTableHeader(props: ReviewTableHeaderProps): JSX.Element {
  return (
    <thead>
      <tr style={{ borderBottom: "1px solid var(--rule)" }}>
        {props.columns.map((col) => (
          <th
            key={col}
            style={{
              textAlign: "left",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              padding: "6px 8px",
            }}
          >
            {col}
          </th>
        ))}
      </tr>
    </thead>
  );
}
