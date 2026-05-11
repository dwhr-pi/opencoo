/**
 * `SourceAdapter` — minimal v0.1 port for source ingestion
 * (architecture §10 SourceAdapter, plan #77 Q3 minimal surface).
 *
 * Concrete adapters (Drive, Asana, Fireflies, n8n, gitea-wiki)
 * land in PR 23+. v0.1 only ships the port shape so the Scanner
 * pipeline + the engine harness can compile against it.
 *
 * The Scanner persists `nextCursor` into
 * `sources_bindings.last_scan_cursor` after a successful scan
 * (migration 0004). The cursor is opaque: the engine does not
 * parse it; the adapter sees what it returned last time.
 *
 * The Compilation Worker inlines `contentBytes` into the
 * BullMQ job payload (1MiB cap; SpotlightOverflowError catches
 * overflow during classification). PR 23+ swaps to a re-fetch
 * pattern when adapters land — at that point `contentBytes`
 * goes away and the worker calls `adapter.fetch(sourceRef)`.
 */

export interface SourceScanArgs {
  /** Cursor persisted from the previous scan, or `null` for a
   *  first run. The adapter chooses the semantics — Drive uses
   *  a change-token, Asana uses a sync cursor, Fireflies uses
   *  a since-timestamp ISO string. */
  readonly cursor: string | null;
  /** Optional clock injection for deterministic tests. Adapters
   *  that don't need a clock ignore this field. */
  readonly now?: number;
}

export interface SourceChangedDocument {
  /** Source-system identifier — opaque text. Combined with
   *  sourceRevision to form the `ingestion_intake` UNIQUE key
   *  (binding_id, source_doc_id, source_revision). */
  readonly sourceDocId: string;
  /** Source-system version of this document — opaque text. A
   *  new sourceRevision means the body changed; same revision
   *  means a no-op (Scanner skips re-classifying). */
  readonly sourceRevision: string;
  /** Human-readable reference for audit logs and citations,
   *  e.g. `drive:1XYZ...`, `asana:task/1234`. */
  readonly sourceRef: string;
  /** When the adapter fetched this document. */
  readonly fetchedAt: Date;
  /** Inline document bytes for the Compilation Worker to
   *  consume. v0.1 inlines into the BullMQ job payload (1MiB
   *  cap); PR 23+ replaces with re-fetch. */
  readonly contentBytes: Buffer;
  /** Optional adapter-supplied metadata that downstream
   *  Compiler or pipeline steps may consume. Extension point —
   *  callers ignore fields they don't understand.
   *  PR-F adds `summary` (Light-tier one-liner). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceScanResult {
  /** Documents that changed since `cursor`. Empty array means
   *  no work for the Scanner — it persists the new cursor and
   *  exits cleanly. */
  readonly documents: readonly SourceChangedDocument[];
  /** Cursor for the NEXT scan. `null` is legal when the
   *  adapter has no resumable cursor (e.g. a stateless
   *  full-fetch adapter). */
  readonly nextCursor: string | null;
}

/**
 * Args for the optional `seed()` primitive (PR-Z2, phase-a
 * appendix #12 G2). Brand-new bindings sync forward from the
 * moment they're created — Drive's existing files and Asana's
 * existing tasks are invisible until they change. `seed()` is
 * the "initial pull from zero" path called on binding-create
 * (Z3 wires the trigger) and on a manual "Scan now" against a
 * cursor-less binding.
 *
 * Deliberately NO `cursor` field — the seed is always a fresh
 * full-fetch from the source's current state. The result's
 * `cursor` (analogous to `SourceScanResult.nextCursor`) is the
 * handoff that subsequent `scan()` invocations resume from, so
 * the seed-to-scan boundary doesn't re-emit documents that
 * were already part of the seed.
 *
 * Adapters that don't need a backfill (webhook-only sources
 * like Fireflies — meeting transcripts only exist
 * forward-in-time) MAY leave `seed` undefined; the scanner
 * falls back to `scan()` even on the first tick for those.
 */
export interface SourceSeedArgs {
  /** Optional clock injection for deterministic tests. Adapters
   *  that don't need a clock ignore this field. Mirrors the
   *  same field on `SourceScanArgs`. */
  readonly now?: number;
}

/**
 * Result of `seed()`. Shape mirrors `SourceScanResult` so the
 * Scanner's intake-dedupe + enqueue path can consume either
 * without branching on the source. The `cursor` field is the
 * persisted `sources_bindings.last_scan_cursor` after the
 * seed completes — the next scanner tick reads it via
 * `scan({ cursor })`, not `seed()`.
 */
