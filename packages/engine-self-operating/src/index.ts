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
  HEARTBEAT_DEFINITION,
  HEARTBEAT_OUTPUT_SCHEMA,
  runHeartbeat,
  type HeartbeatAlert,
  type HeartbeatOutput,
  type RunHeartbeatArgs,
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
  WORLDVIEW_BODY_MAX_BYTES,
  WORLDVIEW_OUTPUT_SCHEMA,
  WorldviewOverflowError,
  WorldviewSovereigntyError,
  compileCompanyWorldview,
  compileDomainWorldview,
  decideWorldviewDebounce,
  utf8ByteLength,
  type CompileCompanyArgs,
  type CompileCompanyResult,
  type CompileDomainArgs,
  type CompileDomainResult,
  type SovereigntySpyOptions,
  type WorldviewDebounceArgs,
  type WorldviewDebounceDecision,
  type WorldviewOutput,
} from "./pipelines/worldview/index.js";

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

// MCP tool-client surface (PR 20, plan #92 part A). v0.1 ships
// only the port + an in-memory test fixture; production
// `HttpMcpToolClient` arrives in PR 23+. Per Q12, the in-memory
// fixture does NOT import gitea-mcp internals — it is a pure
// data test double conforming to the same shape.
export {
  InMemoryMcpToolClient,
  McpResourceNotFoundError,
  createPatScopedMcpClient,
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
  OutputChannelMismatchError,
  OutputChannelRegistry,
  OutputChannelUnknownAdapterError,
  type CapturedDelivery,
  type OutputChannelAdapter,
  type OutputChannelBinding,
  type OutputChannelDeliverArgs,
  type OutputChannelDelivery,
  type OutputChannelDeliverInvocation,
} from "./output-channels/index.js";

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
