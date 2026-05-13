/**
 * `enumerateFailedJobsByBindingId` — PR-W2, phase-a appendix #14.
 *
 * Read-only enumerator over the `ingestion.scanner.classify` queue's
 * `failed` set. Used by the admin-API `POST /api/admin/source-bindings/:id/retry-failed`
 * route to find the failed jobs whose payload bindingId matches the
 * operator's target, so they can be re-enqueued without disturbing
 * the rest of the queue.
 *
 * Pin matrix:
 *   1. Returns only jobs whose `data.bindingId` matches the filter.
 *   2. Returns empty array when no failed jobs exist.
 *   3. Skips malformed payloads (missing data, missing bindingId,
 *      wrong type) without crashing.
 *   4. Captures `failedReason` from each job.
 *   5. Optional `intakeId` filter narrows further (single-job retry
 *      from the per-row Retry button).
 *   6. Preserves job id and full data payload for re-enqueue.
 */
import { describe, expect, it } from "vitest";

import {
  enumerateFailedJobsByBindingId,
  type FailedJobLike,
  type FailedJobsQueueLike,
} from "../src/enumerate-failed-jobs-by-binding-id.js";

function makeJob(args: {
  readonly id: string;
  readonly data: unknown;
  readonly failedReason?: string;
}): FailedJobLike {
  return {
    id: args.id,
    data: args.data,
    failedReason: args.failedReason ?? "BindingConfigError: stub",
  };
}

function makeQueue(jobs: readonly FailedJobLike[]): FailedJobsQueueLike {
  return {
    getFailed: async () => [...jobs],
  };
}

const BINDING_A = "11111111-1111-1111-1111-111111111111";
const BINDING_B = "22222222-2222-2222-2222-222222222222";

describe("enumerateFailedJobsByBindingId", () => {
  it("returns only jobs whose data.bindingId matches", async () => {
    const queue = makeQueue([
      makeJob({ id: "job-1", data: { bindingId: BINDING_A, intakeId: "i-1" } }),
      makeJob({ id: "job-2", data: { bindingId: BINDING_B, intakeId: "i-2" } }),
      makeJob({ id: "job-3", data: { bindingId: BINDING_A, intakeId: "i-3" } }),
    ]);

    const result = await enumerateFailedJobsByBindingId(queue, BINDING_A);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.jobId).sort()).toEqual(["job-1", "job-3"]);
    // Confirm BINDING_B job was excluded.
    expect(result.every((r) => r.data.bindingId === BINDING_A)).toBe(true);
  });

  it("returns empty array when there are no failed jobs", async () => {
    const queue = makeQueue([]);
    const result = await enumerateFailedJobsByBindingId(queue, BINDING_A);
    expect(result).toEqual([]);
  });

  it("returns empty array when no failed jobs match the binding", async () => {
    const queue = makeQueue([
      makeJob({ id: "job-1", data: { bindingId: BINDING_B, intakeId: "i-1" } }),
    ]);
    const result = await enumerateFailedJobsByBindingId(queue, BINDING_A);
    expect(result).toEqual([]);
  });

  it("skips malformed payloads without crashing", async () => {
    // Mix of well-formed, missing-data, non-object data, and missing-
    // bindingId. The helper must not throw — the BullMQ failed set
    // is read-only here and we cannot assume every historical payload
    // matches the current schema.
    const queue = makeQueue([
      makeJob({ id: "ok", data: { bindingId: BINDING_A, intakeId: "i-1" } }),
      makeJob({ id: "missing-data", data: undefined }),
      makeJob({ id: "null-data", data: null }),
      makeJob({ id: "string-data", data: "not an object" }),
      makeJob({ id: "missing-bindingId", data: { intakeId: "x" } }),
      makeJob({ id: "wrong-type", data: { bindingId: 42, intakeId: "x" } }),
    ]);

    const result = await enumerateFailedJobsByBindingId(queue, BINDING_A);
    expect(result).toHaveLength(1);
    expect(result[0]!.jobId).toBe("ok");
  });

  it("captures failedReason from each job", async () => {
    const queue = makeQueue([
      makeJob({
        id: "job-1",
        data: { bindingId: BINDING_A, intakeId: "i-1" },
        failedReason: "BindingConfigError: binding.allowed_paths is empty",
      }),
    ]);
    const result = await enumerateFailedJobsByBindingId(queue, BINDING_A);
    expect(result[0]!.failedReason).toBe(
      "BindingConfigError: binding.allowed_paths is empty",
    );
  });

  it("narrows further when intakeId filter is supplied", async () => {
    const queue = makeQueue([
      makeJob({ id: "job-1", data: { bindingId: BINDING_A, intakeId: "i-1" } }),
      makeJob({ id: "job-2", data: { bindingId: BINDING_A, intakeId: "i-2" } }),
      makeJob({ id: "job-3", data: { bindingId: BINDING_A, intakeId: "i-1" } }),
    ]);
    const result = await enumerateFailedJobsByBindingId(queue, BINDING_A, "i-1");
    expect(result.map((r) => r.jobId).sort()).toEqual(["job-1", "job-3"]);
  });

  it("preserves the full data payload for re-enqueue", async () => {
    // The retry route hands the full payload back to queue.add so the
    // re-enqueued job is byte-identical apart from the BullMQ-assigned
    // id. Pin that the helper does NOT mutate or strip the payload.
    const payload = {
      bindingId: BINDING_A,
      intakeId: "i-1",
      domainSlug: "wiki-test",
      sourceRef: "drive://abc",
      contentBase64: "Zm9v",
      fetchedAt: "2026-05-12T12:00:00.000Z",
    };
    const queue = makeQueue([makeJob({ id: "job-1", data: payload })]);
    const result = await enumerateFailedJobsByBindingId(queue, BINDING_A);
    expect(result[0]!.data).toEqual(payload);
  });

  it("skips jobs whose id is null (BullMQ may rarely return one)", async () => {
    // BullMQ types declare `id?: string`. Defensive: if a job ever
    // lands without an id we cannot re-enqueue it deterministically;
    // the safe choice is to drop it from the result and let the
    // operator open a follow-up if it ever happens.
    const queue = makeQueue([
      { id: undefined, data: { bindingId: BINDING_A, intakeId: "i-1" }, failedReason: "x" } as FailedJobLike,
      makeJob({ id: "job-2", data: { bindingId: BINDING_A, intakeId: "i-2" } }),
    ]);
    const result = await enumerateFailedJobsByBindingId(queue, BINDING_A);
    expect(result.map((r) => r.jobId)).toEqual(["job-2"]);
  });
});
