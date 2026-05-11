/**
 * Drive `seed()` primitive (PR-Z2, phase-a appendix #12 G2).
 *
 * Why this file exists. The `SourceAdapter` port at
 * `@opencoo/shared/source-adapter` only exposes `scan()`
 * (cursor-keyed change-feed polling) + optional webhook
 * helpers. A brand-new binding has no cursor, so the first
 * `scan()` bootstraps with `getStartPageToken()` and from that
 * point forward only sees CHANGES — files in the bound folder
 * that existed BEFORE the binding was created are invisible.
 *
 * The seed primitive fixes that gap: on binding-create (Z3
 * triggers it) the Scanner calls `adapter.seed(...)` instead
 * of `adapter.scan(...)`, the adapter walks the bound folder
 * top-down (Drive's `q` operator has no "descendants of"
 * operator, so recursion is engine-side), emits one
 * `SourceChangedDocument` per matching file, and hands a
 * page-token-snapshot back as the cursor so the next
 * `scan()` resumes from "now" (= seed-START) and doesn't
 * re-deliver the seeded files as "changes".
 *
 * Cursor handoff ordering matters. We capture
 * `getStartPageToken()` BEFORE the walk starts. If we
 * captured it after, any file that landed in the bound
 * folder DURING the seed walk could be returned twice — once
 * by the walk, then again by the first `scan()` reading the
 * change feed since seed-END. The intake-dedupe UNIQUE
 * (binding_id, source_doc_id, source_revision) would catch
 * the dup AS LONG AS the revision hadn't bumped, but a
 * file-mutation-mid-seed would slip through. Capturing the
 * token first means the first `scan()` resumes from a
 * conservative position — at worst it emits a change for a
 * file we already seeded, and the intake-dedupe absorbs it
 * cleanly (UNIQUE doesn't care if the row already exists at
 * the same revision).
 *
 * Filtering. The same `filterChangesByFolderId` pin from C1
 * applies in spirit here — the seed walker only crosses
 * folder boundaries it explicitly recurses INTO (no
 * cross-pollution via `parents: []` edge cases), and the
 * per-file mime-type whitelist is applied at emit-time. We
 * extract a sibling `filterFilesByMimeType` helper that
 * mirrors the C1 predicate shape so the test pin stays
 * contained.
 *
 * Pagination + recursion. Each call to `listFiles` returns one
 * page of direct children. The walker queues up child folders
 * and walks them BFS-style; pagination tokens are consumed in
 * an inner loop before advancing to the next folder. There is
 * no rate-limit throttling in v0.1 — partners with 100k-task
 * projects would push us to add cadence control as a v0.2
 * UI surface (see the wave-12 "Out of scope" list).
 */
import type {
  SourceChangedDocument,
  SourceSeedArgs,
  SourceSeedResult,
} from "@opencoo/shared/source-adapter";

import type { DriveFileEntry, DriveLikeApi } from "./drive-api.js";

/** Drive folder mime type — the recursion key. */
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Per-adapter content size ceiling, mirroring the scan path. */
const ONE_MIB = 1024 * 1024;

/**
 * Pure filter: drop folders + files whose mime type isn't in
 * the binding's whitelist. Extracted as a sibling to
 * `filterChangesByFolderId` (C1) so the seed's filter logic
 * lives in unit-testable code rather than inside the SDK-
 * coupled walker closure.
 *
 * Semantics:
 *   - Folder-mime entries pass through unchanged (the walker
 *     uses them as recursion targets, not as emit candidates).
 *   - Empty / missing fileId → skip (defensive).
 *   - Mime-type whitelist applied against the file's
 *     `mimeType`; non-folder, non-whitelisted entries skip.
 */
