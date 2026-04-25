/**
 * Binding-config schema for the Google Drive SourceAdapter
 * (PR 23 / plan #111).
 *
 * This is the Zod schema for the JSON blob persisted in
 * `sources_bindings.config` for Drive bindings. The Management
 * UI (PR 29) renders a config form against this schema; the
 * adapter factory parses the persisted JSON through it.
 *
 * Per Q1 (orchestrator override): `content_kind` lives HERE in
 * the binding-config, NOT on the SourceAdapter port. The
 * compiler doesn't branch on it in v0.1 — that lands in
 * PR 26 (catalog-class compile path). For now the field is
 * declared so Drive bindings can carry it through as a
 * future-proofed signal.
 */
import { z } from "zod";

/**
 * Default mime-type whitelist for v0.1 — derived from the
 * design-partner PoC which currently handles google_doc + pdf
 * and explicitly skips docx + google_sheet (parsers not yet
 * built per the PoC). Operators extending the wiki to a
 * domain that needs other types add them to the binding's
 * `mimeTypes` array; once the converter for those types
 * lands (PR 26+), the engine accepts them automatically.
 */
export const DRIVE_DEFAULT_MIME_TYPES: readonly string[] = [
  "application/vnd.google-apps.document",
  "application/pdf",
] as const;

export const driveBindingConfigSchema = z
  .object({
    /** Drive folder id the adapter scans recursively. */
    folderId: z.string().min(1),
    /** Mime-type whitelist. Defaults to {google-doc, pdf} —
     *  matching the design-partner PoC's current scope. The
     *  operator can extend; the converter has to keep up. */
    mimeTypes: z
      .array(z.string().min(1))
      .min(1)
      .default([...DRIVE_DEFAULT_MIME_TYPES]),
    /**
     * Content kind for downstream routing (Q1 override).
     * `'document'` is the v0.1 default and the only branch
     * the v0.1 compiler implements. PR 26 adds the
     * `'n8n-workflow'` and `'skill-bundle'` paths.
     */
    contentKind: z
      .enum(["document", "n8n-workflow", "skill-bundle"])
      .default("document"),
    // Note: review_mode lives on the `sources_bindings.review_mode`
    // column (shared schema, `reviewMode` enum: auto | approve |
    // review) — NOT in this JSON config blob. The engine reads it
    // from the column; this binding-config schema deliberately
    // does not redeclare it to avoid a second source of truth.
  })
  .strict();

export type DriveBindingConfig = z.infer<typeof driveBindingConfigSchema>;
