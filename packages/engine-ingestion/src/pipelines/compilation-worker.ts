/**
 * Compilation Worker (architecture §9 pipeline 2, plan #77,
 * extended in PR 26 / plan #122 with guard wiring + catalog-
 * workflow dispatch).
 *
 * Per-job flow (v0.1):
 *   1. Decode payload + look up the binding's allowed_paths +
 *      home domain + content-kind from `sources_bindings.config`.
 *   2. **Guard pass — UNCONDITIONAL** (plan #122 decision 1).
 *      Run `guardAdapter.classify({ text: content })` BEFORE the
 *      contentKind dispatch; the transformedText is what flows
 *      downstream. Every `events[]` entry becomes a row in
 *      `redaction_events` with the binding's domain_id +
 *      binding_id stamped on. Applies to BOTH document and
 *      n8n-workflow content.
 *   3. **Dispatch by contentKind**:
 *        - `'document'` (default) — classify (Worker tier) → if
 *          accepted, compile (Thinker tier). Multi-domain output
 *          → multiple compile() calls (each its own atomic
 *          wikiWrite commit).
 *        - `'n8n-workflow'` — parse the redacted content as JSON,
 *          route to `compileCatalogWorkflow` (deterministic, no
 *          LLM, single atomic wikiWrite). The home domain is
 *          the only target (catalog bindings are 1:1 with their
 *          home domain).
 *        - `'skill-bundle'` — reserved for phase-b (PR 33+).
 *          v0.1 throws on this branch.
 *   4. Mark the intake row classified.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { LlmRouter } from "@opencoo/shared/llm-router";
import { CONTENT_KINDS } from "@opencoo/shared/db";
import type {
  ContentKind,
  DomainId,
  SourceBindingId,
} from "@opencoo/shared/db";
import { isOpencooError, type ErrorClass } from "@opencoo/shared/errors";
import { safeErrorMessage } from "@opencoo/shared/scrub";
import type {
  WikiAuthor,
  WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import type { Logger } from "@opencoo/shared/logger";
import type {
  GuardAdapter,
  GuardEvent,
} from "@opencoo/shared/adapter-contract-tests/guard";

import { classify } from "../classifier/classifier.js";
import { compile } from "../compiler/compiler.js";
import {
  compileCatalogWorkflow,
  type CatalogWorkflowInput,
} from "../compiler/catalog-workflow.js";
import {
  compileAsanaProject,
  type AsanaProjectSnapshot,
} from "../compiler/asana-project.js";

import type { ScannerClassifyJob } from "./scanner.js";
import type {
  IngestionRunEventEmitter,
  IntakeFailedEvent,
} from "../workers/context.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface ExecResult<R> {
  readonly rows: R[];
  readonly rowCount?: number;
  readonly affectedRows?: number;
}

interface BindingMeta {
  readonly bindingId: string;
  readonly domainId: string;
  readonly domainSlug: string;
  readonly domainLocale: "en" | "pl" | "auto";
  readonly allowedPaths: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly contentKind: ContentKind;
}

export interface RunCompilationWorkerArgs {
  readonly db: Db;
  readonly logger: Logger;
  readonly router: LlmRouter;
  readonly wikiDeps: WikiWriteDeps;
  readonly author: WikiAuthor;
  readonly job: ScannerClassifyJob;
  /**
   * Guard adapter wired at composition root. Required as of PR
   * 26 — the worker invokes `guardAdapter.classify` on every job
   * before the contentKind dispatch, regardless of whether the
   * binding is a document or catalog binding.
   */
  readonly guardAdapter: GuardAdapter;
  /**
   * Optional SSE event emitter (PR-W4). When wired, the worker
   * publishes a `pipeline.intake_failed` event on every caught
   * failure AFTER the `markIntakeFailed` DB write succeeds. The
   * event carries the binding/intake ids + classified error + a
   * scrubbed, 200-char-capped error snippet so the Activity feed
   * can render the failure live without a polling round-trip.
   *
   * Optional so composition-incomplete shapes (tests, headless
   * CLI invocations) can run the worker without an SSE bus. The
   * emit is best-effort: a throw from `emitIntakeFailed` is logged
   * but does not mask the original worker error.
   */
  readonly sseBus?: IngestionRunEventEmitter;
}

