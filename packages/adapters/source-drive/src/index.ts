/**
 * Public surface for `@opencoo/source-drive` (PR 23 / plan #111).
 * The reference SourceAdapter implementation for Google Drive.
 *
 * Production wiring (PR 30 composition root) calls
 * `createGoogleDriveAdapter` with a `makeDrive` that wraps
 * `googleapis@>=144`. Tests wire `makeMockDrive` from the
 * `./testing` subpath.
 */
export {
  DRIVE_DEFAULT_MIME_TYPES,
  driveBindingConfigSchema,
  type DriveBindingConfig,
} from "./binding-config.js";

export {
  type DriveChangeEntry,
  type DriveExportArgs,
  type DriveFileEntry,
  type DriveLikeApi,
  type DriveListChangesArgs,
  type DriveListChangesResult,
  type DriveListFilesArgs,
  type DriveListFilesResult,
} from "./drive-api.js";

/**
 * `seed()` primitive helpers (PR-Z2). The adapter wires
 * `runDriveSeed` into the returned `SourceAdapter.seed`
 * automatically; this export lets the engine-ingestion
 * scanner-seed integration test exercise the walker in
 * isolation.
 */
export {
  partitionSeedListing,
  runDriveSeed,
  type RunDriveSeedArgs,
} from "./seed.js";

export {
  DRIVE_ADAPTER_SLUG,
  createGoogleDriveAdapter,
  type CreateDriveAdapterArgs,
  type MakeDrive,
} from "./adapter.js";

/**
 * Real `googleapis@^144` Drive client (PR-Z1, phase-a appendix #12).
 * Exposed from the package root so the production composition
 * root can construct `MakeDrive` without a deep subpath import.
 */
export {
  createGoogleDriveApi,
  parseServiceAccountJson,
  type ServiceAccountKey,
} from "./google-drive-api.js";
