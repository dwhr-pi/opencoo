/**
 * Per-(agent, adapter) output payload transformers
 * (PR-W2, phase-a appendix #13 — closes G2).
 *
 * # Background
 *
 * PR-Z4 (phase-a appendix #12) wired the `OutputChannelRegistry`
 * with a single `mergeAsanaPayload` closure: every agent's
 * JSON output was rendered through `JSON.stringify(out, null, 2)`
 * and dropped into `notes`. That's a debug surface, not a
 * delivery surface — Asana doesn't render markdown so the
 * operator received an unreadable JSON blob in a task body.
 *
 * PR-W2 introduces a per-(agentSlug, adapterSlug) dispatch
 * table. Each entry returns the adapter's payload shape (e.g.
 * `AsanaTaskPayload`) constructed from the channel config + the
 * specific agent's output shape. Missing-pair fallback: the
 * generic adapter-only merger (the old behaviour) so unknown
 * agents still deliver, just without rich formatting.
 *
 * # Asana html_notes formatting (load-bearing)
 *
 * Asana accepts a restricted HTML subset under `html_notes`
 * (NOT markdown — that's the most common mistake here). The
 * rules:
 *   - Root MUST be `<body>` — Asana parses html_notes as XML.
 *   - Supported tags (empirically verified — Asana's html_notes
 *     parser is stricter than the public docs claim): `<body>`,
 *     `<h1>`, `<h2>`, `<strong>`, `<em>`, `<u>`, `<s>`, `<code>`,
 *     `<a>`, `<blockquote>`, `<pre>`, `<ol>`, `<ul>`, `<li>`,
 *     `<hr/>`, `<img/>` (self-closing — XML requires it),
 *     `<table>`, `<tr>`, `<td>`. **`<p>` and `<br/>` are NOT
 *     supported** — observed live on partner cutover
 *     (`xml_parsing_error: XML is invalid`).
 *   - Old supported-tag list (now corrected): `<body>`, `<h1>`, `<h2>`,
 *     `<ul>/<ol>/<li>`, `<a>`, `<b>/<strong>`, `<i>/<em>`,
 *     `<u>`, `<s>`, `<code>`, `<pre>`.
 *   - Headers and lists MUST be SIBLINGS at the body level —
 *     Asana rejects nested headers in lists and vice versa
 *     with a 400 / 500.
 *   - All agent-supplied text MUST be HTML-entity-escaped.
 *     The `escapeHtml` helper below replaces `&`, `<`, `>`,
 *     `"`, `'` defensively — defense-in-depth so a future
 *     agent that returns operator-controlled text in
 *     `alert.body` (today: never, but Builder shapes vary)
 *     can't smuggle a `<script>` tag through.
 *
 * # THREAT-MODEL §3.6 invariant 11
 *
 * Transformers operate on `(agentOutput, channelConfig)` only.
 * They NEVER see credentials — those are resolved later inside
 * the engine's `OutputChannelRegistry.deliver(...)` → adapter
 * write path. The bridge in `production-composition.ts`
 * structurally enforces this by calling the transformer BEFORE
 * the CredentialStore is touched.
 */
import type { AsanaTaskPayload } from "@opencoo/output-asana";

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Output channel config — the per-channel jsonb the operator
 * persisted via `POST /api/admin/output-channels`. For Asana
 * channels this carries `{ project_gid, assignee_gid? }`; for
 * webhook channels it carries `{ url, ...headers }`.
 *
 * Transformers consume this verbatim — the bridge layer
 * delivers the channel row's `config` to the closure.
 */
export type OutputChannelConfig = Readonly<Record<string, unknown>>;

/** Common argument shape every transformer accepts. */
export interface OutputTransformerArgs {
  readonly agentOutput: unknown;
  readonly channelConfig: OutputChannelConfig;
}

/** Per-(agent, adapter) transformer closure. */
export type OutputTransformer = (args: OutputTransformerArgs) => unknown;

/** Dispatcher arguments — the bridge in
 *  `production-composition.ts` supplies `agentSlug` (the
 *  `agent_instances.definition_slug` from the dispatcher) +
 *  `adapterSlug` (the output adapter slug the registry is
 *  about to deliver to). */
export interface MergePayloadForArgs {
  readonly agentSlug: string;
  readonly adapterSlug: string;
  readonly agentOutput: unknown;
  readonly channelConfig: OutputChannelConfig;
}

// ── Errors ────────────────────────────────────────────────────────────────