export interface CompilationWorkerResult {
  readonly intakeId: string;
  /** For document branch: number of target domains the classifier
   *  routed into. For catalog branch: always 1 (the home domain). */
  readonly classifiedDomains: number;
  readonly commitsLanded: number;
}

/**
 * Truncation cap for `ingestion_intake.error_text`. Bounds the row
 * size and, transitively, the downstream LLM exposure when the
 * heartbeat system-health gatherer (PR-W6) reads recent failures
 * into the prompt. Matches the `LEFT($err.message, 1000)` policy
 * spelled out in `docs/plan-appendix/phase-a-14-meaningful-heartbeat.md`
 * §W3 threat-model.
 */
const ERROR_TEXT_CAP = 1000;

/**
 * Truncation cap for the SSE `pipeline.intake_failed` event's
 * `errorTextSnippet` (PR-W4). Tighter than the 1000-char DB cap
 * because the snippet is a live-render preview on the Activity feed
 * — operators just need a "what broke?" hint, not the full message.
 * The W4 admin-API GET handler applies the same 200-char cap at the
 * query (`LEFT(error_text, 200)`) so the panel + feed stay aligned.
 */
const ERROR_SNIPPET_CAP = 200;

/**
 * Persist a `failed` terminal state on the intake row with the
 * classified error metadata. Used by the worker's outer catch
 * before the throw bubbles to BullMQ — the BullMQ `failed` set
 * and the intake row must agree, or the operator loses
 * observability (see appendix #14 Layer B).
 *
 * Best-effort: a swallowed DB failure here would mask the real
 * cause of the worker failure, so any error from the UPDATE is
 * logged but not rethrown — the original error always wins.
 */
async function markIntakeFailed(args: {
  readonly db: Db;
  readonly logger: Logger;
  readonly intakeId: string;
  readonly errorClass: ErrorClass;
  readonly errorMessage: string;
}): Promise<void> {
  const truncated = args.errorMessage.slice(0, ERROR_TEXT_CAP);
  try {
    await args.db.execute(sql`
      UPDATE ingestion_intake
      SET status = 'failed',
          error_class = ${args.errorClass}::error_class,
          error_text = ${truncated}
      WHERE id = ${args.intakeId}::uuid
    `);
  } catch (updateErr) {
    // `safeErrorMessage` scrubs credential bytes (PAT-shaped tokens,
    // etc.) and caps to ERROR_MESSAGE_MAX_LENGTH before the message
    // reaches the structured logger — THREAT-MODEL §2 invariant 11 +
    // §3.6 invariant 11. The shared logger itself does not scrub;
    // every site that funnels an `Error.message` into a log payload
    // must call this helper (PR-W3 Copilot triage; pattern previously
    // codified across PR-N3/O2/O3/P3).
    args.logger.error("compilation_worker.mark_failed_update_error", {
      intake_id: args.intakeId,
      error_class: args.errorClass,
      message: safeErrorMessage(updateErr),
    });
  }
}

