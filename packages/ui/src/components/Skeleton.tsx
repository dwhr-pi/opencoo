/**
 * Skeleton — perceived-latency primitive (PR-B1, wave-16, phase-a
 * appendix #16). Composes three sub-components:
 *
 *   - `<Skeleton.Row mono cols={3} />` — table-row-shaped placeholder
 *     for `<tbody>` consumers. `cols` controls the cell count;
 *     `mono` switches the placeholder visual width to JetBrains
 *     Mono (used by mono-typed columns: IDs, paths, slugs).
 *   - `<Skeleton.Block height={120} />` — generic block placeholder
 *     for Card bodies, panel bodies, etc.
 *   - `<Skeleton.Field />` — input-shape placeholder; the baseline
 *     height matches the `Field.tsx` primitive's resolved height
 *     so a swap reads as the same row.
 *
 * Design-system invariants pinned here:
 *
 *   - **No animation loop.** The design-system "exactly one loop"
 *     rule reserves animation for the heartbeat-pulse on the
 *     operate glyph. Skeletons get depth via border + paper-2,
 *     not via shimmer/pulse/opacity loops. Re-adding an animation
 *     here is a regression (tests pin it).
 *   - **No drop-shadows.** Hard-no per CLAUDE.md "Design system".
 *     Depth = border + bg shift. Same recipe as `Card.tsx`.
 *   - **No fully-rounded surfaces.** Radii are capped at the
 *     design-system tokens (`--radius-m` for inputs / row cells,
 *     `--radius-l` for blocks). No pills.
 *   - **ARIA.**
 *     - `Skeleton.Row` keeps its native `<tr>` `row` role so
 *       table navigation works; `aria-busy="true"` lives on the
 *       row, and the live-region announcement lives on a
 *       `<span role="status" aria-live="polite">` inside the first
 *       cell (visually-hidden i18n "Loading…").
 *     - `Skeleton.Block` / `Skeleton.Field` render `<div>`s with
 *       `role="status" aria-live="polite" aria-busy="true"` + the
 *       same visually-hidden label.
 *     Wave-16 A4 layers a global live region on top; these per-
 *     skeleton announcements complement it.
 *
 * The consumer pattern is:
 *
 *   ```
 *   const showSkeleton = useDeferredSkeleton(rows === null);
 *   if (showSkeleton) {
 *     return (
 *       <table>
 *         <tbody>
 *           <Skeleton.Row mono cols={6} />
 *           <Skeleton.Row mono cols={6} />
 *           <Skeleton.Row mono cols={6} />
 *         </tbody>
 *       </table>
 *     );
 *   }
 *   ```
 */
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/** Visually-hidden recipe (same as the classic .sr-only pattern). */
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  borderWidth: 0,
};

/** Shared placeholder bar — used by every sub-component. */
function placeholderStyle(mono: boolean): CSSProperties {
  return {
    display: "inline-block",
    width: mono ? "80%" : "65%",
    height: "0.7em",
    background: "var(--paper-3)",
    borderRadius: "var(--radius-s)",
    verticalAlign: "middle",
    fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
  };
}

export interface SkeletonRowProps {
  /** Number of `<td>` cells to render. Default 3. */
  readonly cols?: number;
  /** When true the placeholder width mimics monospaced columns
   *  (IDs, paths) which read narrower per character. */
  readonly mono?: boolean;
}

function SkeletonRow(props: SkeletonRowProps): JSX.Element {
  const { t } = useTranslation();
  const cols = props.cols ?? 3;
  const mono = props.mono === true;
  // Empty array of fixed length so the index is stable across
  // renders and React's key warning stays quiet.
  const cells = Array.from({ length: cols });
  // The `<tr>` keeps its native `row` role (no `role="status"`
  // override) — screen-reader table navigation continues to work
  // and the placeholder cells are still exposed as `gridcell`
  // descendants. The live-region announcement lives on a `<span>`
  // INSIDE the first cell so assistive tech still announces
  // "loading" without losing table semantics. Triaged from PR-B1
  // Copilot review.
  //
  // `aria-busy="true"` is valid on any element (incl. `<tr>`) and
  // doesn't change the row role; it just signals "data not ready".
  return (
    <tr
      aria-busy="true"
      style={{
        borderBottom: "1px solid var(--paper-3)",
        background: "var(--paper-2)",
      }}
    >
      {cells.map((_, i) => (
        <td
          key={i}
          style={{
            padding: "8px 8px",
            borderRadius: "var(--radius-m)",
          }}
        >
          <span style={placeholderStyle(mono)} aria-hidden="true" />
          {i === 0 ? (
            <span
              role="status"
              aria-live="polite"
              style={VISUALLY_HIDDEN}
            >
              {t("common.loading")}
            </span>
          ) : null}
        </td>
      ))}
    </tr>
  );
}

export interface SkeletonBlockProps {
  /** Block height in pixels. Default 80. */
  readonly height?: number;
}

function SkeletonBlock(props: SkeletonBlockProps): JSX.Element {
  const { t } = useTranslation();
  const height = props.height ?? 80;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        height: `${height}px`,
        width: "100%",
        background: "var(--paper-2)",
        border: "1px solid var(--paper-3)",
        borderRadius: "var(--radius-l)",
      }}
    >
      <span style={VISUALLY_HIDDEN}>{t("common.loading")}</span>
    </div>
  );
}

function SkeletonField(): JSX.Element {
  const { t } = useTranslation();
  // Match `Field.tsx`'s input box exactly: same padding + border +
  // font-size + line-height recipe. With the global `box-sizing:
  // border-box` (app.css:10) the rendered border-box height is
  // identical, so swapping skeleton → real Field cannot trigger
  // layout shift. Triaged from PR-B1 Copilot review (a hardcoded
  // 32px did NOT match Field's actual rendered height).
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        width: "100%",
        padding: "8px 10px",
        border: "1px solid var(--paper-3)",
        borderRadius: "var(--radius-m)",
        background: "var(--paper-2)",
        fontSize: "var(--fs-body)",
        lineHeight: "var(--lh-body)",
      }}
    >
      <span style={VISUALLY_HIDDEN}>{t("common.loading")}</span>
    </div>
  );
}

export const Skeleton = {
  Row: SkeletonRow,
  Block: SkeletonBlock,
  Field: SkeletonField,
};
