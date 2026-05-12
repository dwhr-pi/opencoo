/**
 * Agent-instance admin routes — bind output channels, toggle
 * enabled, edit schedule (PR-W2, phase-a appendix #13 — closes G2).
 *
 * Wave-12 PR-Z4 shipped the OutputChannelRegistry + the
 * `output_channels` CRUD surface; the dispatcher's post-run
 * delivery hook iterates `agent_instances.output_channel_ids[]`.
 * What was missing: any way to populate that array from the UI.
 * PR-W2 ships:
 *
 *   - `GET  /api/admin/agent-instances` — read-only list for the
 *     new Agents tab. Capped at 200, newest-first, no CSRF.
 *   - `PATCH /api/admin/agent-instances/:id` — discriminated-
 *     union body: ONE of `output_channel_ids` | `enabled` |
 *     `schedule_cron`. Mixed bodies → 400 `mixed_patch_body`.
 *
 * Body branches:
 *   - `{output_channel_ids: string[]}` — replace the binding
 *     array. Each UUID must reference an existing
 *     `output_channels.id`; missing UUIDs surface 422 with
 *     `{error: "unknown_output_channel_ids", missing: [...]}`.
 *     The route stores the per-binding `{adapter_slug, config:
 *     {channel_id}}` shape verbatim — adapter_slug is resolved
 *     from the channel row, channel_id is the operator's UUID.
 *   - `{enabled: boolean}` — flip the boolean.
 *   - `{schedule_cron: string}` — set the cron pattern. The
 *     server validates the string via `cron-parser` BEFORE
 *     writing so a garbage value can't slip in and crash the
 *     dispatcher's next reload.
 *
 * Audit: ONE row written BEFORE the UPDATE per branch. Verbs
 * recorded:
 *   - `agent_instance.bind_outputs` — `output_channel_ids[]`
 *   - `agent_instance.set_enabled`  — enabled toggle
 *   - `agent_instance.set_schedule` — schedule_cron edit
 * Metadata carries instance_id (`binding_id` in the metadata
 * for cross-table familiarity) + the changed value + caller.
 * UUIDs only — no operator-supplied freeform text per
 * THREAT-MODEL §3.13.
 *
 * Auth: `verifyAdmin` from `makeGuardedApp` wraps every route;
 * mutating verbs additionally chain `requireCsrf`. Same shape
 * as `source-bindings.ts` PATCH.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

import { validateCron } from "../../scheduler/cron-validate.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

// ── Body schemas ──────────────────────────────────────────────────────────

const uuidSchema = z.string().uuid();

const bindOutputsSchema = z
  .object({
    output_channel_ids: z.array(uuidSchema),
  })
  .strict();

const setEnabledSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const setScheduleSchema = z
  .object({
    /** Cap at 120 chars — cron-parser handles 5-field
     *  patterns; longer values are either garbage or an
     *  attacker-supplied blob meant to slow the parser. */
    schedule_cron: z.string().min(1).max(120),
  })
  .strict();

/** PR-W2 — the route accepts EXACTLY one of three intents per
 *  request. We don't use a Zod discriminated union because we
 *  need to distinguish "valid single-branch" from "mixed body"
 *  (multiple branches in one payload → 400) and emit a clean
 *  error code. The handler inspects the keyset directly so the
 *  mixed-body error has the same fingerprint regardless of
 *  which keys appeared. */
const PATCH_KEYS = ["output_channel_ids", "enabled", "schedule_cron"] as const;
type PatchKey = (typeof PATCH_KEYS)[number];

// ── Row shapes ────────────────────────────────────────────────────────────

interface AgentInstanceRow {
  readonly id: string;
  readonly definition_slug: string;
  readonly name: string;
  readonly schedule_cron: string | null;
  readonly enabled: boolean;
  readonly output_channel_ids: ReadonlyArray<{
    readonly adapter_slug: string;
    readonly config: Record<string, unknown>;
  }> | null;
  readonly last_run_started_at: Date | string | null;
  readonly last_run_status: string | null;
}