export async function runCompilationWorker(
  args: RunCompilationWorkerArgs,
): Promise<CompilationWorkerResult> {
  try {
    const meta = await loadBindingMeta(args.db, args.job.bindingId);
    if (meta === null) {
      throw new Error(
        `compilation-worker: binding ${args.job.bindingId} not found or disabled`,
      );
    }

    const rawContent = Buffer.from(args.job.contentBase64, "base64").toString(
      "utf8",
    );
    const fetchedAt = new Date(args.job.fetchedAt);

    // Step 2 — UNCONDITIONAL guard pass (plan #122 decision 1).
    // The transformedText is what every downstream branch sees.
    // Persist every emitted event as a redaction_events row stamped
    // with the binding's (domain_id, binding_id).
    const guardResult = await args.guardAdapter.classify({ text: rawContent });
    const content = guardResult.transformedText;
    if (guardResult.events.length > 0) {
      await persistRedactionEvents({
        db: args.db,
        pipeline: "compilation-worker",
        domainId: meta.domainId,
        bindingId: meta.bindingId,
        guardSlug: args.guardAdapter.slug,
        events: guardResult.events,
      });
      args.logger.info("compilation_worker.guard.events", {
        binding_id: meta.bindingId,
        domain_id: meta.domainId,
        event_count: guardResult.events.length,
        guard_slug: args.guardAdapter.slug,
      });
    }

    // Step 3 — dispatch by contentKind.
    let commitsLanded = 0;
    let classifiedDomains = 0;
    if (meta.contentKind === "n8n-workflow") {
      const workflow = parseN8nWorkflowContent(content, args.job.sourceRef);
      const result = await compileCatalogWorkflow({
        db: args.db,
        domainId: meta.domainId as DomainId,
        domainSlug: meta.domainSlug,
        bindingId: meta.bindingId as SourceBindingId,
        sourceRef: args.job.sourceRef,
        workflow,
        wikiDeps: args.wikiDeps,
        author: args.author,
      });
      classifiedDomains = 1;
      if (result.commitSha !== null) commitsLanded = 1;
    } else if (meta.contentKind === "asana-project") {
      const snapshot = parseAsanaProjectContent(content, args.job.sourceRef);
      const title = deriveAsanaProjectTitle(snapshot);
      const result = await compileAsanaProject({
        db: args.db,
        domainId: meta.domainId as DomainId,
        domainSlug: meta.domainSlug,
        bindingId: meta.bindingId as SourceBindingId,
        sourceRef: args.job.sourceRef,
        snapshot,
        title,
        wikiDeps: args.wikiDeps,
        router: args.router,
        author: args.author,
      });
      classifiedDomains = 1;
      if (result.commitSha !== null) commitsLanded = 1;
    } else if (meta.contentKind === "skill-bundle") {
      throw new Error(
        "compilation-worker: contentKind='skill-bundle' is reserved for phase-b (not implemented in v0.1)",
      );
    } else {
      // contentKind === 'document' — classic two-pass path.
      const classified = await classify({
        router: args.router,
        db: args.db,
        domainId: meta.domainId as DomainId,
        sourceRef: args.job.sourceRef,
        content,
        locale: meta.domainLocale,
        allowedPaths: meta.allowedPaths,
        allowedDomains: meta.allowedDomains,
        fetchedAt,
      });
      classifiedDomains = classified.targetDomains.length;
      for (const td of classified.targetDomains) {
        const result = await compile({
          router: args.router,
          db: args.db,
          domainId: meta.domainId as DomainId,
          domainSlug: td.domainSlug,
          bindingId: meta.bindingId as SourceBindingId,
          sourceRef: args.job.sourceRef,
          sourceContent: content,
          pagePaths: td.pagePaths,
          locale: meta.domainLocale,
          wikiDeps: args.wikiDeps,
          author: args.author,
        });
        if (result.commitSha !== null) commitsLanded += 1;
      }
    }

    // Clear error_class/error_text alongside the status flip so a
    // fail-then-retry-success sequence doesn't leave the row
    // self-contradictory (status='classified' AND error fields
    // populated). Without the clear, the W4 SourceBindingDetail
    // panel + W6 heartbeat system-health gatherer would surface
    // ghost failures on rows that actually succeeded on retry
    // (PR-W3 Copilot triage).
    await args.db.execute(sql`
      UPDATE ingestion_intake
      SET status = 'classified',
          error_class = NULL,
          error_text = NULL
      WHERE id = ${args.job.intakeId}::uuid
    `);

    args.logger.info("compilation_worker.completed", {
      binding_id: args.job.bindingId,
      intake_id: args.job.intakeId,
      content_kind: meta.contentKind,
      domains: classifiedDomains,
      commits_landed: commitsLanded,
    });

    return {
      intakeId: args.job.intakeId,
      classifiedDomains,
      commitsLanded,
    };
  } catch (err) {
    // Capture the failure on the intake row BEFORE the throw escapes
    // to BullMQ. Without this, BullMQ's `failed` set and the intake
    // row disagreed silently (appendix #14 Layer B): jobs failed but
    // rows stayed `pending` forever, leaving the operator blind to a
    // 260-row backlog on the design-partner deployment. The re-throw
    // preserves the existing BullMQ behavior (the job still lands in
    // `failed` for the retry/DLQ pipeline).
    const errorClass: ErrorClass = isOpencooError(err)
      ? err.errorClass
      : "transient";
    // `intakeMessage` is the raw `.message` we persist to
    // `ingestion_intake.error_text`. The intake column is operator-
    // facing engine-internal data (not a log sink) and W6/W4 apply
    // their own output-side sanitization when these strings surface
    // to LLM prompts / UI render paths. The 1000-char cap matches
    // the appendix's `LEFT($err.message, 1000)` policy.
    const intakeMessage =
      err instanceof Error ? err.message : String(err);
    await markIntakeFailed({
      db: args.db,
      logger: args.logger,
      intakeId: args.job.intakeId,
      errorClass,
      errorMessage: intakeMessage,
    });
    // PR-W4 — publish the failure to the SSE bus so the Activity feed
    // and the SourceBindingDetail "Intake state" panel render the
    // event live. Best-effort: a throw from `emitIntakeFailed` is
    // logged but does NOT mask the original worker error — BullMQ
    // must still see the rethrow below to land the job in its
    // `failed` set, and the W3 DB row is already committed. The
    // snippet is scrubbed via `safeErrorMessage` (caps at the shared
    // ERROR_MESSAGE_MAX_LENGTH and redacts PAT/JWT shapes) and then
    // truncated to ERROR_SNIPPET_CAP — the Activity feed is a live
    // preview, not the source of truth (the row carries the full
    // 1000-char message and the GET handler exposes a 200-char
    // snippet from the same column).
    emitIntakeFailed(args.sseBus, args.logger, {
      bindingId: args.job.bindingId,
      intakeId: args.job.intakeId,
      errorClass,
      errorTextSnippet: safeErrorMessage(err).slice(0, ERROR_SNIPPET_CAP),
      occurredAt: new Date().toISOString(),
    });
    // The structured logger is the OTHER exit gate for error
    // strings; route through `safeErrorMessage` so PAT-shaped
    // tokens that may have leaked into a downstream `Error.message`
    // (pg driver errors echoing SQL, fetch errors echoing headers,
    // etc.) are scrubbed before they reach the log transport
    // (THREAT-MODEL §3.6 invariant 11; PR-W3 Copilot triage).
    args.logger.warn("compilation_worker.failed", {
      binding_id: args.job.bindingId,
      intake_id: args.job.intakeId,
      error_class: errorClass,
      error_message: safeErrorMessage(err),
    });
    throw err;
  }
}