/** Thrown when the dispatcher cannot find any transformer
 *  (agent-specific or generic) for the requested adapter slug.
 *  Surfaces as a delivery failure — the post-run delivery
 *  loop in `agent-dispatcher.ts` logs + continues, the agent
 *  run itself stays `success`. */
export class OutputTransformerNotFoundError extends Error {
  readonly agentSlug: string;
  readonly adapterSlug: string;
  constructor(agentSlug: string, adapterSlug: string) {
    super(
      `output-transformers: no transformer registered for adapter '${adapterSlug}' ` +
        `(neither agent-specific nor generic fallback) — agent ${agentSlug}`,
    );
    this.name = "OutputTransformerNotFoundError";
    this.agentSlug = agentSlug;
    this.adapterSlug = adapterSlug;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Escape HTML entities in `text` so it can be safely
 *  interpolated into the restricted-HTML body Asana
 *  expects under `html_notes`. Replaces `&`, `<`, `>`, `"`,
 *  `'` — the standard five.
 *
 *  THREAT-MODEL §3.6 invariant 11: defense-in-depth. Today's
 *  agents emit a constrained shape (Heartbeat: structured
 *  alerts; Lint: structured findings) — but a future agent
 *  that surfaces operator-supplied text in any field must NOT
 *  be able to smuggle a `<script>` (Asana strips it, but
 *  layered safety is cheap). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Hard byte cap matching `AsanaTaskPayload.notes` /
 *  `htmlNotes`'s Zod max(32_768). Truncation happens at the
 *  transformer (not the schema) so callers don't see a 422
 *  on the wire — they see a slightly-shortened delivery. */
const HTML_NOTES_BYTE_CAP = 32_768;

/** Bytes of `<body>` + `</body>`. Reserved up-front so the
 *  inner-content cap leaves room for the wrapping tags. */
const BODY_WRAPPER_BYTES =
  Buffer.byteLength("<body>", "utf8") + Buffer.byteLength("</body>", "utf8");

/** Bytes of the truncation marker block we append when at least
 *  one sibling was dropped. */
// PR-Y5: Asana html_notes parser rejects <p>; use <em> (allowed)
// so the marker still stands out from the preceding content.
const TRUNCATION_MARKER = "<em>(truncated…)</em>";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");

/** Extra safety budget on top of the wrapper + marker bytes —
 *  guards against any future change to the marker / wrapper
 *  going over budget by a handful of bytes. */
const SAFETY_BYTES = 64;

/** Append HTML sibling blocks (e.g. `<h2>…</h2>`, bare text,
 *  `<ul>…</ul>`) under a `<body>…</body>` wrapper, stopping
 *  before the running byte total exceeds `HTML_NOTES_BYTE_CAP`.
 *
 *  Truncation is at SIBLING BOUNDARIES — we never cut inside a
 *  tag or an HTML entity (the previous codepoint-walk version
 *  could leave a half-escaped `&amp` or a half-closed `<body`
 *  on the wire, which Asana 400s on). When at least one sibling
 *  is dropped we append a final `<em>(truncated…)</em>` marker so
 *  the operator sees the delivery was clipped.
 *
 *  Copilot triage #4 — replaces the old `capHtmlBody` byte-walk. */
function wrapBodyWithCap(siblings: readonly string[]): string {
  const reserved = BODY_WRAPPER_BYTES + TRUNCATION_MARKER_BYTES + SAFETY_BYTES;
  const innerBudget = HTML_NOTES_BYTE_CAP - reserved;
  let used = 0;
  let truncated = false;
  const kept: string[] = [];
  for (const block of siblings) {
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (used + blockBytes > innerBudget) {
      truncated = true;
      break;
    }
    kept.push(block);
    used += blockBytes;
  }
  // PR-Y5 Copilot triage: separate the truncation marker from the
  // last kept sibling with `<hr/>` so it doesn't glue to a bare-text
  // body. `<hr/>` is on Asana's allow-list.
  const innerJoined = truncated
    ? kept.join("") + "<hr/>" + TRUNCATION_MARKER
    : kept.join("");
  return `<body>${innerJoined}</body>`;
}

/** Pull the project gid from a channel config; throw a clean
 *  error when missing. Centralised so every Asana transformer
 *  reports the same shape on misconfiguration. */
function projectGidFromConfig(cfg: OutputChannelConfig): string {
  const v = cfg["project_gid"];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      "output-asana: channel config is missing required field 'project_gid' (string)",
    );
  }
  return v;
}

/** Optional assignee gid lookup. Returns undefined when absent
 *  OR when the value is an empty string. */
