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

// PR-W4 (phase-a appendix #15) — agent-instance lifecycle + scope editing.

const localeSchema = z.enum(["en", "pl", "auto"]);
const nameSchema = z.string().min(1).max(100);
const definitionSlugSchema = z.string().min(1).max(100);
/** Scope arrays cap at 20 entries — operationally there's never
 *  a real need to scope a single instance to more than a handful
 *  of domains, and capping at write-time keeps the audit metadata
 *  bounded. */
const scopeArraySchema = z.array(uuidSchema).min(1).max(20);

const setScopeSchema = z
  .object({
    scope_domain_ids: scopeArraySchema,
  })
  .strict();

const setNameSchema = z
  .object({
    name: nameSchema,
  })
  .strict();

const setLocaleSchema = z
  .object({
    locale: localeSchema,
  })
  .strict();

/** Memory-clear is a literal-true flag — there is no "clear to
 *  a specific value" semantic. The route zeroes `memory` to
 *  `{}::jsonb`; the agent harness re-seeds from scratch on the
 *  next run. */
const memoryClearSchema = z
  .object({
    memory_clear: z.literal(true),
  })
  .strict();

const createSchema = z
  .object({
    definition_slug: definitionSlugSchema,
    name: nameSchema,
    scope_domain_ids: scopeArraySchema,
    locale: localeSchema.default("en"),
    schedule_cron: z.string().min(1).max(120).nullable().default(null),
    output_channel_ids: z.array(uuidSchema).max(20).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

/** PR-W2 — the route accepts EXACTLY one of seven intents per
 *  request (3 wave-13 PR-W2 branches + 4 wave-15 PR-W4 branches).
 *  We don't use a Zod discriminated union because we need to
 *  distinguish "valid single-branch" from "mixed body" (multiple
 *  branches in one payload → 400) and emit a clean error code. */
const PATCH_KEYS = [
  "output_channel_ids",
  "enabled",
  "schedule_cron",
  "scope_domain_ids",
  "name",
  "locale",
  "memory_clear",
] as const;
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

  // POST — create a new agent_instances row (PR-W4, phase-a
  // appendix #15). Mirror of the wave-12 PR-Z9 POST domain
  // shape: CSRF + admin-team gated, single-INSERT, returns the
  // new row's id + the canonical fields the UI needs to refresh
  // its list without a re-fetch.
  args.app.post(
    "/api/admin/agent-instances",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const body = parsed.data;

      // Dedupe-check FIRST so the POST surface matches the PATCH
      // scope_domain_ids branch (Copilot triage #1 on PR #143).
      // A duplicate UUID in the array would persist verbatim into
      // the uuid[] column and confuse the resolver downstream.
      const seenScope = new Set<string>();
      const scopeDupes: string[] = [];
      for (const sid of body.scope_domain_ids) {
        if (seenScope.has(sid)) {
          if (!scopeDupes.includes(sid)) scopeDupes.push(sid);
        } else {
          seenScope.add(sid);
        }
      }
      if (scopeDupes.length > 0) {
        return reply.code(422).send({
          error: "duplicate_scope_domain_ids",
          duplicates: scopeDupes,
        });
      }

      // Validate every scope_domain_id resolves to an existing
      // domain row. One IN(...) SELECT; 422 with the missing
      // list if any dangle. Mirrors the output-channel resolve
      // pattern in the PATCH bind_outputs branch.
      const scopeIdParams = sql.join(
        body.scope_domain_ids.map((sid) => sql`${sid}::uuid`),
        sql`, `,
      );
      const scopeResolved = (await args.db.execute(sql`
        SELECT id::text AS id FROM domains WHERE id IN (${scopeIdParams})
      `)) as unknown as { rows: Array<{ id: string }> };
      const foundDomains = new Set(scopeResolved.rows.map((r) => r.id));
      const missingDomains = body.scope_domain_ids.filter(
        (sid) => !foundDomains.has(sid),
      );
      if (missingDomains.length > 0) {
        return reply.code(422).send({
          error: "unknown_scope_domain_ids",
          missing: missingDomains,
        });
      }

      // Validate every output_channel_id resolves. Same shape as
      // the PATCH bind_outputs branch — duplicate-id check + IN
      // SELECT + 422 with missing list.
      let resolvedChannels: Array<{ id: string; adapter_slug: string }> = [];
      if (body.output_channel_ids.length > 0) {
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const cid of body.output_channel_ids) {
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
        const channelIdParams = sql.join(
          body.output_channel_ids.map((cid) => sql`${cid}::uuid`),
          sql`, `,
        );
        const r = (await args.db.execute(sql`
          SELECT id::text AS id, adapter_slug
          FROM output_channels
          WHERE id IN (${channelIdParams})
        `)) as unknown as {
          rows: Array<{ id: string; adapter_slug: string }>;
        };
        resolvedChannels = r.rows;
        const foundChannels = new Set(resolvedChannels.map((rr) => rr.id));
        const missingChannels = body.output_channel_ids.filter(
          (cid) => !foundChannels.has(cid),
        );
        if (missingChannels.length > 0) {
          return reply.code(422).send({
            error: "unknown_output_channel_ids",
            missing: missingChannels,
          });
        }
      }

      // Schedule cron validation BEFORE the INSERT (parity with
      // the PATCH set_schedule branch) so an invalid pattern
      // can't pollute the dispatcher's next reload.
      if (body.schedule_cron !== null) {
        const cronCheck = validateCron(body.schedule_cron);
        if (!cronCheck.valid) {
          return reply.code(422).send({
            error: "invalid_cron",
            reason: cronCheck.error ?? "cron-parser rejected the pattern",
          });
        }
      }

      // 409 on name collision within (definition_slug, name).
      // The schema's UNIQUE constraint would surface as 500
      // otherwise. Pre-check + clean error code.
      const collide = (await args.db.execute(sql`
        SELECT id::text AS id FROM agent_instances
        WHERE definition_slug = ${body.definition_slug}
          AND name = ${body.name}
        LIMIT 1
      `)) as unknown as { rows: Array<{ id: string }> };
      if (collide.rows.length > 0) {
        return reply.code(409).send({
          error: "name_collision",
          definition_slug: body.definition_slug,
          name: body.name,
        });
      }

      const slugByChannel = new Map(
        resolvedChannels.map((rr) => [rr.id, rr.adapter_slug]),
      );
      const bindings = body.output_channel_ids.map((cid) => ({
        adapter_slug: slugByChannel.get(cid)!,
        config: { channel_id: cid },
      }));
      const bindingsJson = JSON.stringify(bindings);
      const scopeArrayLiteral = sql.join(
        body.scope_domain_ids.map((sid) => sql`${sid}::uuid`),
        sql`, `,
      );

      // Audit row written BEFORE the INSERT. instance_id field is
      // populated AFTER from RETURNING — we keep `instance_id`
      // null at audit-write time and reconcile via the RETURNING
      // id in a metadata UPDATE if the operator needs forensic
      // continuity. Simpler: write the audit AFTER the INSERT with
      // RETURNING (the row exists either way; a crashed INSERT
      // means no audit row, which is what we want).
      const inserted = (await args.db.execute(sql`
        INSERT INTO agent_instances
          (definition_slug, name, scope_domain_ids, output_channel_ids,
           schedule_cron, locale, enabled)
        VALUES
          (${body.definition_slug}, ${body.name},
           ARRAY[${scopeArrayLiteral}]::uuid[],
           ${bindingsJson}::jsonb,
           ${body.schedule_cron}, ${body.locale}, ${body.enabled})
        RETURNING id::text AS id, definition_slug, name,
                  scope_domain_ids, output_channel_ids,
                  schedule_cron, locale, enabled
      `)) as unknown as {
        rows: Array<{
          id: string;
          definition_slug: string;
          name: string;
          scope_domain_ids: ReadonlyArray<string>;
          output_channel_ids: ReadonlyArray<{
            adapter_slug: string;
            config: Record<string, unknown>;
          }>;
          schedule_cron: string | null;
          locale: string;
          enabled: boolean;
        }>;
      };
      const row = inserted.rows[0];
      if (row === undefined) {
        return reply.code(500).send({ error: "insert_returned_no_row" });
      }

      await writeAuditLog(args.db, {
        action: "agent_instance.create",
        userId: ctx.userId,
        metadata: {
          instance_id: row.id,
          definition_slug: row.definition_slug,
          name: row.name,
          scope_domain_ids: [...row.scope_domain_ids],
          locale: row.locale,
          enabled: row.enabled,
          output_channel_ids: body.output_channel_ids,
          schedule_cron: row.schedule_cron,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(201).send({
        id: row.id,
        definitionSlug: row.definition_slug,
        name: row.name,
        scopeDomainIds: [...row.scope_domain_ids],
        outputChannelIds: [...row.output_channel_ids],
        scheduleCron: row.schedule_cron,
        locale: row.locale,
        enabled: row.enabled,
      });
    },
  );

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
      if (presentKeys[0] === "schedule_cron") {
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
      }

      // Branch 4 (PR-W4): scope_domain_ids replacement.
      if (presentKeys[0] === "scope_domain_ids") {
        const parsed = setScopeSchema.safeParse(body);
        if (!parsed.success) {
          return reply.code(422).send({
            error: "validation_failed",
            issues: parsed.error.issues,
          });
        }
        const ids = parsed.data.scope_domain_ids;
        // Deduplicate-check + exists-check, mirroring the
        // bind_outputs branch.
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const sid of ids) {
          if (seen.has(sid)) {
            if (!dupes.includes(sid)) dupes.push(sid);
          } else {
            seen.add(sid);
          }
        }
        if (dupes.length > 0) {
          return reply.code(422).send({
            error: "duplicate_scope_domain_ids",
            duplicates: dupes,
          });
        }
        const idParams = sql.join(
          ids.map((sid) => sql`${sid}::uuid`),
          sql`, `,
        );
        const resolved = (await args.db.execute(sql`
          SELECT id::text AS id FROM domains WHERE id IN (${idParams})
        `)) as unknown as { rows: Array<{ id: string }> };
        const found = new Set(resolved.rows.map((r) => r.id));
        const missing = ids.filter((sid) => !found.has(sid));
        if (missing.length > 0) {
          return reply.code(422).send({
            error: "unknown_scope_domain_ids",
            missing,
          });
        }

        await writeAuditLog(args.db, {
          action: "agent_instance.set_scope",
          userId: ctx.userId,
          metadata: {
            instance_id: id,
            scope_domain_ids: ids,
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });

        const scopeArray = sql.join(
          ids.map((sid) => sql`${sid}::uuid`),
          sql`, `,
        );
        await args.db.execute(sql`
          UPDATE agent_instances
          SET scope_domain_ids = ARRAY[${scopeArray}]::uuid[],
              updated_at = NOW()
          WHERE id = ${id}::uuid
        `);
        return reply.code(200).send({ updated: true });
      }

      // Branch 5 (PR-W4): name rename.
      if (presentKeys[0] === "name") {
        const parsed = setNameSchema.safeParse(body);
        if (!parsed.success) {
          return reply.code(422).send({
            error: "validation_failed",
            issues: parsed.error.issues,
          });
        }
        const nextName = parsed.data.name;
        if (nextName === prior.name) {
          // No-op resend — return 200 noOp without writing audit.
          return reply.code(200).send({ updated: false, noOp: true });
        }
        // Uniqueness within (definition_slug, name) — 409.
        const collide = (await args.db.execute(sql`
          SELECT id::text AS id FROM agent_instances
          WHERE definition_slug = ${prior.definition_slug}
            AND name = ${nextName}
            AND id <> ${id}::uuid
          LIMIT 1
        `)) as unknown as { rows: Array<{ id: string }> };
        if (collide.rows.length > 0) {
          return reply.code(409).send({
            error: "name_collision",
            definition_slug: prior.definition_slug,
            name: nextName,
          });
        }
        await writeAuditLog(args.db, {
          action: "agent_instance.set_name",
          userId: ctx.userId,
          metadata: {
            instance_id: id,
            name: nextName,
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });
        await args.db.execute(sql`
          UPDATE agent_instances
          SET name = ${nextName}, updated_at = NOW()
          WHERE id = ${id}::uuid
        `);
        return reply.code(200).send({ updated: true });
      }

      // Branch 6 (PR-W4): locale flip.
      if (presentKeys[0] === "locale") {
        const parsed = setLocaleSchema.safeParse(body);
        if (!parsed.success) {
          return reply.code(422).send({
            error: "validation_failed",
            issues: parsed.error.issues,
          });
        }
        const nextLocale = parsed.data.locale;
        await writeAuditLog(args.db, {
          action: "agent_instance.set_locale",
          userId: ctx.userId,
          metadata: {
            instance_id: id,
            locale: nextLocale,
            caller_username: ctx.username,
          },
          sourceIp: req.ip,
          userAgent: req.headers["user-agent"],
        });
        await args.db.execute(sql`
          UPDATE agent_instances
          SET locale = ${nextLocale}, updated_at = NOW()
          WHERE id = ${id}::uuid
        `);
        return reply.code(200).send({ updated: true });
      }

      // Branch 7 (PR-W4): memory_clear.
      const parsedMemory = memoryClearSchema.safeParse(body);
      if (!parsedMemory.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsedMemory.error.issues,
        });
      }
      // Read prior memory byte count BEFORE the wipe so the
      // audit trail records the wipe magnitude without
      // persisting the memory contents (which may include
      // spotlighted page bytes — THREAT-MODEL §3.13).
      const memorySize = (await args.db.execute(sql`
        SELECT octet_length(memory::text) AS bytes
        FROM agent_instances
        WHERE id = ${id}::uuid
      `)) as unknown as { rows: Array<{ bytes: number | string }> };
      const priorBytes = Number(memorySize.rows[0]?.bytes ?? 0);
      await writeAuditLog(args.db, {
        action: "agent_instance.memory_clear",
        userId: ctx.userId,
        metadata: {
          instance_id: id,
          prior_memory_byte_count: priorBytes,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });
      await args.db.execute(sql`
        UPDATE agent_instances
        SET memory = '{}'::jsonb, updated_at = NOW()
        WHERE id = ${id}::uuid
      `);
      return reply.code(200).send({ updated: true, priorBytes });
    },
  );
}