/**
 * Best-effort publish of an `IntakeFailedEvent` onto the optional
 * SSE bus. Isolated as a helper because both the catch path and the
 * emit-throws regression test exercise the same shape — and any
 * future producer (webhook-receiver intake DLQ consumer, v0.2)
 * should call the same wrapper instead of inlining the null-guard
 * and the swallow-and-log shape.
 *
 * The bus interface declares `emitIntakeFailed?` (optional) so
 * structural-typing consumers (the cross-engine seam in
 * `cli/serve.ts`) can be widened in lockstep without breaking
 * older composition shapes. A bus with no method present silently
 * no-ops here.
 */
function emitIntakeFailed(
  bus: IngestionRunEventEmitter | undefined,
  logger: Logger,
  event: IntakeFailedEvent,
): void {
  if (bus === undefined) return;
  if (typeof bus.emitIntakeFailed !== "function") return;
  try {
    bus.emitIntakeFailed(event);
  } catch (busErr) {
    // Swallow + log: the original worker error must win — BullMQ
    // sees the rethrow on the next line of the caller, and the
    // operator already has the failure persisted on the intake row
    // (W3) and exposed via the GET handler (W4). Losing the SSE
    // event is a graceful degradation, not a data-loss path.
    logger.warn("compilation_worker.intake_failed_emit_failed", {
      binding_id: event.bindingId,
      intake_id: event.intakeId,
      error: safeErrorMessage(busErr),
    });
  }
}

// Zod schema for the n8n workflow shape we care about. `.passthrough()`
// preserves unknown keys (nodes / connections / settings / version)
// so the catalog-workflow compiler can JSON-stringify them
// verbatim. We narrow `tags` to `string[]` (filtering out non-string
// entries the n8n API occasionally serialises as objects) — downstream
// `buildTagsLine` assumes string tags. Other fields are validated only
// loosely; the Compiler treats the body opaquely after the strip.
const n8nWorkflowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    tags: z
      .array(z.unknown())
      .optional()
      .transform((arr) =>
        arr === undefined
          ? undefined
          : arr.filter((t): t is string => typeof t === "string"),
      ),
  })
  .passthrough();

