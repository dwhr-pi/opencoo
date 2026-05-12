// Public surface for @opencoo/engine-self-operating. The
// composition root (PR 30 CLI) imports `start` to launch the
// engine; PR 19+ self-op pipelines (Heartbeat, Lint, Builder,
// Chat, Surfacer) consume the registry shape from
// @opencoo/shared/engine-scaffold (re-exported via this barrel
// for ergonomics).

export {
  loadEngineConfig,
  type EngineConfig,
} from "./config.js";

export {
  isPathWithinRoot,
  isSpaFallbackPath,
  registerStaticUi,
  type StaticUiOptions,
} from "./static-ui.js";

export {
  PipelineRegistry,
  start,
  type ProbeMap,
  type SelfOperatingRegistry,
  type StartDb,
  type StartedEngine,
  type StartOptions,
  type StartRedis,
  type StartServer,
} from "./start.js";

// Phase-a appendix #5 PR-M2 — agent dispatcher (production
// scheduler). The orchestrator (CLI `serve.ts`) imports
// `AgentDispatcher` + `AgentRunnerRegistry` to construct the
// per-agent runner map; the dispatcher itself is wired by `start()`
// when `agentRunners` is set on `StartOptions`.
export {
  AgentDispatcher,
  DISPATCH_QUEUE_NAME,
  type AgentDispatcherOptions,
  type AgentRunner,
  type AgentRunnerRegistry,
  type DispatchJobData,
  type RegisteredSchedule,
} from "./scheduler/agent-dispatcher.js";
export {
  validateCron,
  nextFireAt,
  type ValidateCronResult,
} from "./scheduler/cron-validate.js";

// Concrete reader agents (PR 20, plan #92 part A + plan #97
// part B). Read-only — every tool call flows through the
// harness; no agent in this PR registers a writer tool.
export {
  gatherSystemHealth,
  HEARTBEAT_DEFINITION,
  HEARTBEAT_OUTPUT_SCHEMA,
  runHeartbeat,
  type GatherSystemHealthArgs,
  type HeartbeatAlert,
  type HeartbeatOutput,
  type RunHeartbeatArgs,
  type SystemHealth,
  type SystemHealthWikiReader,
} from "./agents/heartbeat/index.js";

export {
  CHAT_DEFINITION,
  CHAT_OUTPUT_SCHEMA,
  ChatPatRequiredError,
  normalizeCallerPat,
  runChat,
  type ChatOutput,
  type RunChatArgs,
} from "./agents/chat/index.js";

// Surfacer + Builder + 3-gate automation loop (PR 21 / plan #102).
// Surfacer (Gate 1) emits proposed candidates; the Review
// Dashboard flips them to 'approved'; Builder (Gate 2) picks
// approved rows and deploys via AutomationAdapter (Gate 3 —
// type-level no-activation).
export {
  SURFACER_DEFINITION,
  SURFACER_OUTPUT_SCHEMA,
  runSurfacer,
  type RunSurfacerArgs,
  type RunSurfacerResult,
  type SurfacerCandidate,
  type SurfacerOutput,
} from "./agents/surfacer/index.js";

export {
  BUILDER_DEFINITION,
  BUILDER_OUTPUT_SCHEMA,
  runBuilder,
  type BuilderOutput,
  type RunBuilderArgs,
  type RunBuilderResult,
} from "./agents/builder/index.js";

export {
  BuilderGate2Error,
  insertCandidate,
  markBuilt,
  requireApproved,
  type AutomationCandidate,
  type InsertCandidateArgs,
} from "./automation-loop/index.js";

export {
  InMemoryAutomationAdapter,
  type AutomationAdapter,
  type CapturedDeployment,
  type DeployWorkflowArgs,
  type DeployWorkflowResult,
} from "./automation-adapter/index.js";

