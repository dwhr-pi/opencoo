/**
 * Review Dispatcher pipeline (PR 17 / plan #77).
 *
 * Validates the payload via Zod-strict, logs the dispatch with
 * the routing key + commit metadata, returns a typed result.
 * Treats reviewRole as opaque text (D4) — log, don't dereference.
 */
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { ValidationError } from "@opencoo/shared/errors";

import {
  REVIEW_DISPATCH_QUEUE_SLUG,
  runReviewDispatcher,
} from "../../src/pipelines/review-dispatcher.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const VALID_PAYLOAD = {
  domainSlug: "test-domain",
  reviewRole: "executive-team",
  commitSha: "0123456789abcdef",
  pagePaths: ["strategy/q3.md"],
  sourceRef: "drive:doc-1",
};

describe("REVIEW_DISPATCH_QUEUE_SLUG — canonical queue name (copilot #19)", () => {
  it("matches the 'ingestion.review.dispatch' name the docstring + README + Compiler hook all reference", () => {
    // The composition root (PR 30) wires the dispatcher worker to
    // the queue named by this constant. If the constant drifts
    // from the canonical name, jobs the Compiler emits sit dead
    // because the worker is listening on the wrong queue.
    expect(REVIEW_DISPATCH_QUEUE_SLUG).toBe("ingestion.review.dispatch");
  });
});

describe("runReviewDispatcher — happy path", () => {
  it("returns dispatched:true with the routing role + commit sha", async () => {
    const result = await runReviewDispatcher({
      payload: VALID_PAYLOAD,
      logger: silentLogger(),
    });
    expect(result.dispatched).toBe(true);
    expect(result.reviewRole).toBe("executive-team");
    expect(result.commitSha).toBe("0123456789abcdef");
  });

  it("logs review.dispatched with the payload metadata", async () => {
    const writes: string[] = [];
    const logger = new ConsoleLogger({
      stream: {
        write: (chunk: string): boolean => {
          writes.push(chunk);
          return true;
        },
      },
    });
    await runReviewDispatcher({ payload: VALID_PAYLOAD, logger });
    const joined = writes.join("");
    expect(joined).toContain("review.dispatched");
    expect(joined).toContain("executive-team");
    expect(joined).toContain("test-domain");
  });
});

describe("runReviewDispatcher — payload validation", () => {
  it("throws ValidationError on missing reviewRole", async () => {
    await expect(
      runReviewDispatcher({
        payload: { ...VALID_PAYLOAD, reviewRole: undefined },
        logger: silentLogger(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError on empty pagePaths", async () => {
    await expect(
      runReviewDispatcher({
        payload: { ...VALID_PAYLOAD, pagePaths: [] },
        logger: silentLogger(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError on extra Zod-strict field", async () => {
    await expect(
      runReviewDispatcher({
        payload: { ...VALID_PAYLOAD, execute_arbitrary_code: "rm -rf /" },
        logger: silentLogger(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("treats reviewRole as opaque text (does not dereference)", async () => {
    // The dispatcher is told reviewRole='nonexistent-role'. It
    // logs + returns; it does NOT try to look the role up
    // anywhere. The test asserts no exception and the role flows
    // through unchanged.
    const result = await runReviewDispatcher({
      payload: { ...VALID_PAYLOAD, reviewRole: "nonexistent-role-12345" },
      logger: silentLogger(),
    });
    expect(result.reviewRole).toBe("nonexistent-role-12345");
  });
});

void vi;
