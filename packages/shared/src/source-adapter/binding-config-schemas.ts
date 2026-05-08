/**
 * Binding-config schema registry for the five wired SourceAdapters
 * (architecture.md §13 — UI dynamic form rendering, §10 adapter
 * boundaries; PR-Q9 of phase-a appendix #9).
 *
 * Sister registry to `credential-schemas.ts`. Each adapter exposes
 * a JSON-Schema-shaped descriptor that:
 *   - the Management UI's "+ New binding" wizard renders into a
 *     third step ("operational settings") — separate from the
 *     credentials step because these fields are NOT secret;
 *   - the `POST /api/admin/source-bindings` route validates the
 *     submitted `config` object against BEFORE the binding row is
 *     INSERTed, so a misconfigured binding fails at creation time
 *     (422) rather than at the first webhook delivery (500 →
 *     `factory_threw`).
 *
 * Zod is the actual source of truth — each adapter's
 * `<adapter>BindingConfigSchema` lives in
 * `packages/adapters/source-<adapter>/src/binding-config.ts`.
 * The JSON Schemas here are hand-authored to mirror those Zod
 * schemas; a drift-prevention test in each adapter package
 * asserts the required-set matches.
 *
 * Hand-authored (not Zod-derived) because:
 *   - the UI imports the descriptors via the engine's
 *     `GET /api/admin/adapters` response and never sees Zod;
 *   - `engine-self-operating` does not depend on the adapter
 *     packages (composition-only at boot), so wiring the Zod
 *     schemas through would either invert the dep graph or
 *     require a Zod-to-JSON-Schema converter package;
 *   - the JSON-Schema shape we surface is intentionally narrower
 *     than full Zod (string/number/boolean/array-of-string +
 *     enums + defaults). Anything richer collapses to UI-only
 *     concerns the form doesn't render.
 */
import type { SourceAdapterSlug } from "./credential-schemas.js";

/** A single field on a binding-config descriptor. Mirrors the
 *  shape `CredentialSchemaField` exposes for credentials, with
 *  the addition of `enum` / `default` / array-item description.
 *  Deliberately narrower than full JSON Schema — the UI renders
 *  text, password, select, and array-of-string inputs only. */
export interface BindingConfigField {
  readonly type: "string" | "number" | "boolean" | "array";
  readonly description?: string;
  /** Allowed values when this field renders as a select dropdown. */
  readonly enum?: readonly string[];
  /** Default the UI prefills when the operator opens the form.
   *  Mirrors the `.default()` on the Zod schema. */
  readonly default?: string | number | boolean | readonly string[];
  /** When `type === 'array'`, the schema for each item. The UI
   *  only supports `array-of-string` in v0.1, so this is always
   *  `{ type: "string" }` here. */
  readonly items?: { readonly type: "string" };
  /** Min length for string fields. The server uses this to
   *  reject empty values that Zod's `.string().min(1)` would
   *  otherwise catch. NOTE: the v0.1 server does NOT honour
   *  `minLength` for array fields — array-required gating relies
   *  on the array being non-empty + present in `required[]`.
   *  Adapter authors who want array-min-N enforcement should
   *  surface that via the Zod schema's `.array(...).min(N)` and
   *  rely on the persisted-config Zod parse at scan-time. */
  readonly minLength?: number;
  /** When true, the UI hides the field (still surfaced in JSON
   *  Schema for completeness — used for fields the adapter
   *  back-fills automatically, e.g. webhookSecretCredentialId
   *  on Asana). The server is also lenient on hidden fields:
   *  they are accepted but never required. */
  readonly hidden?: boolean;
}

export interface BindingConfigSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, BindingConfigField>>;
  readonly required: readonly string[];
}

const driveBindingConfig: BindingConfigSchema = {
  type: "object",
  properties: {
    folderId: {
      type: "string",
      description: "Drive folder id the adapter scans recursively.",
      minLength: 1,
    },
    mimeTypes: {
      type: "array",
      description:
        "Mime-type whitelist. Defaults to {google-doc, pdf}; extend as your converters land.",
      items: { type: "string" },
      default: [
        "application/vnd.google-apps.document",
        "application/pdf",
      ],
    },
    contentKind: {
      type: "string",
      description:
        "Content kind for downstream routing. v0.1 default: 'document'.",
      enum: [
        "document",
        "n8n-workflow",
        "asana-project",
        "skill-bundle",
        "webhook-event",
      ],
      default: "document",
    },
  },
  required: ["folderId"],
};

