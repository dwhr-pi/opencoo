/**
 * Google Drive SourceAdapter (PR 23 / plan #111).
 *
 * Polling adapter that:
 *   1. Resolves the OAuth refresh token from the
 *      CredentialStore (THREAT-MODEL §3.6 invariant 11 — never
 *      from inline config).
 *   2. Calls Drive's changes API with the persisted page-token
 *      cursor, filters to the binding's mime-type whitelist,
 *      drops `removed: true` events.
 *   3. Exports each survivor's bytes via `exportAsBytes`,
 *      enforces the 1 MiB ceiling per the SourceAdapter
 *      contract assertion 7, and emits a SourceChangedDocument.
 *
 * The Drive client is injected — `makeDrive` takes the
 * resolved refresh token (Buffer plaintext from the
 * CredentialStore) and returns a `DriveLikeApi`. Production
 * wires `googleapis@>=144` here; tests wire `makeMockDrive`.
 *
 * THREAT-MODEL §3.6 invariant 11 — the factory's signature
 * REQUIRES `(credentialStore, credentialId)`. Inline
 * credential strings are not accepted. The contract suite
 * (assertion 9) pins this at type level.
 */
import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import type {
  SourceAdapter,
  SourceChangedDocument,
  SourceScanArgs,
  SourceScanResult,
} from "@opencoo/shared/source-adapter";

import { driveBindingConfigSchema } from "./binding-config.js";
import type { DriveLikeApi } from "./drive-api.js";

/** Per-adapter-instance content size ceiling. Matches the
 *  SourceAdapter contract assertion 7 + the Compilation
 *  Worker's prompt-budget assumption. */
const ONE_MIB = 1024 * 1024;

/** Stable adapter slug — matches `sources_bindings.adapter_slug`. */
export const DRIVE_ADAPTER_SLUG = "drive" as const;

export type MakeDrive = (refreshToken: Buffer) => DriveLikeApi;

export interface CreateDriveAdapterArgs {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  /** Persisted JSON from `sources_bindings.config` — accepted as
   *  `unknown` and validated through `driveBindingConfigSchema`
   *  inside the factory. (`DriveBindingConfig | unknown` would
   *  collapse to `unknown` anyway; declaring it as `unknown`
   *  makes the intent clear to readers.) */
  readonly config: unknown;
  readonly makeDrive: MakeDrive;
  readonly now?: () => Date;
}

/**
 * Factory for the Drive SourceAdapter. The factory shape is
 * the load-bearing pin for THREAT-MODEL §3.6 invariant 11:
 * credentials come from the CredentialStore by id, NEVER
 * inline. A future refactor that adds a `creds: { ... }`
 * argument breaks this invariant; the contract suite +
 * type-system enforce it.
 */
export function createGoogleDriveAdapter(
  args: CreateDriveAdapterArgs,
): SourceAdapter {
  // Validate the binding config at factory time. A misshapen
  // config is a deployment bug — fail loud here rather than
  // partway through the first scan.
  const config = driveBindingConfigSchema.parse(args.config);
  const now = args.now ?? ((): Date => new Date());

  return {
    slug: DRIVE_ADAPTER_SLUG,
    async scan(scanArgs: SourceScanArgs): Promise<SourceScanResult> {
      // Resolve the refresh token at scan time so a rotated
      // credential picks up on the next scan without an engine
      // restart. Production: the CredentialStore is backed by
      // the AES-256-GCM Drizzle store; tests: in-memory.
      const record = await args.credentialStore.read(args.credentialId);
      const drive = args.makeDrive(record.plaintext);

      // First scan: bootstrap with Drive's start-page-token.
      const pageToken =
        scanArgs.cursor ?? (await drive.getStartPageToken());

      const result = await drive.listChanges({
        pageToken,
        folderId: config.folderId,
        mimeTypes: config.mimeTypes,
      });

      const documents: SourceChangedDocument[] = [];
      for (const change of result.changes) {
        // Filter 1: removed events — no tombstone in v0.1.
        if (change.removed) continue;
        // Filter 2: mime-type whitelist (defense-in-depth; the
        // q parameter / mock honors it but we double-check).
        if (!config.mimeTypes.includes(change.mimeType)) continue;
        const bytes = await drive.exportAsBytes({
          fileId: change.fileId,
          mimeType: change.mimeType,
        });
        // Filter 3: 1 MiB ceiling. Per the contract suite
        // assertion 7, we don't emit oversize docs — they'd
        // overflow the BullMQ payload anyway.
        if (bytes.length > ONE_MIB) continue;
        documents.push({
          sourceDocId: change.fileId,
          sourceRevision: change.revision,
          sourceRef: `drive:${change.fileId}`,
          fetchedAt: now(),
          contentBytes: bytes,
        });
      }

      return {
        documents,
        nextCursor: result.nextPageToken,
      };
    },
  };
}
