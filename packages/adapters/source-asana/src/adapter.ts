/**
 * Asana SourceAdapter — webhook mode (PR 24 / plan #115;
 * extended in PR-F: handshake + event_type derivation +
 * monitored-project filter + Light per-event summary).
 *
 * Asana sources events via webhooks (the PoC's pattern). The
 * adapter exposes:
 *   - `slug: 'asana'`
 *   - `scan()` — returns `{ documents: [], nextCursor: null }`.
 *     Webhook adapters do NOT scan; the receiver pushes events
 *     in. We satisfy the port shape so a degenerate Scanner
 *     run is a no-op.
 *   - `webhook.verifier` — HMAC-SHA256 over the raw body
 *     (Asana sends `X-Hook-Signature` as hex).
 *   - `webhook.extractSignature(headers)` — looks up
 *     `x-hook-signature` (case-insensitive).
 *   - `webhook.handshakeFn(headers)` — detects Asana's first-POST
 *     X-Hook-Secret registration handshake (PR-F).
 *   - `webhook.parseEvents({ body })` — unpacks the Asana
 *     webhook envelope `{ events: [...] }`. Each surviving event
 *     becomes one `SourceWebhookEvent` with:
 *       - stable `eventId` from (user, created_at, resource.gid, action)
 *       - `eventType` (derived via deriveEventType; null events are
 *         dropped before emitting)
 *       - monitored-project filter applied (events for unmonitored
 *         project GIDs are silently dropped)
 *       - optional `metadata.summary` (Light-tier LLM one-liner)
 *
 * # Architecture pin
 *
 * Per orchestrator override 5: HMAC verification stays in the
 * engine-ingestion receiver. This adapter EXPORTS the verifier;
 * it does NOT verify on its own (no req/res abstraction
 * dependency, keeps the package dependency-light). The
 * receiver's responsibilities:
 *   0. (PR-F) Check handshakeFn before signature verification.
 *   1. Resolve `webhookSecretCredentialId` → secret bytes.
 *   2. Call `verifier.verify({ body, secret, signature })`.
 *   3. On `ok:false`, throw `WebhookSignatureError(validation)`.
 *   4. On `ok:true`, call `parseEvents({ body })`.
 *   5. For each event, dedupe `eventId` against
 *      `webhook_events` UNIQUE (binding_id, event_id), then
 *      push into intake.
 */
import { createHash } from "node:crypto";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId, DomainId } from "@opencoo/shared/db";
import { ValidationError } from "@opencoo/shared/errors";
import type {
  HandshakeResult,
  SourceAdapter,
  SourceChangedDocument,
  SourceScanArgs,
  SourceScanResult,
  SourceWebhookEvent,
  SourceWebhookHelpers,
} from "@opencoo/shared/source-adapter";
import {
  HmacSha256Verifier,
  type WebhookVerifier,
} from "@opencoo/shared/webhook-verifier";

import {
  asanaBindingConfigSchema,
  type AsanaBindingConfig,
} from "./binding-config.js";
import { deriveEventType } from "./derive-event-type.js";
import type { AsanaClient, ProjectSnapshot } from "./asana-client.js";
import type { LightSummaryRouter } from "./light-summary.js";
import { summarizeAsanaEvent } from "./light-summary.js";

export const ASANA_ADAPTER_SLUG = "asana" as const;

/** Header Asana sends signatures on. Case-insensitive lookup
 *  via the helper below. */
export const ASANA_SIGNATURE_HEADER = "x-hook-signature";

/** Header Asana sends on the first POST (registration handshake).
 *  Its presence signals a handshake — the value is echoed back. */
export const ASANA_HOOK_SECRET_HEADER = "x-hook-secret";

