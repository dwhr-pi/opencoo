/**
 * In-memory mock of the minimal Drive-like API surface
 * (PR 23 / plan #111). Use-case-tier tests inject this via
 * `createGoogleDriveAdapter({ makeDrive: makeMockDrive(...) })`.
 *
 * Mechanics:
 *   - `seedFile(file)` adds a file with `revision`, `mimeType`,
 *     `bytes` and a folderId (default: matches binding).
 *   - `bumpRevision(fileId, newRevision, newBytes)` simulates a
 *     source-side mutation between scans.
 *   - `removeFile(fileId)` simulates Drive's `change.removed=true`.
 *
 * Cursor semantics: the mock keeps an internal monotonic
 * counter; `getStartPageToken` returns "0" and each
 * `listChanges` returns "<n+1>" with all changes that have
 * happened since `pageToken`. The adapter persists this token
 * as the SourceScanResult.nextCursor.
 */
import type {
  DriveChangeEntry,
  DriveExportArgs,
  DriveLikeApi,
  DriveListChangesArgs,
  DriveListChangesResult,
} from "../drive-api.js";

export interface MockFile {
  readonly fileId: string;
  readonly mimeType: string;
  /** Folder the file lives under. The mock filters against the
   *  binding's `folderId` so a test can verify the adapter's
   *  per-binding scope. */
  readonly folderId: string;
  /** Mutable revision tag — bumpRevision() rewrites this. */
  revision: string;
  /** Mutable content bytes — bumpRevision() rewrites these. */
  bytes: Buffer;
  /** Whether the file was removed-at-source. */
  removed: boolean;
  /** Monotonic counter the mock uses to filter "since
   *  pageToken" — incremented on every mutation. */
  changeIndex: number;
}

export interface MockDriveState {
  readonly files: Map<string, MockFile>;
  changeCounter: number;
}

export interface MakeMockDriveOptions {
  readonly state: MockDriveState;
}

/**
 * Build a mock DriveLikeApi backed by the supplied state. The
 * factory takes the (refreshToken: Buffer) so it satisfies the
 * `MakeDrive` shape the adapter expects. The mock ignores the
 * token by design — the use-case tests don't exercise the
 * OAuth path; that's the production wiring's concern.
 */
export function makeMockDrive(
  options: MakeMockDriveOptions,
): (refreshToken: Buffer) => DriveLikeApi {
  return (_refreshToken: Buffer): DriveLikeApi => {
    void _refreshToken;
    return {
      async getStartPageToken(): Promise<string> {
        return "0";
      },
      async listChanges(
        args: DriveListChangesArgs,
      ): Promise<DriveListChangesResult> {
        const sincePos = Number.parseInt(args.pageToken, 10);
        const since = Number.isFinite(sincePos) ? sincePos : 0;
        const changes: DriveChangeEntry[] = [];
        for (const file of options.state.files.values()) {
          if (file.changeIndex <= since) continue;
          if (file.folderId !== args.folderId) continue;
          if (
            !file.removed &&
            !args.mimeTypes.includes(file.mimeType)
          ) {
            continue;
          }
          changes.push({
            fileId: file.fileId,
            revision: file.revision,
            mimeType: file.mimeType,
            removed: file.removed,
          });
        }
        return {
          changes,
          nextPageToken: String(options.state.changeCounter),
        };
      },
      async exportAsBytes(args: DriveExportArgs): Promise<Buffer> {
        const file = options.state.files.get(args.fileId);
        if (file === undefined) {
          throw new Error(`mock-drive: unknown fileId ${args.fileId}`);
        }
        return file.bytes;
      },
    };
  };
}

/**
 * Helper API the contract-suite fixture uses to seed +
 * mutate the state between scans.
 */
export interface MockDriveSimulator {
  readonly state: MockDriveState;
  seedFile(file: {
    readonly fileId: string;
    readonly mimeType?: string;
    readonly folderId: string;
    readonly revision: string;
    readonly bytes: Buffer;
  }): void;
  bumpRevision(
    fileId: string,
    newRevision: string,
    newBytes: Buffer,
  ): void;
  removeFile(fileId: string): void;
}

export function createMockDriveSimulator(): MockDriveSimulator {
  const state: MockDriveState = {
    files: new Map(),
    changeCounter: 0,
  };
  return {
    state,
    seedFile(file): void {
      state.changeCounter += 1;
      state.files.set(file.fileId, {
        fileId: file.fileId,
        mimeType:
          file.mimeType ?? "application/vnd.google-apps.document",
        folderId: file.folderId,
        revision: file.revision,
        bytes: file.bytes,
        removed: false,
        changeIndex: state.changeCounter,
      });
    },
    bumpRevision(fileId, newRevision, newBytes): void {
      const file = state.files.get(fileId);
      if (file === undefined) {
        throw new Error(`mock-drive simulator: ${fileId} not seeded`);
      }
      state.changeCounter += 1;
      file.revision = newRevision;
      file.bytes = newBytes;
      file.removed = false;
      file.changeIndex = state.changeCounter;
    },
    removeFile(fileId): void {
      const file = state.files.get(fileId);
      if (file === undefined) return;
      state.changeCounter += 1;
      file.removed = true;
      file.changeIndex = state.changeCounter;
    },
  };
}
