/**
 * Admin-API fixtures for the accessibility Playwright spec
 * (PR-A7, phase-a appendix #16 / wave-16).
 *
 * The accessibility job walks every route × every modal × en + pl
 * against the built UI. To keep the CI job tight (< 10 min) and
 * hermetic, every `/api/admin/*` request is short-circuited via
 * `page.route` against the canned responses below; the engine
 * + Postgres + Gitea compose stack is NOT booted. Accessibility
 * is a property of the rendered DOM — what matters is that every
 * surface has data to render, not that the data is live.
 *
 * Each fixture is the minimum shape the matching route or
 * component needs to render its non-empty state. Empty states
 * are well-covered by jsdom unit tests; the axe walk targets the
 * data-bearing chrome (tables, panels, modal contents).
 */
import type { Route } from "@playwright/test";

/** Stable ISO timestamps so snapshot text doesn't drift. */
const ISO_NOW = "2026-05-17T12:00:00.000Z";
const ISO_PRIOR = "2026-05-16T12:00:00.000Z";

const DOMAIN_EXEC = {
  id: "00000000-0000-0000-0000-000000000001",
  slug: "wiki-executive",
  name: "Executive",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: null,
  bindingCount: 2,
  retentionDays: 90,
  governanceCadence: "weekly" as const,
  reviewRole: "executive-team",
  worldviewEnabled: true,
  llmBudgetMonthlyCapUsd: "250.00",
} as const;

const DOMAIN_HR = {
  id: "00000000-0000-0000-0000-000000000002",
  slug: "wiki-hr",
  name: "Human Resources",
  class: "knowledge",
  locale: "en",
  isAggregator: false,
  disabledAt: null,
  bindingCount: 1,
  retentionDays: 365,
  governanceCadence: "nightly" as const,
  reviewRole: "hr-lead",
  worldviewEnabled: true,
  llmBudgetMonthlyCapUsd: "100.00",
} as const;

const SOURCE_BINDING = {
  id: "10000000-0000-0000-0000-000000000001",
  domainSlug: DOMAIN_EXEC.slug,
  adapterSlug: "source-drive",
  reviewMode: "auto",
  enabled: true,
  notes: "Quarterly board folder",
  name: "Quarterly board folder",
  status: "healthy" as const,
  lastEventAt: ISO_PRIOR,
  lastError: null,
  pendingEventsCount: 0,
  sigFailCount24h: 0,
  config: { folder_id: "abc123" },
  allowedPaths: ["board/quarterly/*"],
  intakeCounts: { pending: 0, classified: 12, skipped: 1, failed: 0 },
  recentFailedIntake: [],
  retentionDaysOverride: null,
  domainRetentionDays: 90,
} as const;

const AGENT_INSTANCE = {
  id: "20000000-0000-0000-0000-000000000001",
  definitionSlug: "heartbeat",
  name: "weekday-morning",
  scheduleCron: "0 8 * * 1-5",
  enabled: true,
  outputChannelCount: 1,
  outputChannelIds: [
    {
      adapter_slug: "output-asana",
      config: { channel_id: "30000000-0000-0000-0000-000000000001" },
    },
  ],
  locale: "en",
  scopeDomainIds: [DOMAIN_EXEC.id],
  lastRunStartedAt: ISO_PRIOR,
  lastRunStatus: "ok",
} as const;

const OUTPUT_CHANNEL = {
  id: "30000000-0000-0000-0000-000000000001",
  adapterSlug: "output-asana",
  name: "Exec daily briefing",
  enabled: true,
  config: { project_gid: "1234567890" },
  createdAt: ISO_PRIOR,
  updatedAt: ISO_PRIOR,
} as const;

const HEARTBEAT_REPORT = {
  runId: "40000000-0000-0000-0000-000000000001",
  instanceId: AGENT_INSTANCE.id,
  instanceName: AGENT_INSTANCE.name,
  startedAt: ISO_PRIOR,
  output: {
    version: "1",
    summary:
      "Executive wiki saw 12 ingest events overnight. Two contradictions surfaced; both flagged for review.",
    alerts: [
      {
        priority: 1,
        title: "Q2 forecast contradicts board-pack draft",
        body: "Two source documents disagree on Q2 revenue projection. Owner: CFO.",
        citations: ["finance/q2-projection.md", "board/draft-pack.md"],
      },
    ],
  },
} as const;

const PIPELINE_STATS = [
  {
    name: "ingestion",
    depth: 0,
    failedCount: 0,
    dlqCount: 0,
    lastRunAt: ISO_NOW,
    lastFailureAt: null,
  },
  {
    name: "compile",
    depth: 0,
    failedCount: 0,
    dlqCount: 0,
    lastRunAt: ISO_NOW,
    lastFailureAt: null,
  },
] as const;

