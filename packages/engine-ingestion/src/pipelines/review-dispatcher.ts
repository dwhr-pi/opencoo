/**
 * Review Dispatcher pipeline (architecture §9 pipeline 4,
 * plan #77 Q4/Q5).
 *
 * Event-driven: consumes `ingestion.review.dispatch` jobs that
 * the Compiler emits POST-COMMIT when `domain.review_role` is
 * non-null (D4 — review_role lives on the domain, not the
 * binding). The handler logs the dispatch with the routing key
 * and the commit metadata so the Management UI's Review
 * Dashboard (PR 29+) can surface it.
 *
 * v0.1 deliberately writes NO row to a `review_requests` table
 * (Q4: that table doesn't exist yet — the dashboard reads
 * directly from the audit log + recent agent_runs). The role
 * string is opaque text; the handler does not dereference it
 * (Q5 + DECISIONS D4) — log, don't act on the value.
 *
 * The job retry policy is handled by the BullMQ wiring in
 * start.ts; the handler itself is idempotent (logging is a
 * pure side effect; the same job replayed twice is harmless).
 */

import type { Logger } from "@opencoo/shared/logger";

import { ValidationError } from "@opencoo/shared/errors";
import { z } from "zod";

/**
 * Canonical full queue name the dispatcher worker subscribes to.
 * Keep byte-for-byte consistent with the docstring, README, and
 * the Compiler-side dispatch hook — Compiler-emitted jobs sit
 * dead on the wrong queue if this drifts (copilot #19).
 *
 * Multi-dot prefix bypasses `buildIngestionQueue` (which rejects
 * dotted slugs) and is constructed directly via `new Queue(...)`
 * — same shape as `ingestion.dlq.intake` from PR 14.
 */
export const REVIEW_DISPATCH_QUEUE_SLUG =
  "ingestion.review.dispatch" as const;

/**
 * Job payload the Compiler emits. Includes the commit sha so the
 * Review Dashboard links straight to the diff, and the page
 * paths so it can label what the human is being asked to review.
 */
export const ReviewDispatchPayloadSchema = z
  .object({
    domainSlug: z.string().min(1),
    reviewRole: z.string().min(1),
    commitSha: z.string().min(1),
    pagePaths: z.array(z.string().min(1)).min(1),
    sourceRef: z.string().min(1),
  })
  .strict();

export type ReviewDispatchPayload = z.infer<typeof ReviewDispatchPayloadSchema>;

export interface RunReviewDispatcherArgs {
  readonly payload: unknown;
  readonly logger: Logger;
}

export interface ReviewDispatchResult {
  readonly dispatched: true;
  readonly reviewRole: string;
  readonly commitSha: string;
}

export async function runReviewDispatcher(
  args: RunReviewDispatcherArgs,
): Promise<ReviewDispatchResult> {
  const parsed = ReviewDispatchPayloadSchema.safeParse(args.payload);
  if (!parsed.success) {
    throw new ValidationError(
      `review-dispatcher: payload failed validation: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const { domainSlug, reviewRole, commitSha, pagePaths, sourceRef } =
    parsed.data;
  args.logger.info("review.dispatched", {
    domain_slug: domainSlug,
    review_role: reviewRole,
    commit_sha: commitSha,
    page_count: pagePaths.length,
    source_ref: sourceRef,
  });
  return { dispatched: true, reviewRole, commitSha };
}
