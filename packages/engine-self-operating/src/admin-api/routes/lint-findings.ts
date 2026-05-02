/**
 * Review Dashboard — lint findings (PR 28 / plan #128, item
 * type 2 of THREAT-MODEL §7.3).
 *
 * Per planner Q6: there is NO `lint_findings` table. Findings
 * live in `agent_runs.output` jsonb on Lint runs (definition_slug
 * = 'lint'). The route reads the most recent succeeded Lint run
 * per domain and unpacks its `output.findings` array.
 *
 * Acknowledgement is audit-only: there is no `lint_findings`
 * table to update. Writing a `lint_finding.acknowledge` audit
 * row is the correct primitive — findings are re-emitted each
 * Lint cycle; the ack is a human triage signal, not a permanent
 * state transition. The GET annotates each finding with
 * `acknowledgedAt` by joining against the audit log.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface LintFinding {
  readonly kind: string;
  readonly path: string;
  readonly detail: string;
  /** ISO timestamp of the most-recent acknowledgement, or null. */
  readonly acknowledgedAt: string | null;
}

const ackBodySchema = z
  .object({
    findingId: z.string().min(1),
    note: z.string().max(2000).optional(),
  })
  .strict();

export interface RegisterLintFindingsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
}

export function registerLintFindingsRoutes(
  args: RegisterLintFindingsRoutesArgs,
): void {
  args.app.get("/api/admin/lint-findings", async () => {
    // Pull the latest succeeded Lint run per agent_instance.
    // The detector orchestrator (PR 20A) writes one row per
    // Lint cycle; we surface the latest one's findings.
    const result = (await args.db.execute(sql`
      SELECT id::text AS id,
             instance_id::text AS instance_id,
             output,
             ended_at
      FROM agent_runs
      WHERE definition_slug = 'lint'
        AND status = 'success'
        AND output IS NOT NULL
      ORDER BY ended_at DESC NULLS LAST
      LIMIT 50
    `)) as unknown as {
      rows: Array<{
        id: string;
        instance_id: string | null;
        output: { findings?: unknown } | null;
        ended_at: Date | string | null;
      }>;
    };

    // Pull ack rows from the audit log so we can annotate findings
    // with acknowledgedAt. We look for all lint_finding.acknowledge
    // rows and index them by (run_id, finding_id) composite key
    // stored in metadata.
    const ackResult = (await args.db.execute(sql`
      SELECT metadata,
             created_at
      FROM admin_audit_log
      WHERE action = 'lint_finding.acknowledge'
      ORDER BY created_at DESC
      LIMIT 1000
    `)) as unknown as {
      rows: Array<{
        metadata: Record<string, unknown>;
        created_at: Date | string;
      }>;
    };

    // Build a lookup: `${runId}:${findingId}` → ISO timestamp of
    // most-recent ack. The query is ordered DESC so the first hit
    // per composite key is the latest.
    const ackMap = new Map<string, string>();
    for (const row of ackResult.rows) {
      const runId = row.metadata["run_id"] as string | undefined;
      const findingId = row.metadata["finding_id"] as string | undefined;
      if (typeof runId === "string" && typeof findingId === "string") {
        const key = `${runId}:${findingId}`;
        if (!ackMap.has(key)) {
          const ts =
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : new Date(row.created_at).toISOString();
          ackMap.set(key, ts);
        }
      }
    }

    const out: Array<{
      readonly runId: string;
      readonly instanceId: string | null;
      readonly endedAt: string | null;
      readonly findings: readonly LintFinding[];
    }> = [];
    for (const r of result.rows) {
      const findings: LintFinding[] = [];
      const rawFindings = r.output?.findings;
      if (Array.isArray(rawFindings)) {
        for (const f of rawFindings) {
          if (
            typeof f === "object" &&
            f !== null &&
            typeof (f as { kind?: unknown }).kind === "string" &&
            typeof (f as { path?: unknown }).path === "string" &&
            typeof (f as { detail?: unknown }).detail === "string"
          ) {
            // Build a deterministic finding ID from kind + path.
            // This is the same key the UI sends in the ack body.
            const findingId = `${(f as { kind: string }).kind}:${(f as { path: string }).path}`;
            const ackKey = `${r.id}:${findingId}`;
            findings.push({
              kind: (f as { kind: string }).kind,
              path: (f as { path: string }).path,
              detail: (f as { detail: string }).detail,
              acknowledgedAt: ackMap.get(ackKey) ?? null,
            });
          }
        }
      }
      out.push({
        runId: r.id,
        instanceId: r.instance_id,
        endedAt:
          r.ended_at === null
            ? null
            : r.ended_at instanceof Date
              ? r.ended_at.toISOString()
              : new Date(r.ended_at).toISOString(),
        findings,
      });
    }
    return { runs: out };
  });

  // Acknowledge a lint finding — audit-only. Findings live in
  // agent_runs.output jsonb and are re-emitted each Lint cycle;
  // the ack is a human triage signal stored in the audit log.
  // The GET annotates each finding with acknowledgedAt by joining
  // against this audit trail.
  args.app.post(
    "/api/admin/lint-findings/:runId/acknowledge",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const runId = (req.params as { runId: string }).runId;
      if (!z.string().uuid().safeParse(runId).success) {
        return reply.code(400).send({ error: "invalid_run_id" });
      }
      const parsed = ackBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const { findingId, note } = parsed.data;

      // Verify the run exists before writing the ack row.
      const runCheck = (await args.db.execute(sql`
        SELECT id FROM agent_runs
        WHERE id = ${runId}::uuid
          AND definition_slug = 'lint'
        LIMIT 1
      `)) as unknown as { rows: Array<{ id: string }> };
      if (runCheck.rows[0] === undefined) {
        return reply.code(404).send({ error: "run_not_found", runId });
      }

      await writeAuditLog(args.db, {
        action: "lint_finding.acknowledge",
        userId: ctx.userId,
        metadata: {
          run_id: runId,
          finding_id: findingId,
          caller_username: ctx.username,
          ...(note !== undefined ? { note } : {}),
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({ ok: true, runId, findingId });
    },
  );
}