// Worldview compilation pipeline (PR 22 / plan #106). Per-domain
// + company-aggregator compilers with the load-bearing
// sovereignty pin (company-compile reads ONLY 'worldview.md'
// from non-aggregator domains) + 24KB token cap with 1 retry.
export {
  DEBOUNCE_DELAY_2_EVENTS_MS,
  DEBOUNCE_DELAY_3_EVENTS_MS,
  DEBOUNCE_DELAY_4_PLUS_EVENTS_MS,
  SOVEREIGN_AGGREGATOR_INPUT_PATH,
  SovereigntySpyWikiAdapter,
  TRIGGER_HIGH_DEBOUNCE_MS,
  TRIGGER_LOG_WINDOW,
  TRIGGER_MEDIUM_COUNT_THRESHOLD,
  TRIGGER_MEDIUM_MAX_AGE_MS,
  WORLDVIEW_BODY_MAX_BYTES,
  WORLDVIEW_COMPILE_JOB_NAME,
  WORLDVIEW_COMPILE_QUEUE_SLUG,
  WORLDVIEW_OUTPUT_SCHEMA,
  WorldviewOverflowError,
  WorldviewSovereigntyError,
  compileCompanyWorldview,
  compileDomainWorldview,
  decideWorldviewDebounce,
  freshDomainTriggerState,
  mintTriggerJobId,
  parseWorldviewImpactLines,
  runWorldviewTrigger,
  utf8ByteLength,
  type CompileCompanyArgs,
  type CompileCompanyResult,
  type CompileDomainArgs,
  type CompileDomainResult,
  type DomainCommitsReader,
  type DomainTriggerState,
  type RunWorldviewTriggerArgs,
  type RunWorldviewTriggerResult,
  type SovereigntySpyOptions,
  type TriggerCommit,
  type TriggerDomain,
  type TriggerEnqueueRecord,
  type WorldviewCompileQueue,
  type WorldviewDebounceArgs,
  type WorldviewDebounceDecision,
  type WorldviewImpactLevel,
  type WorldviewOutput,
} from "./pipelines/worldview/index.js";

// PR-W1 (phase-a appendix #13) — worldview compiler worker. Closes
// G1 (compileDomainWorldview had no production caller). The CLI's
// production composition wires this into the worker pool.
export {
  SAFETY_NET_FANOUT_SENTINEL,
  buildWorldviewCompileHandler,
  runWorldviewCompile,
  startWorldviewCompileWorker,
  type RunWorldviewCompileArgs,
  type SafetyNetFanoutDomain,
  type StartWorldviewCompileWorkerArgs,
  type WorldviewCompileHandlerDeps,
  type WorldviewCompileJob,
  type WorldviewCompileResult,
  type WorldviewCompileTriggerType,
} from "./workers/worldview-compiler-worker.js";

// PR-W1 (phase-a appendix #13) — worldview composition bundle. The
// CLI orchestrator (`packages/cli/src/provision/production-composition.ts`)
// invokes `composeWorldviewBundle` once at engine boot to construct
// the queue + worker + safety-net cron in one shot, then threads
// `bundle.queue` into `start({ worldviewQueue })`.
export {
  WORLDVIEW_SAFETY_NET_CRON_DEFAULT,
  WORLDVIEW_SAFETY_NET_REPEAT_KEY,
  composeWorldviewBundle,
  type ComposeWorldviewBundleArgs,
  type WorldviewBundle,
} from "./composition/worldview-bundle.js";

export {
  AUTOMATION_DRIFT_WINDOW_DAYS,
  CONTRADICTIONS_OUTPUT_SCHEMA,
  CONTRADICTIONS_PAGE_CAP,
  LINT_DEFINITION,
  LINT_FINDING_KINDS,
  LINT_FINDING_SCHEMA,
  LINT_OUTPUT_SCHEMA,
  STALE_PAGES_DEFAULT_THRESHOLD_DAYS,
  WIKI_READ_PAGE_CONCURRENCY,
  currentLoaderPromptVersions,
  detectAutomationDrift,
  detectContradictions,
  detectOrphans,
  detectPromptVersionDrift,
  detectStalePages,
  detectWildcardBindings,
  runLint,
  runLintCore,
  type AutomationDriftArgs,
  type ContradictionsArgs,
  type LintFinding,
  type LintFindingKind,
  type LintOutput,
  type OrphansArgs,
  type PageBody,
  type PageNewestCitation,
  type PageNewestPromptVersion,
  type PromptVersionDriftArgs,
  type RunLintArgs,
  type RunLintCoreArgs,
  type StalePagesArgs,
  type ToolCallObservation,
  type WildcardBindingsInput,
} from "./agents/lint/index.js";

