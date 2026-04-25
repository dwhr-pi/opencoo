/**
 * Mock n8n listing API for use-case tests (PR 26 / plan #122).
 *
 * Backed by a programmable state object: callers seed
 * `state.workflows` and the mock returns a filtered + cursor-
 * scoped view. Captures every call's `tagFilter` + `since` so
 * the contract assertions can verify the adapter's pass-through
 * behavior.
 */
import type {
  N8nListWorkflowsArgs,
  N8nListWorkflowsResult,
  N8nListingApi,
  N8nWorkflowSummary,
} from "../n8n-listing-api.js";

export interface CapturedN8nListingCall {
  readonly bearerToken: string;
  readonly baseUrl: string;
  readonly tagFilter: readonly string[];
  readonly since: string | undefined;
}

export interface MockN8nListingState {
  /** Workflow inventory the test mutates before / between scans. */
  workflows: N8nWorkflowSummary[];
  /** Captured calls for assertion (tagFilter pass-through, etc.). */
  readonly calls: CapturedN8nListingCall[];
}

export function createMockN8nListingState(): MockN8nListingState {
  return { workflows: [], calls: [] };
}

export function makeMockN8nListing(args: {
  state: MockN8nListingState;
}): () => N8nListingApi {
  return () => ({
    async listWorkflows(
      callArgs: N8nListWorkflowsArgs,
    ): Promise<N8nListWorkflowsResult> {
      args.state.calls.push({
        bearerToken: callArgs.bearerToken,
        baseUrl: callArgs.baseUrl,
        tagFilter: callArgs.tagFilter,
        since: callArgs.since,
      });
      // Filter on tag intersection — the real n8n REST returns
      // all matches; we mirror the API and let the adapter's
      // post-filter handle the defense-in-depth case.
      // Also filter by `since` — mirrors n8n's
      // `?lastUpdatedAt>since` query so the dedup-on-no-change
      // contract assertion (#3) passes when the cursor flows
      // through unchanged.
      const sinceMs =
        callArgs.since !== undefined ? Date.parse(callArgs.since) : null;
      const filtered = args.state.workflows.filter((wf) => {
        if (!wf.tags.some((t) => callArgs.tagFilter.includes(t))) return false;
        if (sinceMs !== null && wf.updatedAt !== undefined) {
          const wfMs = Date.parse(wf.updatedAt);
          if (Number.isFinite(wfMs) && wfMs <= sinceMs) return false;
        }
        return true;
      });
      return { workflows: filtered };
    },
  });
}
