/**
 * Real `googleapis@^144` Drive client wrapped to the
 * `DriveLikeApi` surface (PR-Z1, phase-a appendix #12).
 *
 * Why this file exists. The adapter package was originally
 * shipped with a mock-only client (`makeMockDrive`) and a
 * "production wiring lands at the composition root" promise
 * (see `drive-api.ts` header). The first real partner cutover
 * tripped over the unfulfilled promise — the production-side
 * `makeDrive` factory in `packages/cli/src/provision/production-composition.ts`
 * still threw `"drive: production makeDrive not wired in v0.1"`,
 * so binding a Drive folder via the UI provisioned cleanly but
 * scanning it failed at the first call. Z1 closes that gap by
 * wrapping the official Google SDK to the narrow shape the
 * adapter consumes.
 *
 * Boundary. The adapter calls only three methods on any Drive
 * client (see `DriveLikeApi` in `drive-api.ts`):
 *
 *   - `getStartPageToken()` — bootstrap the cursor for the
 *     first scan.
 *   - `listChanges({ pageToken, folderId, mimeTypes })` — pull
 *     the next change page.
 *   - `exportAsBytes({ fileId, mimeType })` — fetch a single
 *     file's bytes.
 *
 * This module maps each to the real Drive REST surface and
 * returns Buffers — no streaming, no batching, no sub-typing.
 * If a future scenario needs richer Drive features (resumable
 * uploads, partial responses, change-watcher webhooks), they
 * land as adapter-specific code and stay invisible to this
 * boundary.
 *
 * THREAT-MODEL alignment.
 *
 *   - The factory consumes a service-account JSON
 *     (`{ client_email, private_key, ... }`) decoded from the
 *     `Buffer` plaintext that the CredentialStore returns. The
 *     SDK uses it to mint short-lived bearer tokens via
 *     `google-auth-library`'s `JWT` class — the canonical
 *     service-account auth pattern.
 *   - Scope is locked to `drive.readonly`. opencoo never
 *     mutates Drive content. Read-only is also defense in
 *     depth: a leaked token can't be used to delete partner
 *     files.
 *   - We do NOT use OAuth2 client flows here — those would
 *     require a refresh-token-storage scheme distinct from the
 *     CredentialStore and a redirect handler the engine
 *     intentionally doesn't ship.
 *   - The `parseServiceAccountJson` helper validates the two
 *     required fields and throws a typed error on bad input.
 *     We deliberately avoid pulling `zod` into this module —
 *     a 12-line hand-rolled parser is cheaper than the bundle
 *     hit and the errors it produces are equally actionable.
 *
 * Shared-drive support. Drive REST calls that accept a
 * drive-type flag get `supportsAllDrives: true` (and, where
 * the endpoint accepts it, `includeItemsFromAllDrives: true`)
 * unconditionally — `changes.getStartPageToken`,
 * `changes.list`, and `files.get` all receive it. The binding
 * might be on My Drive OR a shared drive (the common
 * enterprise pattern on Google Workspace), and the engine
 * doesn't know which at scan time. Always opting in matches
 * Google's recommended pattern for "I don't know which drive
 * type the user has" and avoids silently dropping shared-drive
 * items from the change feed. (Note: `files.export` does NOT
 * accept the flag in Drive REST v3 — by the time we call it
 * the file's drive type has already been resolved via
 * changes.list, so the export endpoint operates on a known
 * fileId without needing the hint.)
 */
import { google } from "googleapis";
import { JWT } from "google-auth-library";

import type {
  DriveChangeEntry,
  DriveExportArgs,
  DriveFileEntry,
  DriveLikeApi,
  DriveListChangesArgs,
  DriveListChangesResult,
  DriveListFilesArgs,
  DriveListFilesResult,
} from "./drive-api.js";

/**
 * Minimum subset of the Google service-account key JSON that
 * opencoo cares about. The real key file carries 7+ fields
 * (`type`, `project_id`, `private_key_id`, …); the others are
 * ignored — `JWT` only needs the email + private key.
 */
export interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
}

/**
 * Read-only scope. Opencoo never mutates Drive content; the
 * SDK enforces the scope when minting the bearer token.
 */
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Hint Drive prefer markdown when exporting Google Docs.
 *  Drive accepts `text/markdown` as of 2024; if a workspace
 *  has it disabled we fall back to plain text on a per-call
 *  basis — see `exportAsBytes`. */
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const MARKDOWN_MIME = "text/markdown";
const PLAIN_TEXT_MIME = "text/plain";

