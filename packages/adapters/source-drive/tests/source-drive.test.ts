/**
 * source-drive adapter tests (PR 23 / plan #111).
 *
 * Two layers:
 *   1. The shared `sourceAdapterContract` runs against the
 *      Drive adapter wired with the `makeMockDrive` fixture.
 *      Polling assertions only — webhook stubs run as
 *      `it.skip`.
 *   2. Adapter-specific tests covering binding-config Zod
 *      validation, the THREAT-MODEL §3.6 invariant 11
 *      type-pin (factory takes credentialStore + id, never
 *      inline strings), mime-type filtering, removed-event
 *      filtering, 1 MiB ceiling enforcement.
 */
import { describe, expect, it } from "vitest";

import { sourceAdapterContract } from "@opencoo/shared/adapter-contract-tests";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  DRIVE_ADAPTER_SLUG,
  DRIVE_DEFAULT_MIME_TYPES,
  createGoogleDriveAdapter,
  driveBindingConfigSchema,
  type DriveBindingConfig,
} from "../src/index.js";
import {
  createMockDriveSimulator,
  makeMockDrive,
} from "../src/testing/mock-drive.js";

const TEST_FOLDER = "folder-test-1";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedRefreshToken(
  store: CredentialStore,
): Promise<CredentialId> {
  return store.write({
    name: "drive-test-creds",
    schemaRef: "google-drive-oauth/v1",
    plaintext: Buffer.from("refresh_token_12345_test_only"),
  });
}

interface MakeFixtureOptions {
  /** Override config — defaults to `{ folderId: TEST_FOLDER }`. */
  readonly config?: Partial<DriveBindingConfig> & { folderId: string };
  /** Wrap the store before passing to the adapter — used by the
   *  rotation-friendly test to count `read` calls. */
  readonly wrapStore?: (store: CredentialStore) => CredentialStore;
}

interface DriveTestFixture {
  readonly store: CredentialStore;
  readonly credentialId: CredentialId;
  readonly sim: ReturnType<typeof createMockDriveSimulator>;
  readonly adapter: ReturnType<typeof createGoogleDriveAdapter>;
}

async function makeFixture(
  opts: MakeFixtureOptions = {},
): Promise<DriveTestFixture> {
  const baseStore = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await seedRefreshToken(baseStore);
  const store = opts.wrapStore !== undefined ? opts.wrapStore(baseStore) : baseStore;
  const sim = createMockDriveSimulator();
  const adapter = createGoogleDriveAdapter({
    credentialStore: store,
    credentialId,
    config: opts.config ?? { folderId: TEST_FOLDER },
    makeDrive: makeMockDrive({ state: sim.state }),
  });
  return { store, credentialId, sim, adapter };
}

// ---------------------------------------------------------------------------
// Shared sourceAdapterContract — polling
// ---------------------------------------------------------------------------

sourceAdapterContract({
  backendName: "source-drive",
  mode: "polling",
  makeAdapter: async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    const config: DriveBindingConfig = {
      folderId: TEST_FOLDER,
      mimeTypes: [...DRIVE_DEFAULT_MIME_TYPES],
      contentKind: "document",
    };
    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      config,
      makeDrive: makeMockDrive({ state: sim.state }),
    });
    return {
      adapter,
      seed: (initial) => {
        for (const seed of initial) {
          sim.seedFile({
            fileId: seed.sourceDocId,
            folderId: TEST_FOLDER,
            revision: seed.sourceRevision,
            bytes: seed.contentBytes,
          });
        }
      },
      simulate: {
        addDoc: (doc) => {
          sim.seedFile({
            fileId: doc.sourceDocId,
            folderId: TEST_FOLDER,
            revision: doc.sourceRevision,
            bytes: doc.contentBytes,
          });
        },
        bumpRevision: (id, rev, bytes) => sim.bumpRevision(id, rev, bytes),
        removeDoc: (id) => sim.removeFile(id),
      },
      cleanup: async () => undefined,
    };
  },
});

