/**
 * Shared `ContentKind` enum + the single fenced-block info-string
 * the compiler uses for catalog-workflow pages.
 *
 * Promoted out of `source-drive`'s local binding-config in
 * PR 26 (plan #122) so:
 *   - source-drive's binding-config and source-n8n's binding-
 *     config import from one source of truth (avoiding the
 *     "two enums, one literal" drift class),
 *   - the compiler-side dispatch in `compilation-worker.ts` keys
 *     on the same enum the adapters set,
 *   - the catalog-workflow fenced-block info-string is the SAME
 *     string as the `'n8n-workflow'` content-kind value (they are
 *     deliberately one constant).
 *
 * v0.1 ships three values:
 *   - `'document'` — Drive docs / PDFs / arbitrary text. The
 *     two-pass classify→compile path with LLM merge.
 *   - `'n8n-workflow'` — n8n workflow JSON (PR 26). Routed to the
 *     deterministic `compileCatalogWorkflow` template; no LLM.
 *   - `'skill-bundle'` — Builder-skill `.skill` directories
 *     (PR 33+). Reserved for phase-b; the v0.1 compiler does
 *     not implement this branch.
 */

export const CONTENT_KINDS = [
  "document",
  "n8n-workflow",
  "skill-bundle",
] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

/**
 * Fenced-block info-string used by the catalog-workflow compiler
 * template. Deliberately equal to the `'n8n-workflow'` content
 * kind — the markdown fence and the routing key are one constant.
 *
 * Compiler emits ` ```n8n-workflow\n<JSON.stringify(workflow, null, 2)>\n``` `;
 * parser expects the same info-string when reading a catalog page
 * back for round-trip.
 */
export const CATALOG_WORKFLOW_FENCE_LANG: ContentKind = "n8n-workflow";
