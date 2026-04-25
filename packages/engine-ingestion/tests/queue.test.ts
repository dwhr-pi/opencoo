/**
 * BullMQ queue factory — builds one Queue per pipeline at the
 * naming convention `ingestion.<slug>` (architecture.md §6.5 DLQ
 * convention; the DLQ for `ingestion.scanner` is
 * `ingestion.scanner.dead`).
 *
 * The factory is a thin wrapper: it takes a Redis connection and
 * a slug, returns the underlying BullMQ Queue. We do not own the
 * worker layer here — that lands with concrete pipelines in PRs
 * 14-17. v0.1 just needs the queue object so a smoke harness can
 * enqueue + observe.
 */
import { describe, it, expect, afterEach } from "vitest";
import IORedisMock from "ioredis-mock";

import { buildIngestionQueue, INGESTION_QUEUE_PREFIX } from "../src/queue.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe("buildIngestionQueue", () => {
  it("names queues `ingestion.<slug>` with the architecture-§6.5 prefix", () => {
    const redis = new IORedisMock();
    const q = buildIngestionQueue("scanner", { connection: redis as unknown as Parameters<typeof buildIngestionQueue>[1]["connection"] });
    cleanup.push(async () => {
      await q.close();
      redis.disconnect();
    });
    expect(q.name).toBe("ingestion.scanner");
    expect(INGESTION_QUEUE_PREFIX).toBe("ingestion");
  });

  it("rejects empty slug at construction (no silent unnamed queue)", () => {
    const redis = new IORedisMock();
    expect(() =>
      buildIngestionQueue("", {
        connection: redis as unknown as Parameters<typeof buildIngestionQueue>[1]["connection"],
      }),
    ).toThrow(/slug/i);
    redis.disconnect();
  });

  it("rejects slug with a `.` character (collides with the prefix separator)", () => {
    const redis = new IORedisMock();
    expect(() =>
      buildIngestionQueue("scanner.dead", {
        connection: redis as unknown as Parameters<typeof buildIngestionQueue>[1]["connection"],
      }),
    ).toThrow(/slug/i);
    redis.disconnect();
  });

  it("queues with different slugs do not collide", () => {
    const redis = new IORedisMock();
    const a = buildIngestionQueue("scanner", { connection: redis as unknown as Parameters<typeof buildIngestionQueue>[1]["connection"] });
    const b = buildIngestionQueue("compiler", { connection: redis as unknown as Parameters<typeof buildIngestionQueue>[1]["connection"] });
    cleanup.push(async () => {
      await a.close();
      await b.close();
      redis.disconnect();
    });
    expect(a.name).toBe("ingestion.scanner");
    expect(b.name).toBe("ingestion.compiler");
  });
});
