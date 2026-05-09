/**
 * `createForgetJobEnqueuer` contract tests (PR-W1, phase-a appendix
 * #11).
 *
 * Pins the (queue-name, job-name, payload) shape the admin-API
 * forget route hands the composition-supplied enqueuer:
 *   - One `recompile_page` job per `pagesRecompiled[]` entry on the
 *     `wiki.recompile` queue.
 *   - One `delete_page` job per `pagesDeleted[]` entry on the
 *     `wiki.delete` queue.
 *   - Payload format: `{ bindingId, domainSlug, pagePath,
 *     callerUsername }` — `pagePath` is the planner-emitted
 *     `${domainSlug}/${pagePath}` with the `${domainSlug}/` prefix
 *     stripped (so the worker payload matches the per-domain
 *     WikiAdapter's path expectations).
 *
 * Failure modes pinned:
 *   - First queue `add` rejection bubbles out (route → 500
 *     `enqueue_failed`).
 *   - Sequential add ordering surfaces the failing path in the
 *     rejection (route can correlate to its audit row).
 */
import { describe, expect, it, vi } from "vitest";

import {
  createForgetJobEnqueuer,
  WIKI_DELETE_JOB_NAME,
  WIKI_RECOMPILE_JOB_NAME,
  type ForgetJobEnqueueArgs,
  type ForgetJobQueue,
} from "../src/forget/enqueue.js";

function spyQueue(): ForgetJobQueue & {
  readonly add: ReturnType<typeof vi.fn>;
} {
  return {
    add: vi.fn(async () => undefined),
  };
}

function planFixture(): ForgetJobEnqueueArgs {
  return {
    bindingId: "11111111-1111-1111-1111-111111111111",
    domainSlug: "wiki-forget",
    pagesRecompiled: ["wiki-forget/index.md", "wiki-forget/team-c.md"],
    pagesDeleted: ["wiki-forget/team-a.md", "wiki-forget/team-b.md"],
    callerUsername: "alice",
  };
}

describe("createForgetJobEnqueuer", () => {
  it("enqueues one recompile_page job per pagesRecompiled entry", async () => {
    const recompileQueue = spyQueue();
    const deleteQueue = spyQueue();
    const enqueuer = createForgetJobEnqueuer({ recompileQueue, deleteQueue });

    await enqueuer(planFixture());

    expect(recompileQueue.add).toHaveBeenCalledTimes(2);
    expect(recompileQueue.add).toHaveBeenNthCalledWith(
      1,
      WIKI_RECOMPILE_JOB_NAME,
      {
        bindingId: "11111111-1111-1111-1111-111111111111",
        domainSlug: "wiki-forget",
        pagePath: "index.md",
        callerUsername: "alice",
      },
    );
    expect(recompileQueue.add).toHaveBeenNthCalledWith(
      2,
      WIKI_RECOMPILE_JOB_NAME,
      {
        bindingId: "11111111-1111-1111-1111-111111111111",
        domainSlug: "wiki-forget",
        pagePath: "team-c.md",
        callerUsername: "alice",
      },
    );
  });

  it("enqueues one delete_page job per pagesDeleted entry", async () => {
    const recompileQueue = spyQueue();
    const deleteQueue = spyQueue();
    const enqueuer = createForgetJobEnqueuer({ recompileQueue, deleteQueue });

    await enqueuer(planFixture());

    expect(deleteQueue.add).toHaveBeenCalledTimes(2);
    expect(deleteQueue.add).toHaveBeenNthCalledWith(1, WIKI_DELETE_JOB_NAME, {
      bindingId: "11111111-1111-1111-1111-111111111111",
      domainSlug: "wiki-forget",
      pagePath: "team-a.md",
      callerUsername: "alice",
    });
    expect(deleteQueue.add).toHaveBeenNthCalledWith(2, WIKI_DELETE_JOB_NAME, {
      bindingId: "11111111-1111-1111-1111-111111111111",
      domainSlug: "wiki-forget",
      pagePath: "team-b.md",
      callerUsername: "alice",
    });
  });

  it("empty plan → no queue adds", async () => {
    const recompileQueue = spyQueue();
    const deleteQueue = spyQueue();
    const enqueuer = createForgetJobEnqueuer({ recompileQueue, deleteQueue });

    await enqueuer({
      bindingId: "11111111-1111-1111-1111-111111111111",
      domainSlug: "wiki-forget",
      pagesRecompiled: [],
      pagesDeleted: [],
      callerUsername: "alice",
    });

    expect(recompileQueue.add).not.toHaveBeenCalled();
    expect(deleteQueue.add).not.toHaveBeenCalled();
  });

  it("path without domain prefix is forwarded verbatim (defensive)", async () => {
    // Defensive: the planner always emits `${domainSlug}/${pagePath}`
    // (planner.ts:62/136). If a future planner regression skipped the
    // prefix, the helper should NOT silently drop or rewrite — it
    // should forward so the worker can surface the mismatch.
    const recompileQueue = spyQueue();
    const deleteQueue = spyQueue();
    const enqueuer = createForgetJobEnqueuer({ recompileQueue, deleteQueue });

    await enqueuer({
      bindingId: "11111111-1111-1111-1111-111111111111",
      domainSlug: "wiki-forget",
      pagesRecompiled: ["unprefixed.md"],
      pagesDeleted: [],
      callerUsername: "alice",
    });

    expect(recompileQueue.add).toHaveBeenCalledWith(
      WIKI_RECOMPILE_JOB_NAME,
      expect.objectContaining({ pagePath: "unprefixed.md" }),
    );
  });

  it("first add rejection bubbles out (route surfaces 500)", async () => {
    const failure = new Error("redis connection refused");
    const recompileQueue: ForgetJobQueue = {
      add: vi.fn(async () => {
        throw failure;
      }),
    };
    const deleteQueue = spyQueue();
    const enqueuer = createForgetJobEnqueuer({ recompileQueue, deleteQueue });

    await expect(enqueuer(planFixture())).rejects.toBe(failure);
    // Sequential add: a failure on the recompile queue must NOT
    // proceed to the delete queue. The route's audit row was already
    // written so an idempotent retry replays cleanly.
    expect(deleteQueue.add).not.toHaveBeenCalled();
  });
});
