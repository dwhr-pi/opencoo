/**
 * Drive `seed()` primitive tests (PR-Z2, phase-a appendix #12 G2).
 *
 * Coverage:
 *   1. Happy path — recursive folder walk emits one
 *      `SourceChangedDocument` per file across the tree,
 *      with the right sourceRef + revision shape.
 *   2. Cursor handoff — the seed captures
 *      `getStartPageToken()` at seed-START and returns it as
 *      `result.cursor`, so the next `scan()` resumes from "now".
 *   3. Mime-type whitelist applied — files outside the
 *      whitelist are dropped (defense-in-depth, mirrors the
 *      C1 strict-include pin from listChanges).
 *   4. Subfolder recursion respects the binding's mime whitelist
 *      for FILES but always recurses into folders regardless of
 *      whitelist.
 *   5. `listFiles` missing on the injected DriveLikeApi → seed
 *      throws cleanly so the operator sees the misconfig
 *      (rather than silently emitting nothing).
 *   6. `partitionSeedListing` pure helper — predicate matrix
 *      so the filter-logic pin stays unit-testable.
 *   7. 1 MiB ceiling enforced on emit (matches scan-path
 *      assertion 7).
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  DRIVE_DEFAULT_MIME_TYPES,
  createGoogleDriveAdapter,
  partitionSeedListing,
  runDriveSeed,
} from "../src/index.js";
import type {
  DriveFileEntry,
  DriveListChangesResult,
  DriveListFilesArgs,
  DriveListFilesResult,
  DriveLikeApi,
} from "../src/drive-api.js";
import {
  createMockDriveSimulator,
  makeMockDrive,
} from "../src/testing/mock-drive.js";

const TEST_FOLDER = "folder-root";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedRefreshToken(
  store: CredentialStore,
): Promise<CredentialId> {
  return store.write({
    name: "drive-seed-creds",
    schemaRef: "google-drive-oauth/v1",
    plaintext: Buffer.from("refresh_token_seed_test"),
  });
}

// ---------------------------------------------------------------------------
// 1+2. Happy path + cursor handoff (via the adapter wiring)
// ---------------------------------------------------------------------------

describe("Drive seed — adapter wiring", () => {
  it("walks a folder + its subfolder recursively, emitting one doc per file", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();

    // Tree: folder-root contains 3 files + 1 subfolder; the
    // subfolder contains 1 file. Seed should emit 4 docs.
    sim.seedFile({
      fileId: "file-a",
      folderId: TEST_FOLDER,
      revision: "2026-05-01T00:00:00Z",
      bytes: Buffer.from("a"),
    });
    sim.seedFile({
      fileId: "file-b",
      folderId: TEST_FOLDER,
      revision: "2026-05-01T01:00:00Z",
      bytes: Buffer.from("b"),
    });
    sim.seedFile({
      fileId: "file-c",
      folderId: TEST_FOLDER,
      revision: "2026-05-01T02:00:00Z",
      bytes: Buffer.from("c"),
    });
    sim.addFolder({ folderId: "subfolder-1", parentId: TEST_FOLDER });
    sim.seedFile({
      fileId: "file-d",
      folderId: "subfolder-1",
      revision: "2026-05-01T03:00:00Z",
      bytes: Buffer.from("d"),
    });

    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      config: { folderId: TEST_FOLDER },
      makeDrive: makeMockDrive({ state: sim.state }),
    });

    const result = await adapter.seed!({});
    const ids = result.documents.map((d) => d.sourceDocId).sort();
    expect(ids).toEqual(["file-a", "file-b", "file-c", "file-d"]);
    expect(result.documents[0]?.sourceRef).toMatch(/^drive:/);
  });

  it("returns the getStartPageToken snapshot as result.cursor (seed-START boundary)", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    sim.seedFile({
      fileId: "doc-1",
      folderId: TEST_FOLDER,
      revision: "rev-1",
      bytes: Buffer.from("ok"),
    });

    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      config: { folderId: TEST_FOLDER },
      makeDrive: makeMockDrive({ state: sim.state }),
    });
    const result = await adapter.seed!({});
    // The mock always returns "0" from getStartPageToken (the
    // PR 23 contract — see mock-drive.ts:67). PR-Z2 captures
    // it as the seed-boundary token.
    expect(result.cursor).toBe("0");
  });

  it("emits sourceRef in the form 'drive:<fileId>' (matches scan path)", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    sim.seedFile({
      fileId: "1XYZabc",
      folderId: TEST_FOLDER,
      revision: "rev-1",
      bytes: Buffer.from("ok"),
    });
    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      config: { folderId: TEST_FOLDER },
      makeDrive: makeMockDrive({ state: sim.state }),
    });
    const result = await adapter.seed!({});
    expect(result.documents[0]?.sourceRef).toBe("drive:1XYZabc");
  });

  it("uses the file's modifiedTime as sourceRevision so a follow-up scan dedupes", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    sim.seedFile({
      fileId: "doc-1",
      folderId: TEST_FOLDER,
      revision: "2026-05-01T12:34:56Z",
      bytes: Buffer.from("ok"),
    });
    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      config: { folderId: TEST_FOLDER },
      makeDrive: makeMockDrive({ state: sim.state }),
    });
    const result = await adapter.seed!({});
    expect(result.documents[0]?.sourceRevision).toBe("2026-05-01T12:34:56Z");
  });
});

// ---------------------------------------------------------------------------
// 3. Mime-type whitelist
// ---------------------------------------------------------------------------

describe("Drive seed — mime-type whitelist", () => {
  it("drops files outside the configured mime whitelist", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    sim.seedFile({
      fileId: "doc-keep",
      folderId: TEST_FOLDER,
      mimeType: GOOGLE_DOC_MIME,
      revision: "r1",
      bytes: Buffer.from("ok"),
    });
    sim.seedFile({
      fileId: "video-drop",
      folderId: TEST_FOLDER,
      mimeType: "video/mp4",
      revision: "r1",
      bytes: Buffer.from("nope"),
    });
    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      config: { folderId: TEST_FOLDER },
      makeDrive: makeMockDrive({ state: sim.state }),
    });
    const result = await adapter.seed!({});
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["doc-keep"]);
  });

  it("recurses into subfolders even though the folder mime is not whitelisted", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    sim.addFolder({ folderId: "deep-folder", parentId: TEST_FOLDER });
    sim.seedFile({
      fileId: "deep-doc",
      folderId: "deep-folder",
      mimeType: GOOGLE_DOC_MIME,
      revision: "rdeep",
      bytes: Buffer.from("deep"),
    });
    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      // Strict whitelist with no folder mime — recursion must still work
      config: {
        folderId: TEST_FOLDER,
        mimeTypes: [...DRIVE_DEFAULT_MIME_TYPES],
      },
      makeDrive: makeMockDrive({ state: sim.state }),
    });
    const result = await adapter.seed!({});
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["deep-doc"]);
  });
});

// ---------------------------------------------------------------------------
// 4. listFiles-missing error
// ---------------------------------------------------------------------------

describe("Drive seed — listFiles missing on the injected client", () => {
  function makeClientWithoutListFiles(): DriveLikeApi {
    return {
      async getStartPageToken(): Promise<string> {
        return "stale-token";
      },
      async listChanges(): Promise<DriveListChangesResult> {
        return { changes: [], nextPageToken: "next" };
      },
      async exportAsBytes(): Promise<Buffer> {
        return Buffer.from("never");
      },
      // listFiles intentionally NOT set
    };
  }

  it("throws a clear error rather than silently emitting nothing", async () => {
    await expect(
      runDriveSeed({
        seedArgs: {},
        drive: makeClientWithoutListFiles(),
        folderId: TEST_FOLDER,
        mimeTypes: [...DRIVE_DEFAULT_MIME_TYPES],
        now: () => new Date("2026-05-10T00:00:00Z"),
      }),
    ).rejects.toThrow(/listFiles/);
  });
});

// ---------------------------------------------------------------------------
// 5. partitionSeedListing predicate matrix
// ---------------------------------------------------------------------------

describe("partitionSeedListing — pure filter helper", () => {
  function entry(
    fileId: string,
    mimeType: string,
    modifiedTime = "rev",
  ): DriveFileEntry {
    return { fileId, mimeType, modifiedTime };
  }

  it("separates folders from files", () => {
    const r = partitionSeedListing(
      [
        entry("f1", "application/vnd.google-apps.folder"),
        entry("d1", GOOGLE_DOC_MIME),
      ],
      [GOOGLE_DOC_MIME],
    );
    expect(r.subFolders.map((s) => s.fileId)).toEqual(["f1"]);
    expect(r.files.map((f) => f.fileId)).toEqual(["d1"]);
  });

  it("filters non-folder, non-whitelisted entries", () => {
    const r = partitionSeedListing(
      [entry("video", "video/mp4")],
      [GOOGLE_DOC_MIME],
    );
    expect(r.subFolders).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it("defensively skips entries with empty fileId", () => {
    const r = partitionSeedListing(
      [entry("", GOOGLE_DOC_MIME), entry("real", GOOGLE_DOC_MIME)],
      [GOOGLE_DOC_MIME],
    );
    expect(r.files.map((f) => f.fileId)).toEqual(["real"]);
  });
});

// ---------------------------------------------------------------------------
// 6. 1 MiB ceiling
// ---------------------------------------------------------------------------

describe("Drive seed — 1 MiB ceiling", () => {
  it("silently skips files larger than 1 MiB (mirrors scan-path assertion 7)", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    const oversized = Buffer.alloc(1024 * 1024 + 1, "x");
    sim.seedFile({
      fileId: "huge",
      folderId: TEST_FOLDER,
      revision: "r1",
      bytes: oversized,
    });
    sim.seedFile({
      fileId: "small",
      folderId: TEST_FOLDER,
      revision: "r2",
      bytes: Buffer.from("ok"),
    });
    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      config: { folderId: TEST_FOLDER },
      makeDrive: makeMockDrive({ state: sim.state }),
    });
    const result = await adapter.seed!({});
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["small"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Pagination — runDriveSeed walks past the first page
// ---------------------------------------------------------------------------

describe("Drive seed — pagination", () => {
  it("consumes nextPageToken until null before advancing to the next folder", async () => {
    const calls: DriveListFilesArgs[] = [];
    const driveWithPagination: DriveLikeApi = {
      async getStartPageToken(): Promise<string> {
        return "tok-after-seed";
      },
      async listChanges(): Promise<DriveListChangesResult> {
        return { changes: [], nextPageToken: "x" };
      },
      async exportAsBytes(): Promise<Buffer> {
        return Buffer.from("content");
      },
      async listFiles(args: DriveListFilesArgs): Promise<DriveListFilesResult> {
        calls.push(args);
        if (args.pageToken === undefined) {
          return {
            files: [
              { fileId: "p1", mimeType: GOOGLE_DOC_MIME, modifiedTime: "r1" },
            ],
            nextPageToken: "next-page",
          };
        }
        if (args.pageToken === "next-page") {
          return {
            files: [
              { fileId: "p2", mimeType: GOOGLE_DOC_MIME, modifiedTime: "r2" },
            ],
            nextPageToken: null,
          };
        }
        throw new Error(`unexpected pageToken ${args.pageToken}`);
      },
    };
    const result = await runDriveSeed({
      seedArgs: {},
      drive: driveWithPagination,
      folderId: TEST_FOLDER,
      mimeTypes: [GOOGLE_DOC_MIME],
      now: () => new Date("2026-05-10T00:00:00Z"),
    });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["p1", "p2"]);
    expect(result.cursor).toBe("tok-after-seed");
    expect(calls.length).toBe(2);
  });
});