const asanaBindingConfig: BindingConfigSchema = {
  type: "object",
  properties: {
    projectGid: {
      type: "string",
      description: "Asana project gid the adapter watches.",
      minLength: 1,
    },
    workspaceGid: {
      type: "string",
      description:
        "Optional workspace gid for cross-checks. Carried on the binding for symmetric audit.",
    },
    webhookSecretCredentialId: {
      type: "string",
      description:
        "Set automatically by Asana's X-Hook-Secret handshake on first delivery; operators normally leave blank.",
      hidden: true,
    },
    reviewMode: {
      type: "string",
      description:
        "Operator review gating. 'auto' ingests every event; 'review' lands events in the Review Dashboard.",
      enum: ["auto", "review"],
      default: "auto",
    },
    monitoredProjectGids: {
      type: "array",
      description:
        "Optional allowlist of Asana project gids; events outside the list are dropped before intake. Leave empty to accept all projects.",
      items: { type: "string" },
    },
    lightSummaryEnabled: {
      type: "boolean",
      description:
        "When true, each event gets a Light-tier LLM call producing a one-liner summary on the SourceEvent metadata.",
      default: false,
    },
    snapshotMode: {
      type: "string",
      description:
        "Snapshot acquisition mode. 'on-event' fetches a fresh project snapshot per qualifying event; 'periodic' ties snapshots to the Scanner; 'off' disables snapshots.",
      enum: ["on-event", "periodic", "off"],
      default: "on-event",
    },
    optFields: {
      type: "array",
      description:
        "Per-task fields the adapter requests. Defaults to the PoC's six fields; extend to surface custom fields.",
      items: { type: "string" },
      default: [
        "name",
        "assignee.name",
        "completed",
        "due_on",
        "modified_at",
        "memberships.section.name",
      ],
    },
  },
  required: ["projectGid"],
};

const n8nBindingConfig: BindingConfigSchema = {
  type: "object",
  properties: {
    baseUrl: {
      type: "string",
      description: "Base URL of the n8n instance, e.g. https://n8n.example.com.",
      minLength: 1,
    },
    tagFilter: {
      type: "array",
      description:
        "Workflow tag whitelist. Defaults to ['catalog']; extend to monitor additional tag-classes.",
      items: { type: "string" },
      default: ["catalog"],
    },
    contentKind: {
      type: "string",
      description:
        "Content kind for downstream routing. n8n bindings default to 'n8n-workflow' for the catalog path.",
      enum: [
        "document",
        "n8n-workflow",
        "asana-project",
        "skill-bundle",
        "webhook-event",
      ],
      default: "n8n-workflow",
    },
  },
  required: ["baseUrl"],
};

const firefliesBindingConfig: BindingConfigSchema = {
  type: "object",
  properties: {
    webhookSecretCredentialId: {
      type: "string",
      description:
        "Reference to the webhook signing secret in the credential store. Operators normally leave blank — the binding wizard wires this from the credentials step.",
      hidden: true,
    },
    reviewMode: {
      type: "string",
      description:
        "Operator review gating. Defaults to 'approve' because transcripts often carry unredacted PII.",
      enum: ["auto", "approve", "review"],
      default: "approve",
    },
    meetingTitleAllowlist: {
      type: "array",
      description:
        "Case-insensitive substring allowlist for meeting titles. Empty = ingest all meetings.",
      items: { type: "string" },
      default: [],
    },
  },
  required: [],
};

const webhookBindingConfig: BindingConfigSchema = {
  type: "object",
  properties: {
    pathSegment: {
      type: "string",
      description:
        "Human-readable URL segment label for this binding. The actual receiver URL is /webhooks/<binding_id>; pathSegment is metadata only.",
      minLength: 1,
    },
    eventIdField: {
      type: "string",
      description:
        "Jsonpath expression that extracts the event_id from the payload, e.g. '$.event.id'. Used for replay dedupe.",
      minLength: 1,
    },
    defaultContentKind: {
      type: "string",
      description:
        "Fallback content_kind when no contentKindMap entry matches. Defaults to 'document'.",
      enum: [
        "document",
        "n8n-workflow",
        "asana-project",
        "skill-bundle",
        "webhook-event",
      ],
      default: "document",
    },
    reviewMode: {
      type: "string",
      description:
        "Operator review gating. Defaults to 'review' — untrusted webhook senders land in the Review Dashboard until you set 'auto'.",
      enum: ["auto", "review"],
      default: "review",
    },
  },
  required: ["pathSegment", "eventIdField"],
};

export const SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS: Readonly<
  Record<SourceAdapterSlug, BindingConfigSchema>
> = {
  drive: driveBindingConfig,
  asana: asanaBindingConfig,
  n8n: n8nBindingConfig,
  fireflies: firefliesBindingConfig,
  webhook: webhookBindingConfig,
};

export function getSourceAdapterBindingConfigSchema(
  slug: string,
): BindingConfigSchema | undefined {
  return (
    SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS as Record<
      string,
      BindingConfigSchema
    >
  )[slug];
}