export interface CreateAsanaSourceAdapterArgs {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  readonly config: AsanaBindingConfig | unknown;
  /**
   * Injected Asana REST client for snapshot fetches (PR-G).
   * Required when `config.snapshotMode` is 'on-event' or 'periodic'.
   * Throws at factory time when snapshotMode requires it but none provided
   * AND `makeAsanaClient` is also not provided (PR-Q8).
   */
  readonly asanaClient?: AsanaClient;
  /**
   * Lazy-constructed Asana REST client (PR-Q8).
   *
   * Production composition wires this instead of `asanaClient` so the
   * client construction (which decrypts the binding's PAT) happens at
   * the FIRST `enrichEvents` dispatch, not at engine boot. Boot-time
   * construction would force every binding's credentials to be readable
   * even when ingestion is paused / engine probes-only / etc.
   *
   * The factory invokes this exactly once per adapter lifetime and
   * caches the resulting client for subsequent dispatches. When both
   * `asanaClient` and `makeAsanaClient` are provided, `asanaClient`
   * wins (test path).
   */
  readonly makeAsanaClient?: () => AsanaClient;
  /**
   * LLM router for Light-tier per-event summaries (PR-G closes PR-F gap).
   * Required when `config.lightSummaryEnabled=true`; ignored otherwise.
   */
  readonly llmRouter?: LightSummaryRouter;
  /**
   * Domain ID for LLM tier routing (required when llmRouter provided).
   */
  readonly domainId?: DomainId;
}

/**
 * Options for `buildAsanaWebhookHelpers`. Allows injection of
 * the config-driven knobs (monitoredProjectGids, lightSummaryEnabled)
 * without exposing the full AsanaBindingConfig shape in tests.
 */
export interface BuildAsanaWebhookHelpersOptions {
  readonly monitoredProjectGids?: readonly string[];
  readonly lightSummaryEnabled?: boolean;
  /** Snapshot mode — controls whether enrichEvents is wired (PR-G). */
  readonly snapshotMode?: "on-event" | "periodic" | "off";
  /** Primary project GID for the binding (fallback in enrichEvents). */
  readonly projectGid?: string;
  /** Injected Asana client for snapshot fetches (PR-G). */
  readonly asanaClient?: AsanaClient;
  /** Lazy Asana client constructor (PR-Q8). When provided and
   *  `asanaClient` is undefined, the helper invokes this on the
   *  FIRST enrichEvents dispatch and caches the result for the
   *  helper's lifetime. */
  readonly makeAsanaClient?: () => AsanaClient;
  /** LLM router for Light-tier summaries (PR-G closes PR-F gap). */
  readonly llmRouter?: LightSummaryRouter;
  /** Domain ID for LLM tier routing. */
  readonly domainId?: DomainId;
}

/**
 * Internal Asana webhook event shape — derived from the
 * payload Asana POSTs. The PoC's docs describe the same
 * shape.
 */
interface RawAsanaEvent {
  /** ISO timestamp; combined into the synthetic eventId. */
  readonly created_at?: string;
  /** Actor user gid; combined into the synthetic eventId. */
  readonly user?: { readonly gid?: string };
  /** Resource the event is about (task, project, etc.). */
  readonly resource?: {
    readonly gid?: string;
    readonly resource_type?: string;
  };
  /** Parent of the resource (e.g. the task a story belongs to). */
  readonly parent?: {
    readonly gid?: string;
    readonly resource_type?: string;
  };
  readonly action?: string;
  readonly change?: { readonly field?: string };
}

interface RawAsanaWebhookBody {
  readonly events?: ReadonlyArray<RawAsanaEvent>;
}

/**
 * Case-insensitive header lookup. Header names in `headers` may be
 * lower-cased (Fastify normalises) or original-case (raw injection in
 * tests); we don't want to depend on that.
 *
 * HTTP headers can be `string | string[] | undefined` (Fastify preserves
 * multi-value headers as arrays). For Asana's single-value signature
 * headers we take the last value when an array is present — this is safe
 * because Asana never sends these headers more than once per request.
 */
function findHeaderValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  headerName: string,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== headerName) continue;
    if (typeof v === "string") return v;
    // Array case: take the last value (defensive; Asana is always single).
    if (Array.isArray(v) && v.length > 0) return v[v.length - 1];
  }
  return undefined;
}

export function extractAsanaSignature(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  return findHeaderValue(headers, ASANA_SIGNATURE_HEADER);
}

/**
 * (PR-Q7) Unwrap the inner `x_hook_secret` from the credential
 * plaintext bytes the admin-API source-bindings write path stored.
 *
 * The admin-API encrypts `JSON.stringify(webhookCreds.webhook_secret)`,
 * which for Asana is the full `webhook_secret` shape declared in
 * `SOURCE_ADAPTER_CREDENTIAL_SCHEMAS.asana.credentialSchema.properties.webhook_secret`:
 *   `{"x_hook_secret":"<the-actual-hmac-secret>"}`.
 *
 * Real Asana upstreams sign the request body with the raw
 * `x_hook_secret` value — never with the wrapped JSON shape — so the
 * receiver MUST unwrap before calling the HMAC verifier. Pre-Q7 the
 * receiver passed the wrapped bytes through, which produced the
 * "signature mismatch" 401 reported in this branch.
 *
 * Throws on malformed JSON or a missing inner field — both indicate a
 * credential-write-side bug worth surfacing to the operator (the
 * receiver routes the throw to a 500 + DLQ entry rather than a quiet
 * 401, so the bad credential gets noticed).
 */
