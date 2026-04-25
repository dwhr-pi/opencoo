/**
 * n8n SourceAdapter (PR 26 / plan #122).
 *
 * Polling adapter that:
 *   1. Resolves the n8n REST API token from the
 *      CredentialStore on every scan (THREAT-MODEL §3.6
 *      invariant 11 — never from inline config, rotation pin).
 *   2. Calls n8n's listWorkflows REST endpoint with the
 *      binding's `tagFilter` and the persisted ISO since-cursor.
 *   3. Defense-in-depth post-filter on tag membership (the API
 *      may return a workflow whose tags were edited mid-scan to
 *      no longer match).
 *   4. Strips top-level `updatedAt` BEFORE serializing
 *      `contentBytes` (decision 3) — the body never carries
 *      `updatedAt`. `sourceRevision` is computed from a
 *      SEPARATE canonical byte stream (sorted keys, no
 *      whitespace) over the same updatedAt-stripped workflow,
 *      so revision stability is independent of pretty-print
 *      whitespace in `contentBytes`.
 *   5. Computes `sourceRevision` = sha256(canonical-bytes
 *      minus updatedAt).slice(0, 16) — stable across replay
 *      (decision: NOT updatedAt-derived).
 *   6. Enforces the 1 MiB ceiling per the SourceAdapter
 *      contract (assertion 7).
 *
 * The compiler-side dispatch lives in
 * `engine-ingestion/src/pipelines/compilation-worker.ts`: when
 * the binding's `contentKind` is `'n8n-workflow'`, the worker
 * routes to `compileCatalogWorkflow` (deterministic template,
 * no LLM). The adapter does NOT set `contentKind` on the
 * emitted document — the engine reads it from the binding row.
 */
import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import type {
  SourceAdapter,
  SourceChangedDocument,
  SourceScanArgs,
  SourceScanResult,
} from "@opencoo/shared/source-adapter";

import { n8nBindingConfigSchema } from "./binding-config.js";
import {
  stripUpdatedAt,
  computeWorkflowRevision,
} from "./canonical-bytes.js";
import type { N8nListingApi, N8nWorkflowSummary } from "./n8n-listing-api.js";

/** SourceAdapter contract assertion 7 — content ceiling. */
const ONE_MIB = 1024 * 1024;

/** Stable adapter slug — matches `sources_bindings.adapter_slug`. */
export const N8N_ADAPTER_SLUG = "n8n" as const;

export type MakeN8nListingApi = () => N8nListingApi;

export interface CreateN8nSourceAdapterArgs {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  readonly config: unknown;
  readonly makeApi: MakeN8nListingApi;
  readonly now?: () => Date;
}

export function createN8nSourceAdapter(
  args: CreateN8nSourceAdapterArgs,
): SourceAdapter {
  const config = n8nBindingConfigSchema.parse(args.config);
  const now = args.now ?? ((): Date => new Date());

  return {
    slug: N8N_ADAPTER_SLUG,
    async scan(scanArgs: SourceScanArgs): Promise<SourceScanResult> {
      // Resolve token at scan time — rotation pin.
      const credential = await args.credentialStore.read(args.credentialId);
      const bearerToken = credential.plaintext.toString("utf8");

      const api = args.makeApi();
      const listResult = await api.listWorkflows({
        bearerToken,
        baseUrl: config.baseUrl,
        tagFilter: config.tagFilter,
        ...(scanArgs.cursor !== null ? { since: scanArgs.cursor } : {}),
      });

      const fetchedAt = now();
      const documents: SourceChangedDocument[] = [];
      for (const wf of listResult.workflows) {
        // Defense-in-depth tag filter (decision 3). The API
        // already filters; we re-check in case the workflow's
        // tags were edited mid-scan.
        if (!hasTagIntersection(wf.tags, config.tagFilter)) continue;

        const bodyBytes = serialiseWorkflowBody(wf);
        // 1 MiB ceiling — emit nothing for oversize workflows.
        // The Scanner pipeline's payload would overflow anyway.
        if (bodyBytes.length > ONE_MIB) continue;

        const revision = computeWorkflowRevision(
          wf as unknown as Record<string, unknown>,
        );
        documents.push({
          sourceDocId: wf.id,
          sourceRevision: revision,
          sourceRef: `n8n:${wf.id}`,
          fetchedAt,
          contentBytes: bodyBytes,
        });
      }

      return {
        documents,
        // Cursor = ISO of this scan time. Next scan asks n8n
        // for workflows updated since this point.
        nextCursor: fetchedAt.toISOString(),
      };
    },
  };
}

function hasTagIntersection(
  workflowTags: readonly string[],
  filter: readonly string[],
): boolean {
  for (const t of workflowTags) {
    if (filter.includes(t)) return true;
  }
  return false;
}

/**
 * Serialise the workflow into the bytes that flow as
 * `contentBytes` to the engine. The bytes are pretty-printed
 * (2-space indent) JSON of the workflow MINUS top-level
 * `updatedAt`. The compiler embeds these bytes verbatim inside
 * the catalog page's fenced block.
 *
 * Pretty-printing makes the git diff of a catalog page readable
 * to humans; the canonical sort used for `sourceRevision`
 * happens separately in `computeWorkflowRevision`.
 */
function serialiseWorkflowBody(wf: N8nWorkflowSummary): Buffer {
  const stripped = stripUpdatedAt(wf as unknown as Record<string, unknown>);
  return Buffer.from(JSON.stringify(stripped, null, 2), "utf8");
}

// Re-export for callers that want to compute the revision
// directly (test fixtures, replay tooling).
export { canonicalBytes, computeWorkflowRevision } from "./canonical-bytes.js";