const ADAPTERS_DESCRIPTOR = {
  sourceAdapters: [
    {
      slug: "source-drive",
      credentialSchema: {
        type: "object",
        properties: {
          serviceAccountJson: {
            type: "string",
            description: "Service-account JSON",
            secret: true,
          },
        },
        required: ["serviceAccountJson"],
      },
      bindingConfigSchema: {
        type: "object",
        properties: {
          folder_id: { type: "string", description: "Drive folder ID" },
        },
        required: ["folder_id"],
      },
    },
  ],
  outputAdapters: [
    {
      slug: "output-asana",
      credentialSchema: {
        type: "object",
        properties: {
          pat: { type: "string", description: "Asana PAT", secret: true },
        },
        required: ["pat"],
      },
      channelConfigSchema: {
        type: "object",
        properties: {
          project_gid: {
            type: "string",
            description: "Asana project GID",
          },
        },
        required: ["project_gid"],
      },
    },
  ],
  guardAdapters: [],
  automationAdapters: [],
} as const;

const LLM_MODELS = [
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    tier: "thinker",
    pricePerMillionInputUsd: "15.00",
    pricePerMillionOutputUsd: "75.00",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    tier: "worker",
    pricePerMillionInputUsd: "3.00",
    pricePerMillionOutputUsd: "15.00",
  },
] as const;

const AGENT_RUNS = [
  {
    id: "50000000-0000-0000-0000-000000000001",
    definitionSlug: "heartbeat",
    instanceId: AGENT_INSTANCE.id,
    trigger: "schedule",
    skillsUsed: [],
    tokensIn: 1234,
    tokensOut: 567,
    costUsd: "0.0245",
    latencyMs: 4321,
    status: "ok",
    errorClass: null,
    startedAt: ISO_PRIOR,
    endedAt: ISO_PRIOR,
    createdAt: ISO_PRIOR,
  },
] as const;

const AUDIT_LOG = {
  total: 1,
  rows: [
    {
      id: "60000000-0000-0000-0000-000000000001",
      verb: "agent_instance.update",
      actor: "operator",
      subject: AGENT_INSTANCE.id,
      metadata: { field: "name", before: "morning", after: "weekday-morning" },
      occurredAt: ISO_PRIOR,
    },
  ],
} as const;

const COST_SUMMARY = {
  period: "30d",
  totalUsd: "12.34",
  byTier: [
    { tier: "thinker", totalUsd: "8.10" },
    { tier: "worker", totalUsd: "3.50" },
    { tier: "light", totalUsd: "0.74" },
  ],
  byPipeline: [
    { pipeline: "compile", totalUsd: "6.20" },
    { pipeline: "ingestion", totalUsd: "2.40" },
  ],
  byDomain: [{ domainSlug: DOMAIN_EXEC.slug, totalUsd: "9.50" }],
  byModel: [],
} as const;

const PROMPTS_MANIFEST = [
  {
    name: "heartbeat",
    locales: [
      { locale: "en", version: "v1" },
      { locale: "pl", version: "v1" },
    ],
  },
  {
    name: "classifier",
    locales: [{ locale: "en", version: "v1" }],
  },
] as const;

const LINT_FINDINGS = {
  rows: [
    {
      id: "70000000-0000-0000-0000-000000000001",
      domainId: DOMAIN_EXEC.id,
      kind: "contradiction",
      path: "finance/q2-projection.md",
      summary: "Two values disagree on Q2 revenue.",
      detectedAt: ISO_PRIOR,
      status: "open",
    },
  ],
} as const;

const REVIEW_QUEUE = {
  bindings: [],
  promptOverrides: [],
  llmPolicies: [],
  skillCandidates: [],
  marketplaceUpdates: [],
} as const;

const HEARTBEAT_PRECONDITIONS = {
  heartbeatInstanceCount: 1,
  enabledHeartbeatInstanceCount: 1,
  instancesWithoutOutputChannels: 0,
  mostRecentRun: {
    startedAt: ISO_PRIOR,
    status: "ok",
    outputIsNull: false,
    instanceName: AGENT_INSTANCE.name,
  },
  mostRecentDispatchedAt: ISO_PRIOR,
} as const;

const REDACTION_EVENTS = [
  {
    id: "80000000-0000-0000-0000-000000000001",
    pipeline: "ingestion",
    domainId: DOMAIN_EXEC.id,
    bindingId: SOURCE_BINDING.id,
    guardSlug: "guard-redaction-regex",
    category: "pii",
    patternVersion: "v1",
    matchedByteRangesCount: 2,
    failMode: "redact",
    createdAt: ISO_PRIOR,
  },
] as const;

const AUTOMATION_CANDIDATES: ReadonlyArray<unknown> = [];