export function partitionSeedListing(
  entries: readonly DriveFileEntry[],
  mimeTypes: readonly string[],
): { readonly subFolders: readonly DriveFileEntry[]; readonly files: readonly DriveFileEntry[] } {
  const subFolders: DriveFileEntry[] = [];
  const files: DriveFileEntry[] = [];
  for (const entry of entries) {
    if (typeof entry.fileId !== "string" || entry.fileId.length === 0) continue;
    if (entry.mimeType === FOLDER_MIME) {
      subFolders.push(entry);
      continue;
    }
    if (!mimeTypes.includes(entry.mimeType)) continue;
    files.push(entry);
  }
  return { subFolders, files };
}

export interface RunDriveSeedArgs {
  readonly seedArgs: SourceSeedArgs;
  readonly drive: DriveLikeApi;
  readonly folderId: string;
  readonly mimeTypes: readonly string[];
  readonly now: () => Date;
}

/**
 * Implementation of the Drive `seed()` primitive. Kept as a
 * sibling export so the adapter factory wires it without
 * duplicating logic, and so the unit tests can call it
 * directly with a mocked `DriveLikeApi`.
 */
export async function runDriveSeed(
  args: RunDriveSeedArgs,
): Promise<SourceSeedResult> {
  if (args.drive.listFiles === undefined) {
    throw new Error(
      "drive: seed() requires a DriveLikeApi with listFiles(); the injected client did not implement it",
    );
  }
  const listFiles = args.drive.listFiles.bind(args.drive);

  // Capture the seed-boundary page token FIRST so the first
  // subsequent scan() resumes from "now" — files modified
  // mid-seed flow back through the change feed and intake-
  // dedupe handles any overlap with what the walker already
  // emitted.
  const cursor = await args.drive.getStartPageToken();

  const documents: SourceChangedDocument[] = [];
  // BFS over folder ids. Seeded with the bound folder; popped
  // entries are walked + their direct subfolders are queued.
  const folderQueue: string[] = [args.folderId];
  // Defense against the (impossible-in-Drive but cheap-to-
  // pin) case of a folder cycle: a folder we've already
  // visited never gets re-queued, no matter how many parents
  // point at it. Limit cap is also a soft fence against
  // pathological partner data — 5k folders covers everything
  // a sane operator would bind in v0.1.
  const visited = new Set<string>();
  const MAX_FOLDERS = 5000;

  while (folderQueue.length > 0) {
    const currentFolder = folderQueue.shift()!;
    if (visited.has(currentFolder)) continue;
    if (visited.size >= MAX_FOLDERS) {
      throw new Error(
        `drive: seed() exceeded ${MAX_FOLDERS}-folder cap walking from ${args.folderId} — partner content may need bounded scope`,
      );
    }
    visited.add(currentFolder);

    let pageToken: string | undefined;
    do {
      // exactOptionalPropertyTypes — omit `pageToken` on the
      // first page rather than passing `undefined`.
      const listing = await listFiles(
        pageToken !== undefined
          ? { folderId: currentFolder, pageToken }
          : { folderId: currentFolder },
      );
      const { subFolders, files } = partitionSeedListing(
        listing.files,
        args.mimeTypes,
      );
      for (const sub of subFolders) {
        if (!visited.has(sub.fileId)) folderQueue.push(sub.fileId);
      }
      for (const file of files) {
        const bytes = await args.drive.exportAsBytes({
          fileId: file.fileId,
          mimeType: file.mimeType,
        });
        // 1 MiB ceiling — same as scan(). Oversize files
        // would overflow the BullMQ payload anyway and the
        // Compilation Worker rejects on SpotlightOverflowError.
        if (bytes.length > ONE_MIB) continue;
        documents.push({
          sourceDocId: file.fileId,
          sourceRevision: file.modifiedTime,
          sourceRef: `drive:${file.fileId}`,
          fetchedAt: args.now(),
          contentBytes: bytes,
        });
      }
      pageToken = listing.nextPageToken ?? undefined;
    } while (pageToken !== undefined);
  }

  return { documents, cursor };
}