// Zod schema for the asana-project snapshot shape (PR-G). `.passthrough()`
// preserves unknown keys so the compiler can forward them verbatim.
const asanaProjectSchema = z
  .object({
    project_gid: z.string(),
    snapshot: z.array(
      z
        .object({
          gid: z.string(),
          name: z.string(),
          completed: z.boolean(),
          modified_at: z.string().datetime(),
          due_on: z.string().nullable().optional(),
          assignee: z
            .object({ name: z.string() })
            .nullable()
            .optional(),
          memberships: z
            .array(
              z
                .object({
                  section: z
                    .object({ name: z.string() })
                    .optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
    incomplete_count: z.number().int().nonnegative(),
    overdue_count: z.number().int().nonnegative(),
    fetched_at: z.string().datetime(),
    // Optional project name field — emitted by AsanaClient when the
    // /projects/{gid} endpoint is available.
    name: z.string().optional(),
  })
  .passthrough();

function parseAsanaProjectContent(
  content: string,
  sourceRef: string,
): AsanaProjectSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `compilation-worker: asana-project content for ${sourceRef} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const result = asanaProjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `compilation-worker: asana-project content for ${sourceRef} failed shape validation: ${result.error.message}`,
    );
  }
  return result.data as AsanaProjectSnapshot;
}

/**
 * Derive a human-readable title for the project page. If the snapshot
 * carries a `name` field (from AsanaClient), use it. Otherwise fall
 * back to the project GID.
 */
function deriveAsanaProjectTitle(snapshot: AsanaProjectSnapshot): string {
  const raw = (snapshot as AsanaProjectSnapshot & { name?: string }).name;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return `Project ${snapshot.project_gid}`;
}

function parseN8nWorkflowContent(
  content: string,
  sourceRef: string,
): CatalogWorkflowInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `compilation-worker: catalog-workflow content for ${sourceRef} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const result = n8nWorkflowSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `compilation-worker: catalog-workflow content for ${sourceRef} failed shape validation: ${result.error.message}`,
    );
  }
  return result.data as CatalogWorkflowInput;
}

async function persistRedactionEvents(args: {
  readonly db: Db;
  readonly pipeline: string;
  readonly domainId: string;
  readonly bindingId: string;
  readonly guardSlug: string;
  readonly events: ReadonlyArray<GuardEvent>;
}): Promise<void> {
  for (const ev of args.events) {
    const ranges = JSON.stringify(ev.matchedByteRanges);
    await args.db.execute(sql`
      INSERT INTO redaction_events (
        pipeline, domain_id, binding_id, guard_slug,
        category, pattern_version, matched_byte_ranges, fail_mode
      ) VALUES (
        ${args.pipeline},
        ${args.domainId}::uuid,
        ${args.bindingId}::uuid,
        ${args.guardSlug},
        ${ev.category},
        ${ev.patternVersion},
        ${ranges}::jsonb,
        ${ev.failMode}
      )
    `);
  }
}

async function loadBindingMeta(
  db: Db,
  bindingId: string,
): Promise<BindingMeta | null> {
  const rows = (await db.execute(sql`
    SELECT b.id::text AS binding_id,
           d.id::text AS domain_id,
           d.slug AS domain_slug,
           d.locale,
           b.allowed_paths,
           COALESCE(b.config->>'contentKind', 'document') AS content_kind
    FROM sources_bindings b
    JOIN domains d ON d.id = b.domain_id
    WHERE b.id = ${bindingId}::uuid AND b.enabled = true
  `)) as unknown as ExecResult<{
    binding_id: string;
    domain_id: string;
    domain_slug: string;
    locale: string | null;
    allowed_paths: string[];
    content_kind: string;
  }>;
  const row = rows.rows[0];
  if (row === undefined) return null;
  const localeRaw = row.locale ?? "auto";
  const locale: "en" | "pl" | "auto" =
    localeRaw === "en" || localeRaw === "pl" ? localeRaw : "auto";
  const contentKind: ContentKind = isContentKind(row.content_kind)
    ? row.content_kind
    : "document";
  return {
    bindingId: row.binding_id,
    domainId: row.domain_id,
    domainSlug: row.domain_slug,
    domainLocale: locale,
    allowedPaths: row.allowed_paths ?? [],
    allowedDomains: [row.domain_slug],
    contentKind,
  };
}

function isContentKind(value: string): value is ContentKind {
  return (CONTENT_KINDS as readonly string[]).includes(value);
}
