/**
 * Public surface for the Heartbeat agent. The composition root
 * (PR 30 CLI) registers the definition with the
 * AgentDefinitionRegistry and wires the body via
 * `invokeAgent({ run: ctx => runHeartbeat(ctx, ...) })`.
 */
export { HEARTBEAT_DEFINITION } from "./definition.js";
export { runHeartbeat, type RunHeartbeatArgs } from "./run.js";
export {
  gatherSystemHealth,
  type GatherSystemHealthArgs,
  type SystemHealth,
  type WikiReader as SystemHealthWikiReader,
} from "./system-health.js";
export {
  HEARTBEAT_ALERT_SCHEMA,
  HEARTBEAT_OUTPUT_SCHEMA,
  type HeartbeatAlert,
  type HeartbeatOutput,
} from "./types.js";
