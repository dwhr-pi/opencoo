/**
 * Heartbeat agent output schema. The LLM returns this exact
 * shape via `router.generateObject`; Zod-strict parses fail-
 * closed as `LlmProviderError(validation)` → DLQ.
 *
 * Invariants enforced by the schema (architecture §9.4):
 *   - At most 5 alerts. Quality over quantity; an empty array
 *     is a valid "nothing to surface" day.
 *   - Lead with priority-1 — index 0 must carry priority=1.
 *   - Every alert cites at least one wiki path. An alert
 *     without a citation is unverifiable.
 */
import { z } from "zod";

export const HEARTBEAT_ALERT_SCHEMA = z
  .object({
    priority: z.number().int().min(1).max(5),
    // Caps match the en + pl heartbeat prompts. `title ≤80`
    // is the prompt's stated bound; body is 2-3 sentences per
    // prompt but sentence-count isn't enforced at the schema
    // layer — only non-empty.
    title: z.string().min(1).max(80),
    body: z.string().min(1),
    citations: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const HEARTBEAT_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    // 200-char cap matches the en + pl prompt body's stated
    // bound for the executive-summary line. A wider schema
    // would let a verbose LLM payload through; downstream
    // channel renderers expect the cap.
    summary: z.string().min(1).max(200),
    // `summary_kind` (PR-W6, phase-a appendix #14) is an
    // OPTIONAL soft signal: 'operational' when the LLM drew
    // alerts from the system-health envelope on a sparsely-
    // populated wiki, 'synthesis' when it leaned on compiled
    // wiki pages. The transformer doesn't branch on it today;
    // it's persisted into `agent_runs.output` for v2 telemetry
    // (e.g. surfacing the operational/synthesis ratio on the
    // Heartbeat tile). Optional + additive so the existing
    // transformer + Asana payload keep working unchanged.
    summary_kind: z.enum(["operational", "synthesis"]).optional(),
    alerts: z.array(HEARTBEAT_ALERT_SCHEMA).max(5),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.alerts.length > 0 && val.alerts[0]!.priority !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alerts", 0, "priority"],
        message:
          "first alert must be priority=1 — heartbeat leads with priority-1 (architecture §9.4)",
      });
    }
  });

export type HeartbeatAlert = z.infer<typeof HEARTBEAT_ALERT_SCHEMA>;
export type HeartbeatOutput = z.infer<typeof HEARTBEAT_OUTPUT_SCHEMA>;
