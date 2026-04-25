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

import type { ScannerClassifyJob } from "./scanner.js";

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
}

export interface CompilationWorkerResult {
  readonly intakeId: string;
  /** For document branch: number of target domains the classifier
   *  routed into. For catalog branch: always 1 (the home domain). */
  readonly classifiedDomains: number;
  readonly commitsLanded: number;
}

export async function runCompilationWorker(
  args: RunCompilationWorkerArgs,
): Promise<CompilationWorkerResult> {
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
  } else if (meta.contentKind === "skill-bundle") {
    throw new Error(
      "compilation-worker: contentKind='skill-bundle' is reserved for phase-b (not implemented in v0.1)",
    );
  } else {
    // contentKind === 'document' — classic two-pass path.
    const classified = await classify({
      router: args.router,
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

  await args.db.execute(sql`
    UPDATE ingestion_intake
    SET status = 'classified'
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
