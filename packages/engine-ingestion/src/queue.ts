/**
 * BullMQ queue factory — one queue per pipeline at the convention
 * `ingestion.<slug>` (architecture.md §6.5 DLQ convention; the
 * companion DLQ for `ingestion.scanner` is `ingestion.scanner.dead`).
 *
 * v0.1 only owns queue construction; concrete pipelines (PRs 14-17)
 * own the worker layer, retry policy, and DLQ wiring.
 */
import { Queue, type ConnectionOptions, type QueueOptions } from "bullmq";

export const INGESTION_QUEUE_PREFIX = "ingestion";

export interface BuildIngestionQueueOptions {
  readonly connection: ConnectionOptions;
}

/**
 * Construct a BullMQ Queue named `ingestion.<slug>`. Validates the
 * slug at construction so a malformed input fails loud at boot
 * instead of producing a queue with a degenerate name.
 */
export function buildIngestionQueue(
  slug: string,
  options: BuildIngestionQueueOptions,
): Queue {
  if (slug.length === 0) {
    throw new Error("buildIngestionQueue: slug must be non-empty");
  }
  if (slug.includes(".")) {
    throw new Error(
      `buildIngestionQueue: slug must not contain '.', got ${JSON.stringify(slug)} (the dot is reserved as the prefix separator and would collide with DLQ naming)`,
    );
  }
  const name = `${INGESTION_QUEUE_PREFIX}.${slug}`;
  const queueOpts: QueueOptions = {
    connection: options.connection,
  };
  return new Queue(name, queueOpts);
}
