/**
 * Minimal n8n REST listing surface (PR 26 / plan #122).
 *
 * The SourceAdapter consumes ONLY this method from an n8n
 * client. Use-case-tier tests inject a mock that fulfills the
 * shape; production wiring (PR 30 composition root) wraps a
 * fetch-based client around this interface.
 *
 * NOTE: this is INTENTIONALLY a different interface from
 * `N8nLikeApi` in `@opencoo/automation-n8n-mcp` (PR 25). The
 * automation adapter's API is for `createWorkflow` (deploy);
 * this adapter's API is for read-only listing (the catalog
 * scanner). Different concerns, different interfaces — sharing
 * would couple two adapter packages around a moving target.
 */
export interface N8nListWorkflowsArgs {
  /** Bearer token resolved from the CredentialStore at scan time. */
  readonly bearerToken: string;
  /** n8n base URL — `https://n8n.example.com`. */
  readonly baseUrl: string;
  /** Tag whitelist forwarded to n8n's `?tag=` query. */
  readonly tagFilter: readonly string[];
  /** Optional ISO-8601 since-timestamp; first scan passes
   *  `undefined`. */
  readonly since?: string;
}

export interface N8nWorkflowSummary {
  /** n8n workflow id. */
  readonly id: string;
  readonly name: string;
  /** True when the operator activated this workflow in the n8n UI.
   *  Read-only here; the listing adapter does NOT mutate this. */
  readonly active: boolean;
  /** Tag list in the order n8n returned them. */
  readonly tags: readonly string[];
  /** Workflow body — the n8n REST API returns the full body on
   *  the listing endpoint. v0.1 inlines the body so the Scanner
   *  pipeline can route it as `contentBytes`. */
  readonly nodes: readonly unknown[];
  readonly connections: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  /** ISO-8601 — the adapter strips this from the canonical-bytes
   *  view before computing `sourceRevision` so a no-op edit (e.g.
   *  the operator opens + saves the workflow without changes)
   *  does not produce a new revision. */
  readonly updatedAt?: string;
}

export interface N8nListWorkflowsResult {
  readonly workflows: readonly N8nWorkflowSummary[];
}

export interface N8nListingApi {
  listWorkflows(args: N8nListWorkflowsArgs): Promise<N8nListWorkflowsResult>;
}