/** Row the GET route returns to the UI. */
export interface AgentInstanceListRow {
  readonly id: string;
  readonly definitionSlug: string;
  readonly name: string;
  readonly scheduleCron: string | null;
  readonly enabled: boolean;
  /** Count of channels currently bound to this instance.
   *  Cheaper to surface than the full array — the Agents tab
   *  list only needs the count; the drill-down does the
   *  full fetch via `/api/admin/output-channels`. */
  readonly outputChannelCount: number;
  /** Verbatim binding array — needed by the drill-down so the
   *  multi-select can pre-check the currently-bound channels.
   *  Each entry carries the channel's UUID under
   *  `config.channel_id` (the route accepts a `string[]` of
   *  UUIDs on PATCH and constructs this object array
   *  server-side). */
  readonly outputChannelIds: ReadonlyArray<{
    readonly adapter_slug: string;
    readonly config: Record<string, unknown>;
  }>;
  readonly lastRunStartedAt: string | null;
  readonly lastRunStatus: string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ── Route registration ────────────────────────────────────────────────────

export interface RegisterAgentInstancesRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerAgentInstancesRoutes(
  args: RegisterAgentInstancesRoutesArgs,
): void {
  // GET — read-only list for the new Agents tab.
  args.app.get("/api/admin/agent-instances", async () => {
    // Per-row last-run lookup via a correlated sub-select on
    // `agent_runs` — same pattern source-bindings uses for
    // last_event_at. The output_channel_ids jsonb-length is a
    // straightforward `jsonb_array_length` cast.
    const result = (await args.db.execute(sql`
      SELECT ai.id::text                AS id,
             ai.definition_slug,
             ai.name,
             ai.schedule_cron,
             ai.enabled,
             ai.output_channel_ids,
             (
               SELECT ar.started_at
               FROM agent_runs ar
               WHERE ar.instance_id = ai.id
               ORDER BY ar.started_at DESC
               LIMIT 1
             ) AS last_run_started_at,
             (
               SELECT ar.status::text
               FROM agent_runs ar
               WHERE ar.instance_id = ai.id
               ORDER BY ar.started_at DESC
               LIMIT 1
             ) AS last_run_status
      FROM agent_instances ai
      ORDER BY ai.created_at DESC
      LIMIT 200
    `)) as unknown as { rows: AgentInstanceRow[] };

    const rows: AgentInstanceListRow[] = result.rows.map((r) => {
      const channels = r.output_channel_ids ?? [];
      return {
        id: r.id,
        definitionSlug: r.definition_slug,
        name: r.name,
        scheduleCron: r.schedule_cron,
        enabled: r.enabled,
        outputChannelCount: channels.length,
        outputChannelIds: channels,
        lastRunStartedAt: toIso(r.last_run_started_at),
        lastRunStatus: r.last_run_status,
      };
    });
    return { rows };
  });

  // PATCH — discriminated single-branch body.
  args.app.patch(
    "/api/admin/agent-instances/:id",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      if (!uuidSchema.safeParse(id).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }

      // Body must carry EXACTLY one of the three accepted keys.
      // We inspect the keyset directly so mixed bodies (e.g.
      // `{enabled, schedule_cron}`) surface a distinct error
      // code from the per-branch Zod validation.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const presentKeys = PATCH_KEYS.filter(
        (k): k is PatchKey => Object.prototype.hasOwnProperty.call(body, k),
      );
      if (presentKeys.length === 0) {
        return reply.code(422).send({
          error: "missing_patch_body",
          accepted_keys: PATCH_KEYS,
        });
      }
      if (presentKeys.length > 1) {
        return reply.code(400).send({
          error: "mixed_patch_body",
          present_keys: presentKeys,
          reason:
            "PATCH body must carry exactly one of output_channel_ids, enabled, schedule_cron",
        });
      }

      // Verify the instance exists. Single SELECT — every
      // branch below needs to know the row's prior state for
      // the audit row anyway, so we batch the lookup once.
      const existing = (await args.db.execute(sql`
        SELECT id::text                          AS id,
               definition_slug,
               name,
               schedule_cron,
               enabled,
               output_channel_ids
        FROM agent_instances
        WHERE id = ${id}::uuid
        LIMIT 1
      `)) as unknown as {
        rows: Array<{
          id: string;
          definition_slug: string;
          name: string;
          schedule_cron: string | null;
          enabled: boolean;
          output_channel_ids: ReadonlyArray<{
            adapter_slug: string;
            config: Record<string, unknown>;
          }> | null;
        }>;
      };
      const prior = existing.rows[0];
      if (prior === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }

      // Branch 1: bind output channels.
      if (presentKeys[0] === "output_channel_ids") {
        const parsed = bindOutputsSchema.safeParse(body);
        if (!parsed.success) {
          return reply.code(422).send({
            error: "validation_failed",
            issues: parsed.error.issues,
          });
        }
        const channelIds = parsed.data.output_channel_ids;

        // Reject duplicate UUIDs BEFORE the exists-check.
        // Without this the dispatcher would deliver to the same
        // channel multiple times per run; we go strict (422)
        // instead of silent dedupe so the operator notices they
        // double-clicked / double-typed. Copilot triage #3.
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const cid of channelIds) {
          if (seen.has(cid)) {
            if (!dupes.includes(cid)) dupes.push(cid);
          } else {
            seen.add(cid);
          }
        }
        if (dupes.length > 0) {
          return reply.code(422).send({
            error: "duplicate_output_channel_ids",
            duplicates: dupes,
          });
        }

        // Validate every UUID references an existing
        // output_channels row. One SELECT with IN(...). When
        // any miss → 422 + the full missing list so the UI can
        // surface which ids dangled.
        let resolvedRows: Array<{ id: string; adapter_slug: string }> = [];
        if (channelIds.length > 0) {
          const idParams = sql.join(
            channelIds.map((cid) => sql`${cid}::uuid`),
            sql`, `,
          );
          const r = (await args.db.execute(sql`
            SELECT id::text AS id, adapter_slug
            FROM output_channels
            WHERE id IN (${idParams})
          `)) as unknown as {
            rows: Array<{ id: string; adapter_slug: string }>;
          };
          resolvedRows = r.rows;
        }
        const found = new Set(resolvedRows.map((r) => r.id));
        const missing = channelIds.filter((cid) => !found.has(cid));
        if (missing.length > 0) {
          return reply.code(422).send({
            error: "unknown_output_channel_ids",
            missing,
          });
        }

        // Build the per-binding object shape the dispatcher
        // already consumes: `[{adapter_slug, config: {channel_id}}]`.
        // The bridge in production-composition.ts reads
        // `config.channel_id` at delivery time.
        // Preserve operator-supplied ordering so the binding's
        // delivery order is deterministic.
        const slugById = new Map(resolvedRows.map((r) => [r.id, r.adapter_slug]));
        const newBindings = channelIds.map((cid) => ({
          adapter_slug: slugById.get(cid)!,
          config: { channel_id: cid },
        }));

        // Audit BEFORE the UPDATE — same pattern as the rest
        // of the admin API. Captures the changed value (UUID
        // list only, never secret bytes) + caller_username.
        await writeAuditLog(args.db, {
          action: "agent_instance.bind_outputs",
          userId: ctx.userId,
          metadata: {
            binding_id: id,
            output_channel_ids: channelIds,
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });

        const bindingsJson = JSON.stringify(newBindings);
        await args.db.execute(sql`
          UPDATE agent_instances
          SET output_channel_ids = ${bindingsJson}::jsonb,
              updated_at = NOW()
          WHERE id = ${id}::uuid
        `);
        return reply.code(200).send({ updated: true });
      }

      // Branch 2: enabled toggle.
      if (presentKeys[0] === "enabled") {
        const parsed = setEnabledSchema.safeParse(body);
        if (!parsed.success) {
          return reply.code(422).send({
            error: "validation_failed",
            issues: parsed.error.issues,
          });
        }
        const next = parsed.data.enabled;

        await writeAuditLog(args.db, {
          action: "agent_instance.set_enabled",
          userId: ctx.userId,
          metadata: {
            binding_id: id,
            enabled: next,
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });

        await args.db.execute(sql`
          UPDATE agent_instances
          SET enabled = ${next}, updated_at = NOW()
          WHERE id = ${id}::uuid
        `);
        return reply.code(200).send({ updated: true });
      }

      // Branch 3: schedule_cron edit.
      const parsed = setScheduleSchema.safeParse(body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const cron = parsed.data.schedule_cron;
      const cronCheck = validateCron(cron);
      if (!cronCheck.valid) {
        return reply.code(422).send({
          error: "invalid_cron",
          reason: cronCheck.error ?? "cron-parser rejected the pattern",
        });
      }

      await writeAuditLog(args.db, {
        action: "agent_instance.set_schedule",
        userId: ctx.userId,
        metadata: {
          binding_id: id,
          schedule_cron: cron,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      await args.db.execute(sql`
        UPDATE agent_instances
        SET schedule_cron = ${cron}, updated_at = NOW()
        WHERE id = ${id}::uuid
      `);
      return reply.code(200).send({ updated: true });
    },
  );
}
