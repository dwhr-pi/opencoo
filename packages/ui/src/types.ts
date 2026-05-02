/**
 * Cross-route shared types (PR 29 / plan #131).
 */
// Phase-a appendix #4: 'activity' = 5th tab (PR-B), 'review' = 6th (PR-C),
// 'reports' = 7th (PR-D).
export type Tab = "domains" | "sources" | "llmPolicy" | "prompts" | "activity" | "review" | "reports";

export interface Domain {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly class: string;
  readonly locale: string;
  readonly isAggregator: boolean;
}

export interface SourceBinding {
  readonly id: string;
  readonly domainSlug: string;
  readonly adapterSlug: string;
  readonly reviewMode: string;
  readonly enabled: boolean;
  readonly notes: string | null;
  /** Human-readable label: server-derived from notes or adapter→domain.
   *  A schema column for explicit name is a v0.2 enhancement. */
  readonly name: string;
  /** Server-computed 3-state health status, or null for neutral
   *  (newly-created binding with no events, or paused/disabled). */
  readonly status: "healthy" | "advisory" | "alert" | null;
  /** ISO timestamp of most-recent webhook event, or null. */
  readonly lastEventAt: string | null;
  /** Truncated + scrubbed error string, or null. Max 200 chars.
   *  THREAT-MODEL §3.6 invariant 11: no credential bytes. */
  readonly lastError: string | null;
  /** Count of webhook_events rows with status='pending' for this binding.
   *  Phase-a appendix #4 PR-C addition. Used by the Review Dashboard.
   *  Sources tab (PR-A) does not require this field — it is optional here
   *  to preserve backward-compat with the Sources route's existing usage. */
  readonly pendingEventsCount?: number;
}

export interface PromptManifestEntry {
  readonly name: string;
  readonly locales: ReadonlyArray<{ readonly locale: string; readonly version: string }>;
}

export interface SovereigntyDiffPreview {
  readonly diff: ReadonlyArray<{
    readonly path: string;
    readonly before: unknown;
    readonly after: unknown;
  }>;
  readonly token: string;
  readonly expiresAt: number;
}

/** Agent run list row (no `output` — detail only). */
export interface AgentRun {
  readonly id: string;
  readonly definitionSlug: string;
  readonly instanceId: string | null;
  readonly trigger: string;
  readonly skillsUsed: readonly unknown[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: string;
  readonly latencyMs: number;
  readonly status: string;
  readonly errorClass: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string | null;
}

/** Pipeline (BullMQ queue) stat card. */
export interface Pipeline {
  readonly name: string;
  readonly depth: number;
  readonly failedCount: number;
  readonly dlqCount: number;
  readonly lastRunAt: string | null;
  readonly lastFailureAt: string | null;
}

/** One alert from a Heartbeat agent run (subset of HeartbeatOutput). */
export interface HeartbeatAlert {
  readonly priority: number;
  readonly title: string;
  readonly body: string;
  readonly citations: readonly string[];
}

/** Heartbeat output stored in agent_runs.output for definitionSlug='heartbeat'. */
export interface HeartbeatOutput {
  readonly version: string;
  readonly summary: string;
  readonly alerts: readonly HeartbeatAlert[];
}

/** One heartbeat report row from GET /api/admin/heartbeat. */
export interface HeartbeatReport {
  readonly runId: string;
  readonly instanceId: string | null;
  readonly instanceName: string | null;
  readonly startedAt: string | null;
  readonly output: HeartbeatOutput;
}

/**
 * One redaction event row from GET /api/admin/redaction-events.
 *
 * THREAT-MODEL §3.3: matchedByteRanges is NEVER returned.
 * Only matchedByteRangesCount (integer count) is present.
 */
export interface RedactionEvent {
  readonly id: string;
  readonly pipeline: string;
  readonly domainId: string | null;
  readonly bindingId: string | null;
  readonly guardSlug: string;
  readonly category: string;
  readonly patternVersion: string;
  /** Count of matched byte ranges — NOT the ranges themselves. §3.3. */
  readonly matchedByteRangesCount: number;
  readonly failMode: string;
  readonly createdAt: string | null;
}

/** Server response shape for `POST /api/admin/domains/:id/llm-policy/apply`.
 *  The `id` field mirrors the server's `{ ok: true, id }` payload
 *  shape verbatim; renaming on the wire is not done. */
export interface LlmPolicyApplyResult {
  readonly ok: true;
  readonly id: string;
}

/**
 * SSE event shape for output-delivery DLQ alerts (PR-L).
 *
 * Emitted when an OutputAdapter's retry loop exhausts all attempts and
 * the delivery is permanently failed. Surfaced in the Activity feed as
 * an alert-toned entry so operators see permanent failures without
 * polling the audit log.
 *
 * Broadcast on the SSE channel as `event: output_delivery_dlq`.
 */
export interface OutputDeliveryDlqEvent {
  readonly type: "output_delivery_dlq";
  readonly outputBindingId: string;
  readonly deliveryId: string;
  /** Stringified error message. THREAT-MODEL §3.6 inv 11: no secret bytes. */
  readonly error: string;
  /** ISO timestamp when the DLQ event was emitted by the bus. */
  readonly occurredAt: string;
}
