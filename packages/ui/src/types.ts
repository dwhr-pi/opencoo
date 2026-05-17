/**
 * Cross-route shared types (PR 29 / plan #131).
 */
// Phase-a appendix #4: 'activity' = 5th tab (PR-B), 'review' = 6th (PR-C),
// 'reports' = 7th (PR-D).
// Phase-a appendix #10 PR-R4: 'audit' = 8th tab (audit-log viewer).
// Phase-a appendix #10 PR-R5: 'cost' = 9th tab (cost analytics).
// Phase-a appendix #13 PR-W2: 'agents' = sits between 'sources' and 'outputs'.
export type Tab =
  | "domains"
  | "sources"
  | "agents"
  | "outputs"
  | "llmPolicy"
  | "prompts"
  | "activity"
  | "review"
  | "reports"
  | "audit"
  | "cost";

/** PR-W2 (phase-a appendix #13) — agent instance row shape.
 *  Mirrors the GET `/api/admin/agent-instances` response. */
export interface AgentInstance {
  readonly id: string;
  readonly definitionSlug: string;
  readonly name: string;
  readonly scheduleCron: string | null;
  readonly enabled: boolean;
  /** Count of channels currently bound to this instance.
   *  Surfaced by the list endpoint; the drill-down also
   *  receives the full binding array via `outputChannelIds`. */
  readonly outputChannelCount: number;
  /** Verbatim binding array — each entry is the
   *  `{adapter_slug, config: {channel_id}}` shape the
   *  dispatcher already consumes. The detail modal reads
   *  `config.channel_id` to pre-check the multi-select. */
  readonly outputChannelIds: ReadonlyArray<{
    readonly adapter_slug: string;
    readonly config: Record<string, unknown>;
  }>;
  /** PR-W4-UI (phase-a appendix #15) — `locale` column. The
   *  drill-down's Locale editor pre-selects this. Optional for
   *  back-compat with pre-W4-UI fixtures. */
  readonly locale?: string;
  /** PR-W4-UI — `scope_domain_ids` uuid[]. The drill-down's
   *  Scope section pre-checks the multi-select picker against
   *  these. Optional for back-compat with pre-W4-UI fixtures
   *  (defaults to empty array at the UI). */
  readonly scopeDomainIds?: ReadonlyArray<string>;
  readonly lastRunStartedAt: string | null;
  readonly lastRunStatus: string | null;
}

