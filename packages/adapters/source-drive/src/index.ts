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
  type DriveLikeApi,
  type DriveListChangesArgs,
  type DriveListChangesResult,
} from "./drive-api.js";

export {
  DRIVE_ADAPTER_SLUG,
  createGoogleDriveAdapter,
  type CreateDriveAdapterArgs,
  type MakeDrive,
} from "./adapter.js";