/**
 * Default page size for `listChanges`. Drive's API max is
 * 1000; defaulting to 100 keeps individual responses small
 * (matches the design-partner PoC's polling cadence — 4-hour
 * scans on small folders). Adapters that want a larger page
 * pass a different value through the (currently absent)
 * binding-config knob; the real-API test pins the default.
 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Defensive parse of the service-account JSON. Returns the
 * minimal `ServiceAccountKey` shape; throws a typed Error on
 * any structural problem so the operator sees a clear message
 * rather than a Drive 401 buried five frames deep.
 */
export function parseServiceAccountJson(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `drive: service-account JSON is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "drive: service-account JSON must be an object with client_email + private_key",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const email = obj["client_email"];
  const key = obj["private_key"];
  if (typeof email !== "string" || email.length === 0) {
    throw new Error(
      "drive: service-account JSON missing required field 'client_email'",
    );
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      "drive: service-account JSON missing required field 'private_key'",
    );
  }
  return { client_email: email, private_key: key };
}

/**
 * Build the production `DriveLikeApi` from a parsed
 * service-account key. Each instance owns its own `JWT` —
 * tokens are cached inside the SDK, so reusing the returned
 * `DriveLikeApi` across scans is the cheap path.
 *
 * The shape is deliberately NOT a class — the adapter
 * consumes the interface, and a plain object closes over the
 * `drive` handle without giving callers a subclassing knob.
 */
export function createGoogleDriveApi(
  credentials: ServiceAccountKey,
): DriveLikeApi {
  const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [DRIVE_READONLY_SCOPE],
  });
  const drive = google.drive({ version: "v3", auth });

  return {
    async getStartPageToken(): Promise<string> {
      const response = await drive.changes.getStartPageToken({
        supportsAllDrives: true,
      });
      const token = response.data.startPageToken;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error(
          "drive: getStartPageToken returned empty startPageToken",
        );
      }
      return token;
    },

    async listChanges(
      args: DriveListChangesArgs,
    ): Promise<DriveListChangesResult> {
      // The Drive API's `q` parameter doesn't apply to the
      // changes feed — it filters `files.list`, not
      // `changes.list`. The adapter post-filters by folderId
      // already (defense-in-depth in `adapter.ts`); we apply
      // the same per-mime-type narrowing here against
      // `file.mimeType` returned in the change payload.
      const response = await drive.changes.list({
        pageToken: args.pageToken,
        pageSize: DEFAULT_PAGE_SIZE,
        // Include modifiedTime + mimeType + parents so the
        // adapter can dedupe + folder-filter without a second
        // round trip per change.
        fields:
          "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,modifiedTime,mimeType,parents))",
        // Shared-drive support — see file header. Default
        // `restrictToMyDrive=false` lets shared-drive
        // scenarios work; opting in via supportsAllDrives +
        // includeItemsFromAllDrives is Google's recommended
        // pattern when the consumer doesn't know which drive
        // type the binding lives on.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const data = response.data;
      const changes = filterChangesByFolderId(data.changes ?? [], {
        folderId: args.folderId,
        mimeTypes: args.mimeTypes,
      });

      // Drive returns `nextPageToken` while paginating, then
      // `newStartPageToken` on the final page. The adapter's
      // contract is "always return a token to persist", so we
      // pick whichever is present (preferring nextPageToken
      // when both are absent we fall back to the input token,
      // matching the mock's monotonic-counter behavior).
      const nextPageToken =
        data.nextPageToken ?? data.newStartPageToken ?? args.pageToken;

      return {
        changes,
        nextPageToken,
      };
    },

    async exportAsBytes(args: DriveExportArgs): Promise<Buffer> {
      // v0.1 scope: only Google Docs flow through `files.export`.
      // Other Google-native types (Sheets, Slides, Forms, Drawings)
      // would also need export with a per-type target mime — they're
      // out of scope today because the default binding-config
      // `mimeTypes` whitelist is `[google-doc, pdf]` (see
      // binding-config.ts), so Sheets/Slides/Forms/Drawings never
      // appear in the changes stream. If an operator widens the
      // whitelist, the `files.get?alt=media` path below will surface
      // Drive's "Use Export with Docs Editors files" 400 — that's
      // the signal to extend this routing. Tracked as a v0.2
      // follow-up. PDF, plain text, images, etc. continue through
      // `files.get?alt=media`.
      if (args.mimeType === GOOGLE_DOC_MIME) {
        // Prefer markdown — Drive added it in 2024 and the
        // wiki compiler likes the lighter normalization step.
        // If the workspace has markdown export disabled the
        // export call returns a 400; fall back to plain text
        // so the adapter still gets bytes.
        try {
          // Note: `files.export` does NOT accept
          // `supportsAllDrives` (the Drive REST API doesn't
          // expose the flag on this endpoint — only on
          // changes.list / changes.getStartPageToken /
          // files.get / files.list / files.update etc.). The
          // file's drive type was already resolved at the
          // changes.list step.
          const response = await drive.files.export(
            { fileId: args.fileId, mimeType: MARKDOWN_MIME },
            { responseType: "arraybuffer" },
          );
          return arrayBufferDataToBuffer(response.data);
        } catch (err) {
          // Tighten the fallback to the documented "format
          // unavailable" failure mode. Any other error
          // (auth, network, 5xx) bubbles unchanged.
          if (!isMarkdownExportUnavailable(err)) throw err;
          const response = await drive.files.export(
            { fileId: args.fileId, mimeType: PLAIN_TEXT_MIME },
            { responseType: "arraybuffer" },
          );
          return arrayBufferDataToBuffer(response.data);
        }
      }

      const response = await drive.files.get(
        {
          fileId: args.fileId,
          alt: "media",
          // Shared-drive support — see file header.
          supportsAllDrives: true,
        },
        { responseType: "arraybuffer" },
      );
      return arrayBufferDataToBuffer(response.data);
    },

    async listFiles(args: DriveListFilesArgs): Promise<DriveListFilesResult> {
      // PR-Z2 — direct children of `folderId`. Drive's `q`
      // operator has no "descendants of"; recursion is handled
      // by the seed walker in `seed.ts`. We DO NOT filter by
      // mime type here — the seed walker needs to see folders
      // (the recursion targets) AND files; mime-type filtering
      // is applied after the children come back, mirroring the
      // C1 strict include-test in `listChanges`.
      //
      // Shared-drive support: same shape as `listChanges` —
      // `supportsAllDrives + includeItemsFromAllDrives` opt the
      // call into shared drives without needing to know the
      // drive type. `corpora: 'allDrives'` is required when
      // walking files across a shared drive without restricting
      // by `driveId` (Google's documented pattern for
      // "I don't know which drive type the user has").
      const response = await drive.files.list({
        q: `'${args.folderId}' in parents and trashed = false`,
        pageSize: DEFAULT_PAGE_SIZE,
        fields: "nextPageToken,files(id,mimeType,modifiedTime)",
        // Explicit page token on every call. Drive's SDK
        // tolerates `undefined` (treats it as "first page"),
        // but being explicit keeps the call shape symmetric
        // with `listChanges`.
        ...(args.pageToken !== undefined ? { pageToken: args.pageToken } : {}),
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
      });
      const data = response.data;
      const rawFiles = data.files ?? [];
      const files: DriveFileEntry[] = [];
      for (const f of rawFiles) {
        const id = f.id;
        const mimeType = f.mimeType;
        if (typeof id !== "string" || id.length === 0) continue;
        if (typeof mimeType !== "string" || mimeType.length === 0) continue;
        files.push({
          fileId: id,
          mimeType,
          modifiedTime: typeof f.modifiedTime === "string" ? f.modifiedTime : "",
        });
      }
      return {
        files,
        nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : null,
      };
    },
  };
}

/**
 * Structural shape of a Drive `changes.list` entry — narrow
 * enough that the helper below can be unit-tested without
 * standing up the full `googleapis` SDK or its typings. The
 * real `drive_v3.Schema$Change` is structurally assignable to
 * this; we re-declare only the fields we read.
 */
export interface RawDriveChange {
  readonly fileId?: string | null;
  readonly removed?: boolean | null;
  readonly file?: {
    readonly id?: string | null;
    readonly modifiedTime?: string | null;
    readonly mimeType?: string | null;
    readonly parents?: readonly string[] | null;
  } | null;
}

/**
 * Pure transform: take Drive's raw `changes` payload + the
 * binding's `folderId` / `mimeTypes` filter, return the
 * `DriveChangeEntry[]` the adapter consumes. Extracted from
 * `listChanges` so the filter logic — in particular the C1
 * fix-up around `parents.length === 0` — is testable without
 * mocking the SDK.
 *
 * Semantics:
 *   - Removed events flow through (emit a tombstone-shaped
 *     entry; the adapter drops them downstream).
 *   - Missing/empty fileId → skip (defensive).
 *   - Mime-type whitelist applied against the change's
 *     `file.mimeType`.
 *   - Parents include-test is STRICT: empty/missing parents
 *     skip. This matches the mock's `file.folderId !==
 *     args.folderId → skip` behavior and closes the C1 scope
 *     leak (legitimate Drive payloads can return `parents: []`
 *     for root-moved files, shared-link-only access, certain
 *     shared-drive items, and field-mask edge cases).
 */
export function filterChangesByFolderId(
  rawChanges: readonly RawDriveChange[],
  args: {
    readonly folderId: string;
    readonly mimeTypes: readonly string[];
  },
): DriveChangeEntry[] {
  const out: DriveChangeEntry[] = [];
  for (const change of rawChanges) {
    const fileId = change.fileId;
    if (typeof fileId !== "string" || fileId.length === 0) continue;

    if (change.removed === true) {
      out.push({
        fileId,
        revision: "",
        mimeType: "",
        removed: true,
      });
      continue;
    }

    const file = change.file;
    if (file === null || file === undefined) continue;
    const mimeType = file.mimeType;
    if (typeof mimeType !== "string") continue;
    if (!args.mimeTypes.includes(mimeType)) continue;

    const parents = file.parents ?? [];
    if (!parents.includes(args.folderId)) continue;

    out.push({
      fileId,
      revision: file.modifiedTime ?? "",
      mimeType,
      removed: false,
    });
  }
  return out;
}

/** googleapis returns `unknown` for `responseType: 'arraybuffer'`
 *  bodies (the SDK's typing is generic). Coerce defensively —
 *  Buffer.from accepts both ArrayBuffer and Buffer-already
 *  inputs without copying twice. */
function arrayBufferDataToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    // Typed-array / DataView (Uint8Array, etc.) — Buffer.from
    // accepts a typed-array directly. The platform guard is more
    // precise than duck-typing on `byteLength`/`buffer` (Copilot
    // PR #106 review).
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error(
    "drive: export response was not an ArrayBuffer / Buffer payload",
  );
}

/** Detects the documented "this file's mime type doesn't
 *  support the requested export format" error so we can fall
 *  back to text/plain.
 *
 *  Drive's REAL "format unavailable" 400 carries
 *  `errors[0].reason === "exportFormatUnsupported"` (or, on
 *  some API versions, a message containing "format" / "not
 *  supported"). Previously this predicate matched ANY 400 —
 *  an auth-permission 400 or a malformed-fileId 400 would
 *  silently downgrade to plain-text instead of bubbling up.
 *  We now inspect the reason string (canonical signal) with a
 *  defensive message-substring fallback for API versions that
 *  don't populate `errors[]`.
 *
 *  GaxiosError in gaxios@6.x uses a numeric `code` for HTTP
 *  status — the previous `code === "400"` string branch was
 *  dead (I2 fold-in). */
export function isMarkdownExportUnavailable(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const obj = err as Record<string, unknown>;
  // GaxiosError code is numeric in gaxios@6.x; some SDK
  // versions surface 400 on `status` instead.
  const isHttp400 = obj["code"] === 400 || obj["status"] === 400;
  if (!isHttp400) return false;
  // errors[0].reason === "exportFormatUnsupported" is the
  // canonical signal.
  const errors = obj["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    if (first !== null && typeof first === "object") {
      const reason = (first as Record<string, unknown>)["reason"];
      if (
        typeof reason === "string" &&
        /exportFormat|formatUnsupported/i.test(reason)
      ) {
        return true;
      }
    }
  }
  // Defensive fallback: inspect message substring (some API
  // versions don't populate errors[]).
  const message = obj["message"];
  if (
    typeof message === "string" &&
    /format.+(unsupported|not (available|supported))/i.test(message)
  ) {
    return true;
  }
  return false;
}