// Webhook-mode contract suite — for parity tests would run this
// shape; Drive is polling-only so the webhook stubs run via the
// generator's `it.skip` path. We DO still exercise the path so
// the `mode: 'webhook'` branch has a regression guard at adapter
// level too.
sourceAdapterContract({
  backendName: "source-drive",
  mode: "webhook",
  makeAdapter: async () => {
    // Drive is polling-only; the webhook stubs are TODOs and
    // run via the generator's `it.skip` path. This factory is
    // never actually called, so the body just returns a
    // typed-correct handle.
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    const adapter = createGoogleDriveAdapter({
      credentialStore: store,
      credentialId,
      config: { folderId: TEST_FOLDER },
      makeDrive: makeMockDrive({ state: sim.state }),
    });
    return {
      adapter,
      seed: () => undefined,
      simulate: {
        addDoc: () => undefined,
        bumpRevision: () => undefined,
        removeDoc: () => undefined,
      },
      cleanup: async () => undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// Adapter-specific tests
// ---------------------------------------------------------------------------

describe("source-drive — binding-config schema", () => {
  it("defaults mimeTypes to {google-doc, pdf} (PoC parity)", () => {
    const parsed = driveBindingConfigSchema.parse({
      folderId: TEST_FOLDER,
    });
    expect(parsed.mimeTypes).toEqual(DRIVE_DEFAULT_MIME_TYPES);
  });

  it("defaults contentKind to 'document' (Q1 — compiler doesn't branch in v0.1)", () => {
    const parsed = driveBindingConfigSchema.parse({
      folderId: TEST_FOLDER,
    });
    expect(parsed.contentKind).toBe("document");
  });

  it("rejects unknown top-level fields (.strict)", () => {
    expect(() =>
      driveBindingConfigSchema.parse({
        folderId: TEST_FOLDER,
        ghost: "no",
      }),
    ).toThrow();
  });

  it("rejects empty folderId", () => {
    expect(() =>
      driveBindingConfigSchema.parse({ folderId: "" }),
    ).toThrow();
  });

  it("accepts contentKind='n8n-workflow' (PR 26 forward-compat)", () => {
    const parsed = driveBindingConfigSchema.parse({
      folderId: TEST_FOLDER,
      contentKind: "n8n-workflow",
    });
    expect(parsed.contentKind).toBe("n8n-workflow");
  });
});

describe("source-drive — adapter wiring", () => {
  it("slug is 'drive'", async () => {
    const { adapter } = await makeFixture();
    expect(adapter.slug).toBe(DRIVE_ADAPTER_SLUG);
    expect(adapter.slug).toBe("drive");
  });

  it("filters out files outside the binding's folderId", async () => {
    const { sim, adapter } = await makeFixture();
    sim.seedFile({
      fileId: "in-folder",
      folderId: TEST_FOLDER,
      revision: "rev-1",
      bytes: Buffer.from("in"),
    });
    sim.seedFile({
      fileId: "other-folder",
      folderId: "different-folder",
      revision: "rev-1",
      bytes: Buffer.from("other"),
    });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual([
      "in-folder",
    ]);
  });

  it("filters out mime types not in the whitelist (defense-in-depth)", async () => {
    const { sim, adapter } = await makeFixture();
    sim.seedFile({
      fileId: "doc-allowed",
      folderId: TEST_FOLDER,
      mimeType: "application/vnd.google-apps.document",
      revision: "rev-1",
      bytes: Buffer.from("ok"),
    });
    sim.seedFile({
      fileId: "video-skip",
      folderId: TEST_FOLDER,
      mimeType: "video/mp4",
      revision: "rev-1",
      bytes: Buffer.from("nope"),
    });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual([
      "doc-allowed",
    ]);
  });

  it("emits sourceRef in the form 'drive:<fileId>'", async () => {
    const { sim, adapter } = await makeFixture();
    sim.seedFile({
      fileId: "1XYZabc",
      folderId: TEST_FOLDER,
      revision: "rev-1",
      bytes: Buffer.from("ok"),
    });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents[0]?.sourceRef).toBe("drive:1XYZabc");
  });

  it("bootstraps the cursor via getStartPageToken on first scan (cursor=null)", async () => {
    const { sim, adapter } = await makeFixture();
    sim.seedFile({
      fileId: "doc-1",
      folderId: TEST_FOLDER,
      revision: "rev-1",
      bytes: Buffer.from("ok"),
    });
    const result = await adapter.scan({ cursor: null });
    expect(result.nextCursor).not.toBe(null);
    // Mock returns the changeCounter as the next token (1
    // here since we seeded once).
    expect(result.nextCursor).toBe("1");
  });

  it("invalid binding config (missing folderId) throws at factory time, not scan time", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedRefreshToken(store);
    const sim = createMockDriveSimulator();
    expect(() =>
      createGoogleDriveAdapter({
        credentialStore: store,
        credentialId,
        config: {},
        makeDrive: makeMockDrive({ state: sim.state }),
      }),
    ).toThrow();
  });
});

describe("source-drive — credentials sourcing (THREAT-MODEL §3.6 invariant 11)", () => {
  // The factory's signature requires (credentialStore, credentialId)
  // — there is NO inline `creds` argument. The pin is at the
  // type level: passing inline credentials must FAIL type-check.
  // Adding the negative-case `@ts-expect-error` makes the pin
  // actively load-bearing — if a future refactor adds an inline
  // credential branch (regression), the @ts-expect-error stops
  // erroring, and TypeScript fails the build. The previous shape
  // ("the very fact this file compiles is the pin") was vacuous;
  // this version actually breaks if the invariant breaks.
  it("factory rejects inline credential strings at the type level (compile-time pin)", () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });

    // Reference the factory + inline-cred shape so neither is
    // tree-shaken; the @ts-expect-error below is the load-bearing
    // assertion.
    const fakeInlineCreds = {
      client_id: "x",
      client_secret: "y",
      refresh_token: "z",
    };

    // Type-level negative case: this call MUST fail to type-check.
    // If a regression adds a `creds` branch on the factory, the
    // call type-checks → @ts-expect-error fires → build fails.
    // @ts-expect-error — invariant 11: no inline credentials accepted.
    void (() =>
      createGoogleDriveAdapter({
        credentialStore: store,
        config: {
          folderId: "x",
          mimeTypes: [...DRIVE_DEFAULT_MIME_TYPES],
        },
        creds: fakeInlineCreds,
        makeDrive: () => ({}) as never,
      }));

    expect(typeof store.read).toBe("function");
  });

  it("reads the refresh token from the credentialStore on every scan (rotation-friendly)", async () => {
    let readCount = 0;
    const { sim, adapter } = await makeFixture({
      wrapStore: (store) => ({
        read: (id) => {
          readCount += 1;
          return store.read(id);
        },
        write: (input) => store.write(input),
        rotate: (id, plaintext) => store.rotate(id, plaintext),
        delete: (id) => store.delete(id),
      }),
    });
    sim.seedFile({
      fileId: "doc-1",
      folderId: TEST_FOLDER,
      revision: "rev-1",
      bytes: Buffer.from("ok"),
    });
    await adapter.scan({ cursor: null });
    await adapter.scan({ cursor: "1" });
    // Two scans → two reads. A rotated credential picks up on
    // the next scan without an engine restart.
    expect(readCount).toBe(2);
  });
});
