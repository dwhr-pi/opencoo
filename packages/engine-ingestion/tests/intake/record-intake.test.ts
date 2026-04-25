/**
 * recordIntake — INSERT-or-skip into ingestion_intake. Idempotent
 * per `(binding_id, source_doc_id, source_revision)` — duplicate
 * combinations return `{created:false}` without bumping any counter
 * (intake is the durable record of "this revision exists"; bumping
 * a counter on dup is the webhook_events case, NOT intake).
 *
 * Used by both Scanner (PR 15+) and the webhook receiver below.
 */
import { describe, it, expect } from "vitest";

import { recordIntake } from "../../src/intake/record-intake.js";
import { freshIntakeDb } from "./_pglite-fixture.js";

describe("recordIntake", () => {
  it("inserts a fresh row and returns {created:true, intakeId}", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const result = await recordIntake({
      db,
      bindingId,
      sourceDocId: "doc-1",
      sourceRevision: "rev-1",
      contentHash: "hash-abc",
    });
    expect(result.created).toBe(true);
    expect(result.intakeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns {created:false} on duplicate (binding, doc, revision)", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const first = await recordIntake({
      db,
      bindingId,
      sourceDocId: "doc-1",
      sourceRevision: "rev-1",
      contentHash: "hash-abc",
    });
    const second = await recordIntake({
      db,
      bindingId,
      sourceDocId: "doc-1",
      sourceRevision: "rev-1",
      contentHash: "hash-abc-different", // even with different hash, duplicate revision skips
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // Same intakeId returned for the dup so callers can chain.
    expect(second.intakeId).toBe(first.intakeId);
  });

  it("DOES create a new row when only sourceRevision differs (different revision = different intake)", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const first = await recordIntake({
      db,
      bindingId,
      sourceDocId: "doc-1",
      sourceRevision: "rev-1",
      contentHash: "hash-abc",
    });
    const second = await recordIntake({
      db,
      bindingId,
      sourceDocId: "doc-1",
      sourceRevision: "rev-2",
      contentHash: "hash-def",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.intakeId).not.toBe(first.intakeId);
  });

  it("DOES create a new row when bindingId differs", async () => {
    const { db, bindingId } = await freshIntakeDb();
    // Manually create a second binding via a raw query for symmetry.
    const result = await db.execute(
      `INSERT INTO sources_bindings (domain_id, adapter_slug)
       SELECT domain_id, 'asana' FROM sources_bindings WHERE id = '${bindingId}'
       RETURNING id`,
    );
    const otherBindingId = (result.rows[0] as { id: string }).id;

    const first = await recordIntake({
      db,
      bindingId,
      sourceDocId: "doc-1",
      sourceRevision: "rev-1",
      contentHash: "hash-abc",
    });
    const second = await recordIntake({
      db,
      bindingId: otherBindingId,
      sourceDocId: "doc-1",
      sourceRevision: "rev-1",
      contentHash: "hash-abc",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.intakeId).not.toBe(first.intakeId);
  });

  it("rejects empty sourceDocId / sourceRevision / contentHash with IntakeValidationError", async () => {
    const { db, bindingId } = await freshIntakeDb();
    const { IntakeValidationError } = await import(
      "../../src/intake/errors.js"
    );
    await expect(
      recordIntake({
        db,
        bindingId,
        sourceDocId: "",
        sourceRevision: "rev-1",
        contentHash: "hash-abc",
      }),
    ).rejects.toBeInstanceOf(IntakeValidationError);
    await expect(
      recordIntake({
        db,
        bindingId,
        sourceDocId: "doc-1",
        sourceRevision: "",
        contentHash: "hash-abc",
      }),
    ).rejects.toBeInstanceOf(IntakeValidationError);
    await expect(
      recordIntake({
        db,
        bindingId,
        sourceDocId: "doc-1",
        sourceRevision: "rev-1",
        contentHash: "",
      }),
    ).rejects.toBeInstanceOf(IntakeValidationError);
  });
});
