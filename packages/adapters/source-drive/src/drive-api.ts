/**
 * Minimal Drive-like API surface (PR 23 / plan #111).
 *
 * The SourceAdapter consumes ONLY these methods from a Drive
 * client. The use-case-tier tests inject a `MockDrive` that
 * fulfills this shape. Production wiring (deferred to PR 30
 * composition root) hands a wrapper around `googleapis@>=144`
 * that maps these methods to the real Drive REST API:
 *
 *   - `listChanges({ pageToken, includeRemoved })` →
 *     `drive.changes.list`
 *   - `getStartPageToken()` → `drive.changes.getStartPageToken`
 *   - `exportAsBytes({ fileId, mimeType })` →
 *     `drive.files.export` (for google-doc → text/markdown) OR
 *     `drive.files.get` (for pdf binary download)
 *
 * Keeping the surface narrow + adapter-internal lets us defer
 * the `googleapis` dep entirely from this PR — the use-case
 * tier injects a mock and the production wiring binds at the
 * composition root. Per the brief: "Use-case tier only: Drive
 * API fully mocked via fixture-injected `makeMockDrive()`".
 */
export interface DriveListChangesArgs {
  /** Page token from `getStartPageToken` on first call, or
   *  the `nextPageToken` from a previous `listChanges`. */
  readonly pageToken: string;
  /** Drive accepts a folder filter via the API's q parameter;
   *  in v0.1 we filter post-fetch in the adapter (the PoC
   *  does the same). The mock honors the folder via its own
   *  fixture state. */
  readonly folderId: string;
  /** Whitelist of mime types the adapter wants. The mock
   *  filters before returning. Production wiring uses Drive's
   *  q parameter. */
  readonly mimeTypes: readonly string[];
}

export interface DriveChangeEntry {
  readonly fileId: string;
  /** A monotonically-increasing per-file revision the adapter
   *  uses as `sourceRevision`. Drive's REST API exposes this
   *  via `file.modifiedTime` (we use ISO strings here). */
  readonly revision: string;
  readonly mimeType: string;
  /** True when the change is a file-removed event. The adapter
   *  filters these out (no tombstone in v0.1; assertion 6 of
   *  the contract suite). */
  readonly removed: boolean;
}

export interface DriveListChangesResult {
  readonly changes: readonly DriveChangeEntry[];
  /** Token for the NEXT call. Production: Drive returns this
   *  on every page; the adapter persists it as the cursor. */
  readonly nextPageToken: string;
}

export interface DriveExportArgs {
  readonly fileId: string;
  readonly mimeType: string;
}

export interface DriveLikeApi {
  /** First-scan bootstrap — returns the cursor token to use
   *  on the very first `listChanges` call. */
  getStartPageToken(): Promise<string>;
  listChanges(args: DriveListChangesArgs): Promise<DriveListChangesResult>;
  exportAsBytes(args: DriveExportArgs): Promise<Buffer>;
}