/** PR-Z4 (phase-a appendix #12 G5) — output channel row shape. */
export interface OutputChannel {
  readonly id: string;
  readonly adapterSlug: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** PR-Z4 — descriptor for one OutputAdapter the `+ New channel`
 *  modal uses to render the form. Mirrors what `/api/admin/adapters`
 *  returns under `outputAdapters[]`. */
export interface OutputAdapterEntry {
  readonly slug: string;
  readonly credentialSchema: {
    readonly type: "object";
    readonly properties: Readonly<
      Record<
        string,
        Readonly<{
          readonly type: "string" | "boolean";
          readonly description?: string;
          readonly secret?: boolean;
        }>
      >
    >;
    readonly required: readonly string[];
  };
  readonly channelConfigSchema: {
    readonly type: "object";
    readonly properties: Readonly<
      Record<
        string,
        // Mirror of `OutputAdapterDescriptorChannelConfigProperty` in
        // `engine-self-operating`. Scalar entries are rendered as
        // `<input>` widgets; `object`-typed entries are documentation
        // only (the description is shown, but no nested widget is
        // generated — server-side Zod still enforces the shape).
        | Readonly<{
            readonly type: "string" | "boolean" | "number" | "integer";
            readonly description?: string;
            readonly minimum?: number;
            readonly maximum?: number;
          }>
        | Readonly<{
            readonly type: "object";
            readonly description?: string;
            readonly additionalProperties?: Readonly<{
              readonly type: "string" | "boolean" | "number" | "integer";
            }>;
            readonly properties?: Readonly<
              Record<
                string,
                Readonly<{
                  readonly type: "string" | "boolean" | "number" | "integer";
                  readonly description?: string;
                  readonly minimum?: number;
                  readonly maximum?: number;
                }>
              >
            >;
          }>
      >
    >;
    readonly required: readonly string[];
  };
}

export interface Domain {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly class: string;
  readonly locale: string;
  readonly isAggregator: boolean;
  /** ISO 8601 timestamp the domain was soft-disabled, or null
   *  for active domains. Phase-a appendix #10 PR-R1 — present
   *  only on rows from `GET /api/admin/domains` (the LLM-policy
   *  picker uses `?include_disabled=0` by default, so its rows
   *  always have `null`). Optional for backward-compat with
   *  test fixtures that pre-date the column. */
  readonly disabledAt?: string | null;
  /** Count of `sources_bindings.domain_id` rows referencing this
   *  domain. Surfaced by GET so the row-drill-down can disable
   *  the Hard-delete button when bindings would block it.
   *  Optional for backward-compat. */
  readonly bindingCount?: number;
  /** PR-W3 (phase-a appendix #15) — operational config the
   *  DomainDetail "Configuration" section edits. Surfaced by GET
   *  so the modal can pre-fill the controls without a second
   *  round-trip. All five are optional for back-compat with
   *  pre-W3 fixtures + the LLM-policy-picker payload.
   *
   *  `retentionDays`: integer 1–365 or `null` (no retention
   *  policy on this domain — falls back to engine default).
   *  `governanceCadence`: enum literal — pinned in sync with
   *  `governance_cadence` in `enums.ts`.
   *  `reviewRole`: free-form operator-facing label or `null`.
   *  `worldviewEnabled`: at-rest gate. `false` stops the trigger
   *  pipeline from enqueueing further compile jobs.
   *  `llmBudgetMonthlyCapUsd`: stringified numeric(10,2) or
   *  `null` (no cap). Preserved as a string to avoid binary-
   *  fp round-trip drift. */
  readonly retentionDays?: number | null;
  readonly governanceCadence?:
    | "continuous"
    | "nightly"
    | "weekly"
    | "quarterly"
    | "adhoc";
  readonly reviewRole?: string | null;
  readonly worldviewEnabled?: boolean;
  readonly llmBudgetMonthlyCapUsd?: string | null;
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
  /** Count of webhook_events rows with `signature_ok=false` in the last 24h.
   *  PR-Q10 addition — surfaced by the Sources row drill-down so the operator
   *  can see HMAC failures without re-querying. Optional for backward-compat
   *  with older clients. */
  readonly sigFailCount24h?: number;
  /** PR-R2 — operational config jsonb. The Sources row drill-down's
   *  Edit panel pre-seeds the `bindingConfigSchema` form with this so
   *  the operator gets a full-state edit surface. Plain object;
   *  values may include operator-internal IDs but never secret bytes
   *  (those live behind `credentials_id`, never in config). Optional
   *  for backward-compat with older fixtures. */
  readonly config?: Record<string, unknown>;
  /** PR-W1 (phase-a appendix #14) — subtree-glob list the classifier
   *  may write into. Sources row drill-down shows this as a chip list
   *  with an Edit button that dispatches PATCH `{allowed_paths}`.
   *  Optional for backward-compat with older fixtures; the server
   *  surfaces an empty array `[]` for bindings still on the pre-W1
   *  default. */
  readonly allowedPaths?: readonly string[];
  /** PR-W4 (phase-a appendix #14) — per-status `ingestion_intake`
   *  counts. The SourceBindingDetail "Intake state" panel renders the
   *  four numbers; the GET handler defaults each to 0 on bindings
   *  with no intake history. Optional for back-compat with fixtures
   *  predating W4. */
  readonly intakeCounts?: {
    readonly pending: number;
    readonly classified: number;
    readonly skipped: number;
    readonly failed: number;
  };
  /** PR-W4 — top 3 most-recent `failed` intake rows (newest-first),
   *  carrying the scrubbed + 200-char-capped `errorTextSnippet` and
   *  the `error_class` chip. The SourceBindingDetail panel renders
   *  one row per entry with a Retry button (currently disabled, ships
   *  in PR-W2). */
  readonly recentFailedIntake?: ReadonlyArray<{
    readonly id: string;
    readonly errorClass: string | null;
    readonly errorTextSnippet: string | null;
  }>;
  /** PR-W5 (phase-a appendix #15) — per-binding retention override.
   *  `null` means "use domain default". The SourceBindingDetail
   *  editor shows the current value plus the domain default. */
  readonly retentionDaysOverride?: number | null;
  /** PR-W5 — domain-level default retention. Surfaced alongside
   *  `retentionDaysOverride` so the editor can render "Using domain
   *  default: X days" when the override is null. */
  readonly domainRetentionDays?: number | null;
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

/** Line-level diff entry produced by the prompt-overrides
 *  preview route (PR-W2). The server emits one per source-line
 *  pair — `same` lines anchor the diff for the operator;
 *  `add`/`del` lines are the actual changes. The
 *  `DiffPreviewDialog` renders this shape with the same
 *  Wiki-Teal / Alert-Red token bindings as the key-level diff. */
export interface LineDiffEntry {
  readonly op: "same" | "add" | "del";
  readonly line: string;
  readonly index: number;
}

/** Prompt-override preview shape (PR-W7a). Line-level diff
 *  variant of `SovereigntyDiffPreview`; ships with the
 *  baseline-version the diff was computed against so the apply
 *  request can echo it back and the server can reject mid-flight
 *  baseline drift with a distinct 422 `baseline_version_drifted`. */
export interface PromptOverridePreview {
  readonly diff: ReadonlyArray<LineDiffEntry>;
  readonly token: string;
  readonly expiresAt: number;
  readonly baselineVersion: string;
  readonly currentSource: "baseline" | "override";
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

/** PR-W8 (phase-a appendix #15) — diagnostic preconditions for the
 *  Reports empty-state panel. Counts only — no run output, no body
 *  bytes — so the response is safe under the admin-team gate. The
 *  panel walks the fields top-to-bottom and surfaces the FIRST missing
 *  precondition with an inline CTA so operators don't have to grep
 *  logs to find out why the heartbeat list is empty. */
export interface HeartbeatPreconditions {
  readonly heartbeatInstanceCount: number;
  readonly enabledHeartbeatInstanceCount: number;
  /** Enabled instances whose `output_channel_ids` array is empty. */
  readonly instancesWithoutOutputChannels: number;
  /** Newest `agent_runs` row for `definition_slug='heartbeat'`. */
  readonly mostRecentRun: {
    readonly startedAt: string | null;
    readonly status: string;
    readonly outputIsNull: boolean;
    readonly instanceName: string | null;
  } | null;
  /** Newest heartbeat dispatch timestamp regardless of run status.
   *  Mirrors `mostRecentRun.startedAt` today; surfaced separately so
   *  future schema changes (e.g. distinguishing enqueue from start)
   *  can refine it without breaking the panel. */
  readonly mostRecentDispatchedAt: string | null;
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
