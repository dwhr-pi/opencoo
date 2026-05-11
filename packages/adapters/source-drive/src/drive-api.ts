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

/**
 * Args for the per-folder `listFiles` call backing Drive's
 * `seed()` primitive (PR-Z2). One call returns one page of
 * direct children of `folderId`; the caller continues
 * paginating via `pageToken` and recurses into subfolder
 * entries it discovers. Drive's `q` parameter has no
 * "descendants of" operator, so the recursion is engine-side.
 */
export interface DriveListFilesArgs {
  /** Folder whose DIRECT children we want this page of. */
  readonly folderId: string;
  /** Optional pagination token from a previous response;
   *  omit / undefined on the first page. */
  readonly pageToken?: string;
}

/**
 * One entry returned by `listFiles`. The seed walker keys off
 * `mimeType === application/vnd.google-apps.folder` to recurse.
 */
export interface DriveFileEntry {
  readonly fileId: string;
  readonly mimeType: string;
  /** `modifiedTime` — used as `sourceRevision` so the same
   *  file landing through a subsequent change-feed scan with
   *  an unchanged `modifiedTime` is intake-dedupe no-op. */
  readonly modifiedTime: string;
}

export interface DriveListFilesResult {
  readonly files: readonly DriveFileEntry[];
  readonly nextPageToken: string | null;
}

export interface DriveLikeApi {
  /** First-scan bootstrap — returns the cursor token to use
   *  on the very first `listChanges` call. Also captured at
   *  seed-START to hand off to subsequent `scan()` calls. */
  getStartPageToken(): Promise<string>;
  listChanges(args: DriveListChangesArgs): Promise<DriveListChangesResult>;
  exportAsBytes(args: DriveExportArgs): Promise<Buffer>;
  /**
   * List direct children of `folderId` (PR-Z2). Drive's `q`
   * parameter has no "descendants of" operator — the seed
   * walker recurses into folder-typed entries itself. The
   * production client passes
   * `q: "'<folderId>' in parents and trashed=false"` +
   * `supportsAllDrives + includeItemsFromAllDrives + corpora`
   * for shared-drive parity with `listChanges`.
   *
   * Optional on the interface so existing test mocks (the
   * scan-focused `makeMockDrive`) don't need a body change to
   * compile. The Drive `seed()` implementation throws a clear
   * error if `listFiles` is absent on the injected client.
   */
  listFiles?(args: DriveListFilesArgs): Promise<DriveListFilesResult>;
}