export interface SourceSeedResult {
  /** Documents pulled in the seed. Flow through the same
   *  `ingestion_intake` UNIQUE(binding_id, source_doc_id,
   *  source_revision) dedupe path that `scan()` results do —
   *  a partial-seed replay is idempotent. */
  readonly documents: readonly SourceChangedDocument[];
  /** Cursor for the FIRST subsequent `scan()` call. **Always
   *  non-null** because the scanner uses `last_scan_cursor ===
   *  null` as the "this binding still needs seeding" flag — a
   *  null cursor after a successful seed would cause every tick
   *  to re-route to `seed()` forever. For Drive this is the
   *  `getStartPageToken()` snapshot captured at seed-START (so
   *  the change feed doesn't double-deliver files between
   *  seed-start and seed-end as "changes"). For webhook
   *  adapters where there's no resumable cursor (e.g. Asana),
   *  return an opaque sentinel like `<slug>-seeded:<ISO>` that
   *  `scan()` MUST treat as "no-op" (Asana's scan ignores its
   *  input cursor entirely; sentinel is operator-readable for
   *  forensics). Future webhook adapters that don't need a
   *  sentinel can return any non-empty marker string. */
  readonly cursor: string;
}

/**
 * Per-event shape emitted by webhook-mode adapters when their
 * `parseEvents` helper unpacks an inbound webhook body. The
 * receiver in engine-ingestion (PR 14) cross-references
 * `eventId` against the `webhook_events` UNIQUE index for
 * replay dedupe, then pushes the doc into the same intake
 * path polling-mode adapters use.
 */
export interface SourceWebhookEvent {
  /** Source-system event id (Asana `event.gid` etc.). The
   *  receiver dedupes replays on this. */
  readonly eventId: string;
  /** The doc the event surfaces, in the same shape polling
   *  adapters emit. Mostly useful in PR 30 wiring; the
   *  contract suite asserts shape. */
  readonly doc: SourceChangedDocument;
  /** Optional semantic event type derived by the adapter.
   *  PR-F (source-asana v2) populates this for Asana events;
   *  other adapters may leave it undefined. Downstream Compiler
   *  templates may use this for routing or template selection. */
  readonly eventType?: string;
}

/**
 * Returned by `handshakeFn` when a registration handshake is
 * detected. The receiver echoes `secret` in the response header,
 * persists it to the CredentialStore, and skips all verification
 * + intake steps for this request.
 */
export interface HandshakeResult {
  /** The raw secret to echo back in the response header. */
  readonly secret: string;
  /** schemaRef under which the secret should be persisted in
   *  the CredentialStore. Defaults to the adapter-defined
   *  schema if not set by the adapter. */
  readonly schemaRef?: string;
}

/**
 * Webhook-mode helpers an adapter exposes (PR 24 / plan #115;
 * extended in PR-F with handshakeFn).
 * Polling adapters do NOT set this. The engine-ingestion
 * webhook receiver consumes the helpers via DI:
 *
 *   0. (PR-F) Check `handshakeFn?.(headers)` BEFORE signature
 *      verification. If it returns a HandshakeResult, run the
 *      handshake branch (echo secret + persist + return 200)
 *      without touching signature verification or intake.
 *   1. Lookup binding → fetch webhook secret from
 *      CredentialStore.
 *   2. `extractSignature(req.headers)` → string | undefined.
 *   3. `verifier.verify({ body, secret, signature })` →
 *      reject ValidationError on failure.
 *   4. `parseEvents(body)` → list of `SourceWebhookEvent`s.
 *   5. Dedupe each `eventId` against `webhook_events` UNIQUE
 *      key; insert into intake.
 *
 * The brief / plan #115 keeps HMAC verification in the
 * RECEIVER (engine-ingestion) so the adapter package stays
 * dependency-free of req/res abstractions; the helpers below
 * are pure functions the receiver composes.
 */