const SCHEDULER_STATE = {
  instances: [
    {
      id: AGENT_INSTANCE.id,
      name: AGENT_INSTANCE.name,
      definitionSlug: AGENT_INSTANCE.definitionSlug,
      scheduleCron: AGENT_INSTANCE.scheduleCron,
      nextRunAt: "2026-05-19T08:00:00.000Z",
      lastRunAt: ISO_PRIOR,
      enabled: AGENT_INSTANCE.enabled,
    },
  ],
} as const;

/** Match an admin-API request URL → JSON body. Returns `null` for
 *  unknown URLs so the spec can fall through to a default 404
 *  (which axe should not see — every URL the UI touches has a
 *  matching entry). */
function bodyFor(url: string): unknown {
  // _csrf returns username + locale; the CSRF token cookie is
  // set by the matching `Set-Cookie` header in `handle()`.
  if (url.includes("/api/admin/_csrf")) {
    return {
      csrfToken: "test-csrf-token",
      username: "test-operator",
      _llmDebugLogActive: false,
      localePreference: null,
    };
  }
  if (url.includes("/api/admin/heartbeat/preconditions")) {
    return HEARTBEAT_PRECONDITIONS;
  }
  if (url.includes("/api/admin/heartbeat")) {
    return { rows: [HEARTBEAT_REPORT] };
  }
  if (url.includes("/api/admin/domains")) {
    return { rows: [DOMAIN_EXEC, DOMAIN_HR] };
  }
  if (url.includes("/api/admin/source-bindings")) {
    return { rows: [SOURCE_BINDING] };
  }
  if (url.includes("/api/admin/agent-instances")) {
    return { rows: [AGENT_INSTANCE] };
  }
  if (url.includes("/api/admin/agent-runs")) {
    return { rows: AGENT_RUNS };
  }
  if (url.includes("/api/admin/output-channels")) {
    return { rows: [OUTPUT_CHANNEL] };
  }
  if (url.includes("/api/admin/pipelines")) {
    return { rows: PIPELINE_STATS };
  }
  if (url.includes("/api/admin/adapters")) {
    return ADAPTERS_DESCRIPTOR;
  }
  if (url.includes("/api/admin/llm-models")) {
    return { rows: LLM_MODELS };
  }
  if (url.includes("/api/admin/prompts")) {
    return { rows: PROMPTS_MANIFEST };
  }
  if (url.includes("/api/admin/audit-log")) {
    return AUDIT_LOG;
  }
  if (url.includes("/api/admin/cost-summary")) {
    return COST_SUMMARY;
  }
  if (url.includes("/api/admin/lint-findings")) {
    return LINT_FINDINGS;
  }
  if (url.includes("/api/admin/redaction-events")) {
    return { rows: REDACTION_EVENTS };
  }
  if (url.includes("/api/admin/automation-candidates")) {
    return { rows: AUTOMATION_CANDIDATES };
  }
  if (url.includes("/api/admin/scheduler")) {
    return SCHEDULER_STATE;
  }
  if (url.includes("/api/admin/review")) {
    return REVIEW_QUEUE;
  }
  return null;
}

/** Install a single `page.route` matcher that handles every
 *  `/api/admin/*` request. Mutating endpoints (POST/PATCH/DELETE
 *  + SSE) respond with a benign 204/empty body so the UI proceeds
 *  but no state change happens in the fixture — accessibility
 *  doesn't require live mutations. */
export async function installAdminApiMocks(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.route("**/api/admin/**", async (route: Route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();

    // SSE: abort the request outright. The SPA's `openSseClient`
    // treats a hard fetch failure as a transient disconnect and
    // schedules a 500ms → 10s exponential-backoff reconnect; a
    // 200 + finite body would instead EOF immediately and create
    // a tighter reconnect loop (Copilot triage on PR-A7). axe-core
    // is a sync DOM walk that doesn't depend on SSE state, so a
    // suspended/retrying client doesn't shift the audited surface.
    if (url.includes("/api/admin/events")) {
      await route.abort("blockedbyclient");
      return;
    }

    // Mutating verbs: 204 No Content. The Toast queue will surface
    // an "ok" toast which axe still walks for ARIA semantics.
    if (method !== "GET") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    const body = bodyFor(url);
    if (body === null) {
      // Default-deny 404 with empty JSON. Axe should never see this
      // (every endpoint the UI hits has a fixture above); we log so
      // a future drift is obvious in CI output.
      console.warn(`[axe-fixture] no fixture for ${method} ${url}`);
      await route.fulfill({
        status: 404,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "not_found" }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        // Mirror the production CSRF cookie shape so the SPA's
        // CSRF round-trip in fetchAdmin succeeds.
        "set-cookie": "opencoo_csrf=test-csrf-token; Path=/; SameSite=Strict",
      },
      body: JSON.stringify(body),
    });
  });
}