// Reader-agent tool wrappers — wiki.read_page / worldview.read /
// index.search adapters over McpToolClient.
export {
  indexSearch,
  wikiReadPage,
  worldviewRead,
  type IndexSearchArgs,
  type WikiReadPageArgs,
  type WorldviewReadArgs,
} from "./agents/tools/index.js";

// MCP tool-client surface (PR 20, plan #92 part A; PR-N3
// phase-a appendix #6 adds the static-bearer HTTP transport).
// v0.1 surface: port + in-memory fixture (tests) +
// HttpMcpToolClient (production). The PAT-scoped wrapper is
// reserved for the future Chat agent (phase-b). Per Q12, the
// in-memory fixture does NOT import gitea-mcp internals — it
// is a pure-data test double conforming to the same shape.
export {
  HttpMcpToolClient,
  InMemoryMcpToolClient,
  McpHttpError,
  McpResourceNotFoundError,
  createPatScopedMcpClient,
  type HttpMcpToolClientOptions,
  type McpHttpErrorOptions,
  type McpListFilter,
  type McpToolClient,
  type PatScopedAuditEntry,
  type PatScopedMcpToolClient,
} from "./mcp-tool-client/index.js";

// Output-channel surface (PR 20, plan #92 part A). The Heartbeat
// + Lint agents return JSON; the engine's post-run hook routes
// the payload through this registry. The registry enforces the
// per-instance `outputChannelIds[]` binding so a prompt-injection
// attack on the agent cannot redirect delivery (Q10).
export {
  MockOutputChannelAdapter,
  OutputChannelDisabledError,
  OutputChannelLookupError,
  OutputChannelMismatchError,
  OutputChannelMissingChannelIdError,
  OutputChannelRegistry,
  OutputChannelUnknownAdapterError,
  outputAdapterToChannelAdapter,
  type CapturedDelivery,
  type LookupOutputChannel,
  type MergePayload,
  type OutputAdapterToChannelAdapterArgs,
  type OutputChannelAdapter,
  type OutputChannelBinding,
  type OutputChannelDeliverArgs,
  type OutputChannelDelivery,
  type OutputChannelDeliverInvocation,
  type OutputChannelRecord,
} from "./output-channels/index.js";

// PR-Z4 (phase-a appendix #12 G5) — output-channels CRUD route
// descriptor types + validator builder. The composition root
// constructs the per-adapter descriptor (one per OutputAdapter
// package) and threads the map into `registerAdminApi({
// outputChannelRegistry })`. Re-exported here so the CLI doesn't
// reach into the engine's internal admin-api routes path.
export {
  buildOutputAdapterValidator,
  getOutputAdapterListEntries,
  type OutputAdapterDescriptor,
  type OutputAdapterListEntry,
  type OutputAdapterSlug,
} from "./admin-api/routes/output-channels.js";

// Agent harness surface (PR 19, plan #87). The composition root
// (PR 30 CLI) wires concrete agents (PR 20+) onto this harness.
export {
  AgentDefinitionRegistry,
  AgentDenyListError,
  AgentInstanceNotFoundError,
  AgentRunAlreadyTerminalError,
  EXACT_DENY_TOOLS,
  DENY_PREFIXES,
  assertToolAllowed,
  completeRun,
  invokeAgent,
  isDenied,
  loadInstanceById,
  loadInstanceBySlugAndName,
  loadInstanceMemory,
  startRun,
  syncDefinitions,
  type AgentDefinition,
  type AgentInstance,
  type AgentInvocation,
  type AgentInvocationResult,
  type AgentRunContext,
  type AgentTrigger,
  type CompleteRunArgs,
  type ErrorClass,
  type InstanceMemory,
  type MemoryEntry,
  type StartRunArgs,
  type StartRunResult,
  type SyncDefinitionsArgs,
  type SyncDefinitionsDb,
  type TerminalStatus,
} from "./agent-harness/index.js";