export function extractAsanaWebhookSecret(plaintext: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch (err) {
    throw new Error(
      `source-asana: webhook credential plaintext is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      // ES2022 cause-chain — engine-ingestion's safeErrorMessage
      // walks the cause when scrubbing; preserving the original
      // helps an operator find the credential write that produced
      // it without leaking secret bytes (the JSON parse error
      // message itself never includes the parsed bytes).
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "source-asana: webhook credential plaintext must be a JSON object with an x_hook_secret field",
    );
  }
  const inner = (parsed as Record<string, unknown>)["x_hook_secret"];
  if (typeof inner !== "string" || inner.length === 0) {
    throw new Error(
      "source-asana: webhook credential is missing the x_hook_secret field (or it is not a non-empty string) — check the binding's webhook_secret credential write",
    );
  }
  return Buffer.from(inner, "utf8");
}

/**
 * Wrap a raw Asana `X-Hook-Secret` value (the bytes Asana ships
 * during the registration handshake) into the same JSON-on-disk
 * shape the admin-API write path produces, so a subsequent signed
 * delivery can `extractAsanaWebhookSecret(...)` it cleanly.
 *
 * Symmetric pair to `extractAsanaWebhookSecret` — together they
 * close the round-trip for handshake-acquired bindings (PR-Q7
 * round-2, Copilot triage).
 */
export function wrapAsanaWebhookSecret(rawSecret: string): Buffer {
  return Buffer.from(JSON.stringify({ x_hook_secret: rawSecret }), "utf8");
}

/**
 * Detect Asana's registration handshake. Returns the secret to echo,
 * or null if this is a normal event delivery.
 */
function detectAsanaHandshake(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): HandshakeResult | null {
  const secret = findHeaderValue(headers, ASANA_HOOK_SECRET_HEADER);
  if (secret === undefined || secret.length === 0) return null;
  return {
    secret,
    schemaRef: "source-asana:webhook_secret",
  };
}

/**
 * Build a deterministic event id from `(user, created_at,
 * resource.gid, action)`. Asana doesn't ship a per-event gid,
 * but the combination above is stable across replays.
 */
function deriveEventId(event: RawAsanaEvent): string {
  const parts = [
    event.user?.gid ?? "",
    event.created_at ?? "",
    event.resource?.gid ?? "",
    event.action ?? "",
    event.change?.field ?? "",
  ].join("|");
  return createHash("sha256").update(parts).digest("hex").slice(0, 32);
}

/**
 * Extract the project GID from an event. Returns undefined when no
 * project is derivable.
 *
 * Asana's convention:
 *   - For task events: parent.resource_type === 'project' → parent.gid
 *   - For project events: resource.resource_type === 'project' → resource.gid
 */
function extractProjectGid(event: RawAsanaEvent): string | undefined {
  if (
    event.parent?.resource_type === "project" &&
    typeof event.parent.gid === "string"
  ) {
    return event.parent.gid;
  }
  if (
    event.resource?.resource_type === "project" &&
    typeof event.resource.gid === "string"
  ) {
    return event.resource.gid;
  }
  return undefined;
}

function parseAsanaWebhookBody(body: Buffer): RawAsanaWebhookBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (err) {
    // ValidationError so the receiver classifies as
    // errorClass='validation' (THREAT-MODEL §3.1) — body-shape
    // failures are not retried.
    throw new ValidationError(
      `asana webhook: body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ValidationError("asana webhook: body root must be a JSON object");
  }
  // Coerce shape-checked but not strictly typed.
  return parsed as RawAsanaWebhookBody;
}

export function buildSnapshotEvent(
  snapshot: ProjectSnapshot,
  fetchedAt: Date,
): SourceWebhookEvent {
  // TODO(PR-H): register 'asana-project' in CONTENT_KINDS const.
  const contentBytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  // Fix #3 (Copilot triage): apply the same 1 MiB ceiling as parseEvents.
  // A snapshot exceeding 1 MiB likely indicates misconfigured optFields or a
  // runaway project — fail closed so the operator gets a visible error rather
  // than silently overflowing the Compilation Worker prompt budget.
  // The throw bubbles to enrichEvents' try/catch (PR-G), which logs + skips
  // the snapshot event while preserving the raw event — effectively fail-open
  // at the receiver level while maintaining the contract at this boundary.
  if (contentBytes.length > 1024 * 1024) {
    throw new ValidationError(
      `asana snapshot exceeds 1 MiB ceiling (got ${contentBytes.length} bytes)`,
    );
  }
  // Stable sourceDocId: identifies the project's snapshot stream.
  // sourceRevision: fetched_at ISO timestamp (each fetch = new revision).
  const sourceDocId = `asana-project-snapshot:${snapshot.project_gid}`;
  const sourceRevision = snapshot.fetched_at;
  return {
    // eventId: hash of project_gid + fetched_at for dedup
    eventId: `snapshot:${snapshot.project_gid}:${snapshot.fetched_at}`,
    doc: {
      sourceDocId,
      sourceRevision,
      sourceRef: `asana:project/${snapshot.project_gid}`,
      fetchedAt,
      contentBytes,
    },
  };
}

export function buildAsanaWebhookHelpers(
  opts: BuildAsanaWebhookHelpersOptions = {},
): SourceWebhookHelpers {
  const verifier: WebhookVerifier = new HmacSha256Verifier();
  const monitoredSet =
    opts.monitoredProjectGids !== undefined && opts.monitoredProjectGids.length > 0
      ? new Set(opts.monitoredProjectGids)
      : undefined;

  const snapshotMode = opts.snapshotMode ?? "on-event";

  /**
   * Lazily resolve the Asana client for this helper's lifetime (PR-Q8).
   *
   * Resolution order:
   *   1. `opts.asanaClient` if provided — used as-is, no `make`
   *      invocation. Test path + caller-injected client.
   *   2. `opts.makeAsanaClient` if provided — invoked exactly once on
   *      first call; the result is memoised in `cachedClient`.
   *   3. Neither set — returns undefined (snapshot fetch is skipped
   *      silently; matches the pre-PR-Q8 enrichEvents semantics when
   *      asanaClient was not wired).
   */
  let cachedClient: AsanaClient | undefined = opts.asanaClient;
  let factoryInvoked = opts.asanaClient !== undefined;
  function resolveAsanaClient(): AsanaClient | undefined {
    if (cachedClient !== undefined) return cachedClient;
    if (factoryInvoked) return undefined;
    if (opts.makeAsanaClient !== undefined) {
      // Fail-open: if `makeAsanaClient` throws (miswired
      // composition, malformed PAT JSON, transient SDK boot error)
      // we MUST NOT propagate the throw out of `enrichEvents` —
      // the receiver's webhook hot-path treats enrich failures as
      // "skip enrichment, continue with the bare event," not "kill
      // the entire delivery." Mark the factory as invoked so the
      // next dispatch doesn't retry the same broken closure
      // (caching a `null` result), and log via the supplied logger
      // so the operator still sees the misconfig. Copilot triage
      // on PR-Q8.
      factoryInvoked = true;
      try {
        cachedClient = opts.makeAsanaClient();
      } catch (err) {
        cachedClient = undefined;
        // Mirror the existing soft-fail pattern in this file
        // (line 401 / 470 / 670 — `console.warn` for snapshot-fetch
        // failures). The receiver's webhook hot-path treats enrich
        // failures as "skip enrichment, continue with the bare
        // event," not "kill the entire delivery."
        console.warn("source-asana: makeAsanaClient threw; enrich will skip", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return cachedClient;
    }
    return undefined;
  }

  /**
   * Build the enrichEvents function when snapshotMode='on-event' (PR-G).
   *
   * For each parsed event:
   *   1. If lightSummaryEnabled=true AND llmRouter+domainId provided,
   *      call summarizeAsanaEvent and attach metadata.summary.
   *      (Closes the TODO from PR-F — the sync/async contract gap is
   *      resolved here, not in parseEvents.)
   *   2. Fetch a project snapshot via AsanaClient and emit a second
   *      SourceEvent with content_kind='asana-project'.
   *      TODO(PR-H): register 'asana-project' in CONTENT_KINDS const.
   */
  async function enrichEventsImpl(
    events: readonly SourceWebhookEvent[],
  ): Promise<readonly SourceWebhookEvent[]> {
    const result: SourceWebhookEvent[] = [];

    for (const event of events) {
      let enrichedEvent = event;

      // Step 1: Light-summary wiring (PR-G closes PR-F TODO).
      // Only when lightSummaryEnabled + llmRouter + domainId are all provided.
      if (
        opts.lightSummaryEnabled === true &&
        opts.llmRouter !== undefined &&
        opts.domainId !== undefined
      ) {
        // I3: wrap JSON.parse in try/catch — a hand-built SourceWebhookEvent
        // from a future code path could carry malformed bytes. On failure we
        // skip summarization but still push the raw event + attempt snapshot.
        let parsedEventBody: unknown;
        let parsedOk = true;
        try {
          parsedEventBody = JSON.parse(event.doc.contentBytes.toString("utf8"));
        } catch (parseErr) {
          parsedOk = false;
          console.warn("source-asana: enrichEvents JSON parse failed for event", {
            sourceDocId: event.doc.sourceDocId,
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
        }

        if (parsedOk && parsedEventBody !== undefined) {
          const summary = await summarizeAsanaEvent({
            event: parsedEventBody,
            domainId: opts.domainId,
            llmRouter: opts.llmRouter,
            pipeline: "source-asana:enrich",
            ...(event.doc.sourceDocId !== undefined
              ? { documentId: event.doc.sourceDocId }
              : {}),
          });
          if (summary !== undefined) {
            // Attach summary to a new event object (immutable shape).
            enrichedEvent = {
              ...event,
              doc: {
                ...event.doc,
                metadata: {
                  ...event.doc.metadata,
                  summary,
                },
              },
            };
          }
        }
      }

      result.push(enrichedEvent);

      // Step 2: Snapshot fetch (on-event mode only).
      // I1: wrap fetchProjectSnapshot in try/catch — fail-open semantics
      // mirror light-summary.ts:84-97. A transient 5xx must NOT propagate
      // up to the receiver: that would cause Asana to retry, and on retry
      // recordWebhook deduplication would prevent scanner re-enqueue,
      // silently losing the snapshot. Log a structured warning and continue.
      //
      // PR-Q8: resolve the client lazily — production composition wires
      // `makeAsanaClient` rather than `asanaClient` so the credential
      // decrypt only happens when the first event arrives.
      const asanaClient = resolveAsanaClient();
      if (asanaClient !== undefined) {
        // Determine project GID from the *original* event's metadata.projectGid
        // (preserved by the spread above; reading from `event` rather than
        // `enrichedEvent` removes the dependency on key-preservation across
        // future spread changes — M6).
        const eventProjectGid =
          typeof event.doc.metadata?.["projectGid"] === "string"
            ? event.doc.metadata["projectGid"]
            : opts.projectGid;

        if (eventProjectGid !== undefined) {
          try {
            const snapshot = await asanaClient.fetchProjectSnapshot(eventProjectGid);
            // M7: use new Date() for fetchedAt — the snapshot was fetched *now*,
            // not at the original event's arrival time. The snapshot's internal
            // fetched_at field is already correct; this fixes the outer
            // SourceChangedDocument-level field for audit truthfulness.
            const snapshotEvent = buildSnapshotEvent(snapshot, new Date());
            result.push(snapshotEvent);
          } catch (snapshotErr) {
            // Fail-open: log safe metadata only (THREAT-MODEL §3.6 invariant 11:
            // the error from AsanaClient is already scrubbed via scrubError, but
            // we add another layer of defense — never log opts.asanaClient or
            // any raw credential bytes here).
            console.warn("source-asana: enrichEvents snapshot fetch failed", {
              projectGid: eventProjectGid,
              sourceDocId: event.doc.sourceDocId,
              errorClass:
                snapshotErr instanceof Error
                  ? snapshotErr.constructor.name
                  : typeof snapshotErr,
              error:
                snapshotErr instanceof Error
                  ? snapshotErr.message
                  : String(snapshotErr),
            });
            // Raw event is already pushed above; snapshot event is skipped.
            // Continue iterating remaining events in the batch.
          }
        }
      }
    }

    return result;
  }

  function parseEventsFn({ body, fetchedAt }: { body: Buffer; fetchedAt?: Date }): readonly SourceWebhookEvent[] {
    const parsed = parseAsanaWebhookBody(body);
    const events = parsed.events ?? [];
    const at = fetchedAt ?? new Date();
    const out: SourceWebhookEvent[] = [];

    for (const ev of events) {
      // Validate required fields BEFORE deriving an eventId —
      // empty resource.gid + empty action would still hash to
      // a stable id, but the resulting sourceDocId would be
      // ambiguous and intake-dedupe would conflate distinct
      // events. Fail closed with errorClass='validation'.
      const resourceGid = ev.resource?.gid;
      const resourceType = ev.resource?.resource_type;
      const action = ev.action;
      if (
        typeof resourceGid !== "string" ||
        resourceGid.length === 0 ||
        typeof resourceType !== "string" ||
        resourceType.length === 0 ||
        typeof action !== "string" ||
        action.length === 0
      ) {
        throw new ValidationError(
          "asana webhook: event missing required fields (resource.gid, resource.resource_type, action)",
        );
      }

      // Step 1 (PR-F): derive semantic event type; drop noise events.
      const eventType = deriveEventType(ev);
      if (eventType === null) {
        // Silently drop — deletions, removals, non-comment stories,
        // task_added_to_project, and uninteresting field changes.
        continue;
      }

      // Step 2 (PR-F): monitored-project filter.
      // When monitoredProjectGids is configured, only emit events
      // whose project GID appears in the allowlist.
      const projectGid = extractProjectGid(ev);
      if (monitoredSet !== undefined) {
        if (projectGid === undefined || !monitoredSet.has(projectGid)) {
          // Silently drop — no error, no recordWebhook.
          continue;
        }
      }

      const eventId = deriveEventId(ev);
      const sourceDocId = `${resourceGid}:${action}`;
      const contentBytes = Buffer.from(JSON.stringify(ev), "utf8");
      // 1 MiB ceiling mirrors the SourceAdapter contract; an
      // event that serializes larger fails closed rather than
      // overflowing the Compilation Worker prompt budget.
      if (contentBytes.length > 1024 * 1024) {
        throw new ValidationError(
          `asana webhook: event exceeds 1 MiB ceiling (got ${contentBytes.length} bytes)`,
        );
      }

      // Light-summary wiring is now in enrichEvents (PR-G).
      // parseEvents stays sync; the async LLM call is done post-parse.

      // exactOptionalPropertyTypes: omit the metadata key entirely when
      // projectGid is undefined, rather than setting it to undefined.
      const docBase = {
        sourceDocId,
        sourceRevision: eventId, // every event = new revision
        sourceRef: `asana:${resourceType}/${resourceGid}`,
        fetchedAt: at,
        // Inline the event JSON as bytes so the
        // Compilation Worker has the full event verbatim.
        contentBytes,
      };
      out.push({
        eventId,
        eventType,
        doc: projectGid !== undefined
          ? { ...docBase, metadata: { projectGid } }
          : docBase,
      });
    }
    return out;
  }

  // enrichEvents is attached only when snapshotMode='on-event' (PR-G).
  // 'periodic' uses scan(); 'off' skips snapshots entirely.
  // exactOptionalPropertyTypes: omit the key when it shouldn't be set.
  return {
    verifier,
    extractSignature: extractAsanaSignature,
    extractWebhookSecret: extractAsanaWebhookSecret,
    wrapWebhookSecret: wrapAsanaWebhookSecret,
    handshakeFn: detectAsanaHandshake,
    parseEvents: parseEventsFn,
    ...(snapshotMode === "on-event" ? { enrichEvents: enrichEventsImpl } : {}),
  };
}

export function createAsanaSourceAdapter(
  args: CreateAsanaSourceAdapterArgs,
): SourceAdapter {
  // Validate the config at factory time — fail loud here.
  const config = asanaBindingConfigSchema.parse(args.config);
  // credentialStore + credentialId are part of the factory shape
  // (THREAT-MODEL §3.6 invariant 11) but unused by webhook-mode
  // adapters: the engine-ingestion receiver resolves the actual
  // webhook secret via `config.webhookSecretCredentialId` at
  // verify-time, not through these args.
  void args.credentialStore;
  void args.credentialId;

  // Guard: snapshotMode='periodic' or 'on-event' requires an AsanaClient.
  // Throw at factory time so operators see the config error immediately
  // rather than discovering a silent no-op at runtime.
  //
  // 'periodic': scan() must fetch snapshots eagerly — needs a ready
  //   `asanaClient` at factory time. `makeAsanaClient` is NOT enough
  //   because scan() runs deterministically on cron and the orchestrator
  //   hasn't pre-resolved the credential.
  // 'on-event': enrichEvents emits snapshot events. Either an explicit
  //   `asanaClient` OR a lazy `makeAsanaClient` factory satisfies the
  //   requirement (PR-Q8) — the helper resolves the client on the first
  //   dispatch.
  if (config.snapshotMode === "periodic" && args.asanaClient === undefined) {
    throw new Error(
      `source-asana: snapshotMode='periodic' requires an AsanaClient to be provided`,
    );
  }
  // Fix #1 (Copilot triage): guard on-event mode the same way.
  // PR-Q8: a lazy `makeAsanaClient` factory also satisfies the guard.
  if (
    config.snapshotMode === "on-event" &&
    args.asanaClient === undefined &&
    args.makeAsanaClient === undefined
  ) {
    throw new Error(
      `source-asana: snapshotMode='on-event' requires asanaClient or makeAsanaClient injection`,
    );
  }

  /**
   * scan() implementation for snapshotMode='periodic' (PR-G).
   *
   * Fetches snapshots for all monitoredProjectGids (or the primary
   * projectGid if monitoredProjectGids is not configured). Returns
   * one SourceChangedDocument per project.
   *
   * For snapshotMode='on-event' or 'off', returns empty (no-op).
   */
  async function scan(_args: SourceScanArgs): Promise<SourceScanResult> {
    void _args;

    if (config.snapshotMode !== "periodic") {
      // Webhook adapters that use on-event or off modes don't scan.
      return { documents: [], nextCursor: null };
    }

    // Periodic scan: fetch snapshots for all monitored projects.
    const projectGids =
      config.monitoredProjectGids !== undefined && config.monitoredProjectGids.length > 0
        ? config.monitoredProjectGids
        : [config.projectGid];

    // M5: hoist asanaClient to a local const — the factory guard above already
    // ensures it is defined for snapshotMode='periodic', eliminating the need
    // for the non-null assertion (!) at call-site.
    const asanaClient = args.asanaClient!;

    const documents: SourceChangedDocument[] = [];
    const now = new Date();

    // I4: per-project try/catch — a failure on one project must not abort the
    // remaining batch. We log a structured warning and continue so that the
    // next scan cycle for the failed project will retry naturally.
    for (const projectGid of projectGids) {
      try {
        const snapshot = await asanaClient.fetchProjectSnapshot(projectGid);
        const snapshotEvent = buildSnapshotEvent(snapshot, now);
        documents.push(snapshotEvent.doc);
      } catch (err) {
        console.warn("source-asana: scan() snapshot fetch failed for project", {
          projectGid,
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue to next project — partial results are better than none.
      }
    }

    return { documents, nextCursor: null };
  }

  // Fix #2 (Copilot triage): resolve the AsanaClient that enrichEvents and
  // scan() will use. When the caller injects a pre-built asanaClient the
  // injected instance is used as-is (the injected client owns its own
  // optFields choice — this is intentional and documented here so future
  // readers don't wonder why config.optFields is "ignored"). When no
  // client is injected the factory guards above have already thrown for
  // 'on-event' and 'periodic' modes; for 'off' mode no client is needed.
  //
  // NOTE: if a future code path adds a factory-created AsanaClient (e.g.
  // createAsanaClient({ ..., optFields: config.optFields })) it should
  // pass config.optFields so that binding-level optFields configuration
  // is respected end-to-end. For now the injected client pattern is the
  // only wiring path and the comment above covers the contract.

  return {
    slug: ASANA_ADAPTER_SLUG,
    scan,
    webhook: buildAsanaWebhookHelpers({
      // exactOptionalPropertyTypes: omit key when undefined.
      ...(config.monitoredProjectGids !== undefined
        ? { monitoredProjectGids: config.monitoredProjectGids }
        : {}),
      lightSummaryEnabled: config.lightSummaryEnabled,
      snapshotMode: config.snapshotMode,
      projectGid: config.projectGid,
      ...(args.asanaClient !== undefined ? { asanaClient: args.asanaClient } : {}),
      ...(args.makeAsanaClient !== undefined
        ? { makeAsanaClient: args.makeAsanaClient }
        : {}),
      ...(args.llmRouter !== undefined ? { llmRouter: args.llmRouter } : {}),
      ...(args.domainId !== undefined ? { domainId: args.domainId } : {}),
    }),
  };
}
