/**
 * LLM usage-debug read route (PR-W7a, phase-a appendix #15).
 *
 *   GET /api/admin/llm-usage-debug?promptName=<name>&domainId=<uuid>&limit=<int<=10>
 *
 * Returns the N most-recent `llm_usage_debug` rows joined with
 * `llm_usage` for `(prompt_name, domain_id)`, mapped to
 * `{usageId, createdAt, promptTextTruncated, modelSlug}`. The
 * Prompts UI's "what was actually sent" drawer reads this to
 * show the operator the exact prompt body that the most-recent
 * runs assembled.
 *
 * `llm_usage` has no explicit `prompt_name` column; the engine
 * passes the prompt-loader's `name` value into `pipeline_or_agent`
 * for the call sites that route through `llm-router` (classifier,
 * compiler, heartbeat, lint, chat, surfacer, builder). The route
 * filters either exact match OR `pipeline_or_agent` LIKE
 * `<promptName>-%` so a future caller that suffixes the agent
 * value (the only existing case is `compiler-asana-project`)
 * still surfaces under the parent prompt.
 *
 * Threat-model:
 *   - admin-team gated (verifyAdmin runs at the wrapping
 *     `guardedApp`).
 *   - No CSRF (read-only).
 *   - `prompt_text` returns spotlighted page content. The
 *     operator can read every page anyway; the route is gated
 *     behind `LLM_DEBUG_LOG=1` env to keep it off-by-default in
 *     production. When the env is off the route returns `{rows:
 *     [], hint: "LLM_DEBUG_LOG=1 not set on this deployment"}`
 *     so the UI can render an empty banner instead of a 404.
 *   - 50 KB truncation cap on `prompt_text` (defense against an
 *     operator browser tab loading a 100 KB body × 10 rows = 1 MB
 *     payload).
 *   - UUID-validate `domainId` before SQL cast (mirrors the
 *     prompt-overrides route pattern).
 *   - `promptName` validated against `PROMPT_NAMES` BEFORE any
 *     DB read.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { PROMPT_NAMES } from "@opencoo/shared/prompts";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const TRUNCATION_BYTES = 50_000;
const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;

const querySchema = z
  .object({
    promptName: z.enum(PROMPT_NAMES as unknown as [string, ...string[]]),
    domainId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export interface RegisterLlmUsageDebugRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** Whether `LLM_DEBUG_LOG=1` is set at boot. When false the
   *  route short-circuits to an empty response with a hint so
   *  the UI can render an "off-by-default" banner. */
  readonly llmDebugLog: boolean;
}

interface DebugRow {
  readonly usageId: string;
  readonly createdAt: string;
  readonly promptTextTruncated: string;
  readonly modelSlug: string;
}

/** UTF-8-byte-aware truncation. Walks the original string's
 *  code points and accumulates the UTF-8 byte length, returning
 *  the longest prefix that fits within `maxBytes`. This avoids
 *  the decoder-replacement-character ambiguity of cutting the
 *  byte buffer first: a prompt that legitimately ends with
 *  U+FFFD would otherwise have those bytes silently stripped
 *  by the decoder fix-up step (Copilot triage on PR #149). */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let cumulative = 0;
  let cut = 0;
  for (const cp of s) {
    const cpBytes = Buffer.byteLength(cp, "utf8");
    if (cumulative + cpBytes > maxBytes) break;
    cumulative += cpBytes;
    cut += cp.length;
  }
  return s.slice(0, cut);
}

export function registerLlmUsageDebugRoutes(
  args: RegisterLlmUsageDebugRoutesArgs,
): void {
  args.app.get("/api/admin/llm-usage-debug", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_failed",
        issues: parsed.error.issues,
      });
    }
    if (!args.llmDebugLog) {
      return reply.code(200).send({
        rows: [] as ReadonlyArray<DebugRow>,
        hint: "LLM_DEBUG_LOG=1 not set on this deployment",
      });
    }
    const { promptName, domainId, limit } = parsed.data;

    // `pipeline_or_agent` carries the prompt-loader `name` value
    // for every call site that routes through the LLM router.
    // A few call sites suffix it (e.g. `compiler-asana-project`);
    // the LIKE half captures those without false-positiving onto
    // unrelated prefixes — we anchor the match to `<name>-`.
    const result = (await args.db.execute(sql`
      SELECT
        d.usage_id::text AS usage_id,
        d.created_at AS created_at,
        d.prompt_text AS prompt_text,
        u.model AS model
      FROM llm_usage_debug d
      JOIN llm_usage u ON u.id = d.usage_id
      WHERE u.domain_id = ${domainId}::uuid
        AND (
          u.pipeline_or_agent = ${promptName}
          OR u.pipeline_or_agent LIKE ${promptName + "-%"}
        )
      ORDER BY d.created_at DESC
      LIMIT ${limit}
    `)) as unknown as {
      rows: Array<{
        usage_id: string;
        created_at: string | Date;
        prompt_text: string;
        model: string;
      }>;
    };

    const rows: ReadonlyArray<DebugRow> = result.rows.map((r) => ({
      usageId: r.usage_id,
      createdAt:
        typeof r.created_at === "string"
          ? r.created_at
          : r.created_at.toISOString(),
      promptTextTruncated: truncateUtf8(r.prompt_text, TRUNCATION_BYTES),
      modelSlug: r.model,
    }));

    return reply.code(200).send({ rows });
  });
}