export interface SourceWebhookHelpers {
  /** Verifies a body+signature against the binding's webhook
   *  secret. Stateless — caller passes everything. */
  readonly verifier: import("../webhook-verifier/interface.js").WebhookVerifier;
  /** Extracts the signature string from request headers. The
   *  header name varies by source (Asana: `X-Hook-Signature`,
   *  Gitea: `X-Hub-Signature-256`); this helper localises the
   *  detail. Returns undefined if absent.
   *
   *  Headers may carry `string | string[] | undefined` — Fastify
   *  preserves multi-value headers as arrays. Adapters should
   *  take the last value or join as appropriate; Asana's
   *  signature headers are always single-valued in practice.
   *
   *  Optional from PR-Q7: when omitted, the receiver falls back
   *  to `headers["x-signature"]` for backwards compatibility with
   *  adapters that haven't been migrated. New adapters with a
   *  source-specific header (Asana, Fireflies) MUST set this. */
  extractSignature?(headers: Readonly<Record<string, string | string[] | undefined>>):
    | string
    | undefined;
  /**
   * (PR-Q7) Unwraps the inner HMAC secret from the credential plaintext.
   *
   * The admin-API source-bindings route stores webhook secrets as
   * `JSON.stringify(webhookCreds.webhook_secret)` — the FULL
   * `webhook_secret` object the operator submitted, e.g.
   * `{"x_hook_secret":"<asana-secret>"}` for Asana,
   * `{"signing_secret":"<fireflies-secret>"}` for Fireflies / generic
   * webhook (see
   * `engine-self-operating/src/admin-api/routes/source-bindings.ts:660-664`).
   * No real upstream signs payloads with that wrapper shape — they
   * sign with the raw inner secret value. The receiver must therefore
   * unwrap before calling the verifier.
   *
   * Implementations should:
   *   - JSON.parse `plaintext.toString("utf8")`.
   *   - Read the schema-defined inner field
   *     (`x_hook_secret` for Asana, `signing_secret` for
   *     Fireflies / generic webhook).
   *   - Return `Buffer.from(value, "utf8")`.
   *   - Throw a clean error if the JSON is malformed or the field
   *     is missing — that's a credential-write-side bug worth
   *     surfacing rather than a silent HMAC mismatch.
   *
   * Optional from PR-Q7: when omitted, the receiver passes the raw
   * plaintext bytes to the verifier (the pre-Q7 contract). Adapters
   * whose admin-API write-path stores a JSON-wrapped secret MUST
   * set this; bare-bytes adapters (or test stubs) can leave it
   * undefined.
   */
  extractWebhookSecret?(plaintext: Buffer): Buffer;
  /**
   * Symmetric to `extractWebhookSecret`: wrap a raw secret string
   * (e.g. the value Asana ships in `X-Hook-Secret` on the
   * registration handshake) into the same JSON-on-disk shape the
   * admin-API write path produces, so a subsequent signed delivery
   * can `extractWebhookSecret(...)` it cleanly.
   *
   * For source-asana the implementation is:
   *
   *   `Buffer.from(JSON.stringify({x_hook_secret: rawSecret}), "utf8")`
   *
   * Optional from PR-Q7: when omitted, the receiver persists the
   * handshake secret as raw UTF-8 bytes (the pre-Q7 contract).
   * Adapters that implement `extractWebhookSecret` MUST also
   * implement `wrapWebhookSecret` so handshake-acquired bindings
   * round-trip through the same shape — otherwise the next signed
   * delivery would route through `extractWebhookSecret` against a
   * raw-bytes blob and 500 + DLQ with `credential_unwrap_failed`.
   */
  wrapWebhookSecret?(rawSecret: string): Buffer;
  /** Unpack a verified body into one or more events. Adapter
   *  is responsible for shape-validating the body — a
   *  malformed body throws ValidationError. */
  parseEvents(args: {
    readonly body: Buffer;
    readonly fetchedAt?: Date;
  }): readonly SourceWebhookEvent[];
  /**
   * Optional per-adapter registration handshake detector.
   * The receiver calls this BEFORE signature verification.
   * If the adapter returns a HandshakeResult, the receiver:
   *   1. Persists the secret to CredentialStore.
   *   2. UPDATEs sources_bindings.webhook_secret_credentials_id.
   *   3. Echoes the secret in the response header.
   *   4. Returns 200 without enqueueing anything.
   *
   * Asana uses `X-Hook-Secret` on the first POST; adapters
   * that don't have a handshake protocol leave this undefined.
   *
   * Headers may carry `string | string[] | undefined` (Fastify
   * multi-value header shape). */
  handshakeFn?(headers: Readonly<Record<string, string | string[] | undefined>>):
    | HandshakeResult
    | null;
  /**
   * Optional post-parse enrichment hook. Called AFTER `recordWebhook`
   * (dedupe + signature verification) and BEFORE intake enqueueing in the
   * webhook receiver. The adapter may return an augmented array (e.g.
   * appending a fresh snapshot SourceEvent after each raw event). When
   * undefined, behavior is identical to the pre-PR-G receiver —
   * backward-compat, no changes required in other adapters.
   *
   * Fix #4 (Copilot triage): order clarification — the previous comment
   * incorrectly stated "BEFORE recordWebhook". The actual receiver order
   * is:
   *   1. handshakeFn (optional, early-exit)
   *   2. verifier.verify (signature check)
   *   3. parseEvents (body → SourceWebhookEvents)
   *   4. recordWebhook / dedupe (first-delivery gate)
   *   5. enrichEvents ← HERE (only runs on first valid delivery)
   *   6. intake enqueue
   *
   * This ordering is by design: enrichment side-effects (snapshot fetches,
   * LLM calls) MUST NOT re-run on Asana retries of already-recorded events.
   * Dedupe (step 4) gates them out before enrichment executes.
   *
   * PR-G wires this for source-asana when `snapshotMode='on-event'`:
   * the Asana adapter appends a second SourceEvent with
   * `content_kind: 'asana-project'` containing the full project snapshot.
   * TODO(PR-H): register 'asana-project' in the CONTENT_KINDS const.
   *
   * The returned array REPLACES the input — callers that add events should
   * spread the originals first: `[...events, ...additionalEvents]`.
   * Callers that only want to mutate metadata should return a new array
   * with updated SourceWebhookEvent objects (immutable shape).
   */
  enrichEvents?(events: readonly SourceWebhookEvent[]): Promise<readonly SourceWebhookEvent[]>;
}

