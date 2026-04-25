/**
 * recordIntake — INSERT-or-skip into ingestion_intake.
 *
 * Idempotent per `(binding_id, source_doc_id, source_revision)` —
 * a duplicate combination returns `{created:false, intakeId:<existing>}`
 * without bumping any counter. Intake is the durable record of
 * "this revision exists"; the bump-counter-on-dup pattern is the
 * webhook_events case (Q12), not intake.
 *
 * Used by both Scanner (PR 15+) when polling for changes AND by
 * the webhook receiver below when an inbound delivery names a new
 * (doc, revision) pair.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { ingestionIntake } from "@opencoo/shared/db/schema";

import { IntakeValidationError } from "./errors.js";

export interface RecordIntakeArgs {
  // Drizzle DB handle (pglite or pg). Generic over the schema so
  // both prod (real Postgres) and tests (pglite) satisfy.
  readonly db: PgDatabase<never, Record<string, never>, Record<string, never>>;
  readonly bindingId: string;
  readonly sourceDocId: string;
  readonly sourceRevision: string;
  readonly contentHash: string;
}

export interface RecordIntakeResult {
  readonly created: boolean;
  readonly intakeId: string;
}

export async function recordIntake(
  args: RecordIntakeArgs,
): Promise<RecordIntakeResult> {
  if (args.sourceDocId.length === 0) {
    throw new IntakeValidationError(
      "recordIntake: sourceDocId must be non-empty",
    );
  }
  if (args.sourceRevision.length === 0) {
    throw new IntakeValidationError(
      "recordIntake: sourceRevision must be non-empty",
    );
  }
  if (args.contentHash.length === 0) {
    throw new IntakeValidationError(
      "recordIntake: contentHash must be non-empty",
    );
  }

  // ON CONFLICT DO UPDATE with a no-op SET (set to existing column)
  // so RETURNING fires on both the insert AND the conflict path.
  // ON CONFLICT DO NOTHING would skip RETURNING for the dup, leaving
  // us to chase the existing id in a second query — slower and
  // racier under contention.
  const inserted = await args.db
    .insert(ingestionIntake)
    .values({
      bindingId: args.bindingId,
      sourceDocId: args.sourceDocId,
      sourceRevision: args.sourceRevision,
      contentHash: args.contentHash,
    })
    .onConflictDoUpdate({
      target: [
        ingestionIntake.bindingId,
        ingestionIntake.sourceDocId,
        ingestionIntake.sourceRevision,
      ],
      // True no-op: write the EXISTING source_doc_id back to itself.
      // We need a non-empty SET clause so RETURNING fires on the
      // conflict path (ON CONFLICT DO NOTHING would skip RETURNING,
      // forcing a second SELECT to find the existing id under
      // contention). Writing the table value (not `excluded`) makes
      // the no-op intent unambiguous — `excluded.source_doc_id` is
      // functionally identical here (the conflict target equals it
      // by definition) but reads as "rewrite from the new value",
      // which it isn't (copilot #16 Comment 6).
      set: { sourceDocId: ingestionIntake.sourceDocId },
    })
    .returning({
      id: ingestionIntake.id,
      // xmax=0 distinguishes a fresh INSERT from an UPDATE-on-conflict
      // path (Postgres' MVCC tag). xmax > 0 means the row already
      // existed and we just touched it — that's our `created:false`
      // signal.
      xmax: sql<string>`xmax`,
    });

  if (inserted.length === 0) {
    // Should not happen with ON CONFLICT DO UPDATE, but guard anyway.
    throw new Error("recordIntake: INSERT ... RETURNING produced no rows");
  }
  const row = inserted[0]!;
  // xmax === '0' means a brand-new row; anything else means we hit
  // the conflict path.
  const created = String(row.xmax) === "0";
  return { created, intakeId: row.id };
}