function assigneeGidFromConfig(cfg: OutputChannelConfig): string | undefined {
  const v = cfg["assignee_gid"];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

/** Coerce arbitrary value → trimmed string for use as a title
 *  / alert title / etc. Caps at 500 chars to match the Asana
 *  task-title max. Returns null when the value is not a
 *  non-empty string. */
function asTitleString(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/** Today's UTC date in ISO-yyyy-mm-dd form — used as the
 *  fallback suffix when the agent didn't return a usable
 *  `summary` field. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Heartbeat alert shape — mirrors `HeartbeatOutput.alerts[*]`
 *  in `packages/ui/src/types.ts`. Narrow locally so we don't
 *  drag the UI types into the cli package. */
interface HeartbeatAlertLike {
  readonly priority?: number;
  readonly title?: string;
  readonly body?: string;
  readonly citations?: readonly string[];
}

/** Build the `<body><h2>…<p>…<ul>…</ul></body>` HTML for one
 *  Heartbeat alert. Headers and lists are SIBLINGS at the body
 *  level (Asana rejects nested headers in lists and vice versa).
 *  Every agent-supplied byte is HTML-entity-escaped first.
 *
 *  Returns the per-alert sibling blocks SEPARATELY so the
 *  outer cap can truncate at sibling boundaries (Copilot
 *  triage #4) without splitting a tag mid-block. */
function renderHeartbeatAlertHtml(alert: HeartbeatAlertLike): string[] {
  const parts: string[] = [];
  const title = typeof alert.title === "string" ? alert.title : "";
  parts.push(`<h2>${escapeHtml(title)}</h2>`);
  const body = typeof alert.body === "string" ? alert.body : "";
  if (body.length > 0) {
    // PR-Y5: Asana's html_notes parser rejects <p> despite the
    // docs claiming support. Use bare escaped text instead;
    // visual separation comes from the surrounding <h2> / <ul>
    // siblings + <hr/> if needed.
    parts.push(escapeHtml(body));
  }
  const citations: readonly unknown[] = Array.isArray(alert.citations)
    ? alert.citations
    : [];
  if (citations.length > 0) {
    const items = citations
      .filter((c: unknown): c is string => typeof c === "string" && c.length > 0)
      .map((c: string) => `<li>${escapeHtml(c)}</li>`)
      .join("");
    if (items.length > 0) {
      parts.push(`<ul>${items}</ul>`);
    }
  }
  return parts;
}

// ── Heartbeat ─────────────────────────────────────────────────────────────

/** Heartbeat output shape — mirrors
 *  `packages/ui/src/types.ts` `HeartbeatOutput`. */
interface HeartbeatOutputLike {
  readonly version?: string;
  readonly summary?: string;
  readonly alerts?: readonly HeartbeatAlertLike[];
}

/** Heartbeat → Asana html_notes. Each alert becomes one
 *  `<h2>` (title) + bare-text (body) + `<ul>` (citations) triple
 *  at the body level; the agent's `summary` field becomes the
 *  task title.
 *
 *  Q10 binding enforcement happens inside the registry — this
 *  transformer doesn't validate the channel slug; that's the
 *  registry's job. */
export function heartbeatToAsana(args: OutputTransformerArgs): AsanaTaskPayload {
  const projectGid = projectGidFromConfig(args.channelConfig);
  const out =
    (args.agentOutput as HeartbeatOutputLike | null | undefined) ?? {};
  const summary = asTitleString(out.summary, 500);
  const title = summary ?? `opencoo heartbeat — ${todayIso()}`;
  const alerts = Array.isArray(out.alerts) ? out.alerts : [];

  const siblings: string[] = [];
  for (const a of alerts) {
    for (const block of renderHeartbeatAlertHtml(a)) {
      siblings.push(block);
    }
  }
  // Empty-alerts case still produces a renderable body so Asana
  // doesn't reject the `html_notes` for a missing inner block.
  if (siblings.length === 0) {
    siblings.push(escapeHtml("No alerts today."));
  }
  const htmlNotes = wrapBodyWithCap(siblings);

  const assigneeGid = assigneeGidFromConfig(args.channelConfig);
  return {
    projectGid,
    title,
    htmlNotes,
    ...(assigneeGid !== undefined ? { assigneeGid } : {}),
  };
}

// ── Lint ──────────────────────────────────────────────────────────────────

/** Lint output shape — narrow structural mirror. The
 *  Lint agent emits `{ findings: [{ kind, title, body,
 *  citations? }, ...] }`. */
interface LintFindingLike {
  readonly kind?: string;
  readonly title?: string;
  readonly body?: string;
  readonly citations?: readonly string[];
}
interface LintOutputLike {
  readonly findings?: readonly LintFindingLike[];
}

export function lintToAsana(args: OutputTransformerArgs): AsanaTaskPayload {
  const projectGid = projectGidFromConfig(args.channelConfig);
  const out =
    (args.agentOutput as LintOutputLike | null | undefined) ?? {};
  const findings = Array.isArray(out.findings) ? out.findings : [];

  const title = `Wiki lint findings — ${todayIso()}`;

  const siblings: string[] = [];
  for (const f of findings) {
    const fHead = typeof f.title === "string" ? f.title : "";
    siblings.push(`<h2>${escapeHtml(fHead)}</h2>`);
    const fBody = typeof f.body === "string" ? f.body : "";
    if (fBody.length > 0) {
      siblings.push(escapeHtml(fBody));
    }
    const citations: readonly unknown[] = Array.isArray(f.citations)
      ? f.citations
      : [];
    if (citations.length > 0) {
      const items = citations
        .filter((c: unknown): c is string => typeof c === "string" && c.length > 0)
        .map((c: string) => `<li>${escapeHtml(c)}</li>`)
        .join("");
      if (items.length > 0) {
        siblings.push(`<ul>${items}</ul>`);
      }
    }
  }
  if (siblings.length === 0) {
    siblings.push(escapeHtml("No findings."));
  }
  const htmlNotes = wrapBodyWithCap(siblings);

  const assigneeGid = assigneeGidFromConfig(args.channelConfig);
  return {
    projectGid,
    title,
    htmlNotes,
    ...(assigneeGid !== undefined ? { assigneeGid } : {}),
  };
}

// ── Surfacer ──────────────────────────────────────────────────────────────

/** Surfacer output shape — narrow structural mirror.
 *  Surfacer emits one (or more) automation candidate
 *  proposals; for the v0.1 transformer we treat the first
 *  proposal as the task body. */
interface SurfacerOutputLike {
  readonly topic?: string;
  readonly title?: string;
  readonly rationale?: string;
  readonly summary?: string;
  readonly citations?: readonly string[];
}

export function surfacerToAsana(args: OutputTransformerArgs): AsanaTaskPayload {
  const projectGid = projectGidFromConfig(args.channelConfig);
  const out =
    (args.agentOutput as SurfacerOutputLike | null | undefined) ?? {};

  const titleCandidate =
    asTitleString(out.topic, 500) ??
    asTitleString(out.title, 500) ??
    asTitleString(out.summary, 500);
  const title = titleCandidate ?? `opencoo surfacer — ${todayIso()}`;

  const siblings: string[] = [];
  const rationale = typeof out.rationale === "string" ? out.rationale : "";
  if (rationale.length > 0) {
    siblings.push(`<h2>${escapeHtml("Rationale")}</h2>`);
    siblings.push(escapeHtml(rationale));
  }
  const citations: readonly unknown[] = Array.isArray(out.citations)
    ? out.citations
    : [];
  if (citations.length > 0) {
    siblings.push(`<h2>${escapeHtml("Citations")}</h2>`);
    const items = citations
      .filter((c: unknown): c is string => typeof c === "string" && c.length > 0)
      .map((c: string) => `<li>${escapeHtml(c)}</li>`)
      .join("");
    if (items.length > 0) {
      siblings.push(`<ul>${items}</ul>`);
    }
  }
  if (siblings.length === 0) {
    siblings.push(
      escapeHtml("Surfacer produced no rationale or citations."),
    );
  }
  const htmlNotes = wrapBodyWithCap(siblings);

  const assigneeGid = assigneeGidFromConfig(args.channelConfig);
  return {
    projectGid,
    title,
    htmlNotes,
    ...(assigneeGid !== undefined ? { assigneeGid } : {}),
  };
}

// ── Webhook pass-throughs ──────────────────────────────────────────────────

/** Webhook payload shape — the engine's `output-webhook`
 *  adapter (not yet shipped in v0.1) is expected to consume
 *  `{ event, data }`. The transformer is a pass-through —
 *  every webhook receives the agent's verbatim JSON output. */
export interface WebhookPayload {
  readonly event: string;
  readonly data: unknown;
}

export function heartbeatToWebhook(args: OutputTransformerArgs): WebhookPayload {
  return { event: "agent.run.completed", data: args.agentOutput };
}

export function lintToWebhook(args: OutputTransformerArgs): WebhookPayload {
  return { event: "agent.run.completed", data: args.agentOutput };
}

export function surfacerToWebhook(args: OutputTransformerArgs): WebhookPayload {
  return { event: "agent.run.completed", data: args.agentOutput };
}

// ── Generic fallbacks (preserve PR-Z4 behaviour) ──────────────────────────

/** Generic Asana payload — the OLD `mergeAsanaPayload` closure
 *  factored verbatim. The dispatcher falls back to this when
 *  the agent slug has no per-(agent, adapter) transformer
 *  registered, so an unknown agent still delivers (the
 *  formatting is a JSON pretty-print blob; not pretty, but
 *  better than the post-run delivery failing). */
export function mergeAsanaPayloadGeneric(
  args: OutputTransformerArgs,
): AsanaTaskPayload {
  const projectGid = projectGidFromConfig(args.channelConfig);
  const out = (args.agentOutput as Record<string, unknown> | null) ?? {};
  const summaryCandidate =
    typeof out["summary"] === "string"
      ? (out["summary"] as string)
      : null;
  const title = (summaryCandidate ?? "opencoo daily report").slice(0, 500);
  const notes = JSON.stringify(out, null, 2).slice(0, HTML_NOTES_BYTE_CAP);
  const assigneeGid = assigneeGidFromConfig(args.channelConfig);
  return {
    projectGid,
    title,
    notes,
    ...(assigneeGid !== undefined ? { assigneeGid } : {}),
  };
}

/** Generic webhook payload — the same pass-through shape
 *  every webhook adapter receives. Symmetric to the
 *  agent-specific webhook transformers above. */
export function mergeWebhookPayloadGeneric(
  args: OutputTransformerArgs,
): WebhookPayload {
  return { event: "agent.run.completed", data: args.agentOutput };
}

// ── Dispatch table + lookup ───────────────────────────────────────────────

/** Per-(agent, adapter) transformer lookup. Keyed first by the
 *  agent's `definition_slug` (the value the dispatcher reads
 *  from `agent_instances.definition_slug`), then by the output
 *  adapter slug. Tests pin every documented pair below.
 *
 *  Adding a new agent or a new adapter:
 *   1. Implement the per-agent transformer (or webhook
 *      pass-through if the adapter is a generic webhook).
 *   2. Register it under `TRANSFORMERS[agentSlug][adapterSlug]`.
 *   3. Add a generic fallback for the adapter in
 *      `GENERIC_TRANSFORMERS[adapterSlug]` if one doesn't exist.
 *   4. Add a happy-path test in `output-transformers.test.ts`.
 */
const TRANSFORMERS: Readonly<
  Record<string, Readonly<Record<string, OutputTransformer>>>
> = {
  heartbeat: {
    asana: heartbeatToAsana,
    webhook: heartbeatToWebhook,
  },
  lint: {
    asana: lintToAsana,
    webhook: lintToWebhook,
  },
  surfacer: {
    asana: surfacerToAsana,
    webhook: surfacerToWebhook,
  },
};

/** Adapter-only generic fallbacks. Used when the dispatcher
 *  receives an unknown agent slug. */
const GENERIC_TRANSFORMERS: Readonly<Record<string, OutputTransformer>> = {
  asana: mergeAsanaPayloadGeneric,
  webhook: mergeWebhookPayloadGeneric,
};

/** Dispatch the right transformer for the given (agent,
 *  adapter) pair and return the adapter-specific payload
 *  shape (e.g. `AsanaTaskPayload`). Falls back to the
 *  adapter-only generic when no agent-specific transformer
 *  exists. Throws `OutputTransformerNotFoundError` if neither
 *  is registered.
 *
 *  Returns `unknown` so the bridge in
 *  `production-composition.ts` doesn't need to know about
 *  every per-adapter payload shape — the OutputAdapter's
 *  `payloadSchema.parse()` at write-time will reject any
 *  payload that doesn't structurally match. */
export function mergePayloadFor(args: MergePayloadForArgs): unknown {
  const perAgent = TRANSFORMERS[args.agentSlug];
  const specific = perAgent?.[args.adapterSlug];
  if (specific !== undefined) {
    return specific({
      agentOutput: args.agentOutput,
      channelConfig: args.channelConfig,
    });
  }
  const generic = GENERIC_TRANSFORMERS[args.adapterSlug];
  if (generic !== undefined) {
    return generic({
      agentOutput: args.agentOutput,
      channelConfig: args.channelConfig,
    });
  }
  throw new OutputTransformerNotFoundError(args.agentSlug, args.adapterSlug);
}