export interface SourceAdapter {
  /** Stable identifier matching `sources_bindings.adapter_slug`.
   *  The Scanner pipeline picks the adapter for a binding by
   *  this slug. */
  readonly slug: string;
  /** Discover documents changed since `args.cursor`. Returns
   *  the new cursor for the engine to persist. */
  scan(args: SourceScanArgs): Promise<SourceScanResult>;
  /**
   * One-off bootstrap pull (PR-Z2, phase-a appendix #12 G2).
   * Called on binding-create (Z3 triggers the initial scan)
   * and on a manual "Scan now" against a cursor-less binding
   * to backfill existing source-side content that `scan()`
   * cannot see (Drive files / Asana tasks that exist BEFORE
   * the binding was created).
   *
   * Emissions flow through the SAME `ingestion_intake`
   * UNIQUE(binding_id, source_doc_id, source_revision) dedupe +
   * classify enqueue pipeline `scan()` uses — a seed followed
   * by a same-tick `scan()` does NOT re-emit the seeded docs.
   *
   * Optional: webhook-only adapters that don't need a
   * backfill (e.g. `fireflies` — meeting transcripts only
   * exist forward-in-time) can leave `seed` undefined. The
   * Scanner detects `seed === undefined` + a null cursor and
   * falls back to `scan()` on the first tick.
   */
  readonly seed?: (args: SourceSeedArgs) => Promise<SourceSeedResult>;
  /** Webhook-mode helpers — set only by webhook adapters
   *  (PR 24 Asana, PR 27 Fireflies). The contract suite
   *  asserts presence + behavior when `mode === 'webhook'`. */
  readonly webhook?: SourceWebhookHelpers;
}

// Re-exports for the binding-create flow (phase-a appendix #2).
// The Management UI + admin-API route both consume these
// schemas; keeping them in @opencoo/shared/source-adapter so
// the server validator and the UI form share a single source
// of truth (no schema drift).
export {
  SOURCE_ADAPTER_CREDENTIAL_SCHEMAS,
  getSourceAdapterDescriptor,
  type CredentialSchemaField,
  type PollingCredentialSchema,
  type SourceAdapterCredentialDescriptor,
  type SourceAdapterSlug,
  type WebhookCredentialSchema,
} from "./credential-schemas.js";

export {
  SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS,
  getSourceAdapterBindingConfigSchema,
  type BindingConfigField,
  type BindingConfigSchema,
} from "./binding-config-schemas.js";

export {
  TRANSCRIPTION_ADAPTER_SLUGS,
  defaultReviewModeFor,
  type DefaultReviewModeArgs,
  type DomainClass,
  type ReviewModeDefault,
} from "./review-mode-defaults.js";
