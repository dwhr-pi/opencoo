/**
 * Compilation Worker (architecture §9 pipeline 2, plan #77).
 *
 * Consumes `scanner.classify` jobs (emitted by the Scanner) and
 * runs the two-pass ingestion: classify (Worker tier) → if
 * accepted, compile (Thinker tier). The orchestrator-level
 * boundary lives here; the leaf classify() / compile() calls
 * already exist in src/classifier and src/compiler.
 *
 * Per-job flow:
 *   1. Decode payload + look up the binding's allowed_paths +
 *      the home domain's allowed_domains.
 *   2. Call classify({...}) — DLQ via thrown ClassifierPathError
 *      / ClassifierValidationError / BindingConfigError on
 *      adversarial output.
 *   3. For each (domain_slug, page_paths[]) the classifier
 *      returns, dispatch a compile() call. Each compile() is
 *      atomic per planner Q7. Multi-domain output → multiple
 *      compile() calls (each its own atomic wikiWrite commit).
 *   4. Mark the intake row classified.
 *
 * The Compiler's post-commit `ingestion.review.dispatch`
 * emission (extension 5) lives in the Compiler, not here — the
 * worker just calls compile() and surfaces its result to the
 * BullMQ retry/DLQ machinery.
 *
 * v0.1 inlines content via Buffer in the job payload (1MiB cap;
 * Scanner short-circuits oversized docs); PR 23+ swaps to
 * re-fetch when adapters land.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { DomainId, SourceBindingId } from "@opencoo/shared/db";
import type {
  WikiAuthor,
  WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import type { Logger } from "@opencoo/shared/logger";

import { classify } from "../classifier/classifier.js";
import { compile } from "../compiler/compiler.js";

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
  /** Other domain slugs the classifier may route into — v0.1
   *  resolves this to the home domain only. Multi-domain routing
   *  is a v0.2 concern. */
  readonly allowedDomains: readonly string[];
}

export interface RunCompilationWorkerArgs {
  readonly db: Db;
  readonly logger: Logger;
  readonly router: LlmRouter;
  readonly wikiDeps: WikiWriteDeps;
  readonly author: WikiAuthor;
  readonly job: ScannerClassifyJob;
}

export interface CompilationWorkerResult {
  readonly intakeId: string;
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

  const content = Buffer.from(args.job.contentBase64, "base64").toString(
    "utf8",
  );
  const fetchedAt = new Date(args.job.fetchedAt);

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

  let commitsLanded = 0;
  for (const td of classified.targetDomains) {
    // v0.1: every target domain in the classifier output is the
    // SAME as the home domain (allowedDomains = [home]). Multi-
    // domain compile is a v0.2 expansion.
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

  await args.db.execute(sql`
    UPDATE ingestion_intake
    SET status = 'classified'
    WHERE id = ${args.job.intakeId}::uuid
  `);

  args.logger.info("compilation_worker.completed", {
    binding_id: args.job.bindingId,
    intake_id: args.job.intakeId,
    domains: classified.targetDomains.length,
    commits_landed: commitsLanded,
  });

  return {
    intakeId: args.job.intakeId,
    classifiedDomains: classified.targetDomains.length,
    commitsLanded,
  };
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
           b.allowed_paths
    FROM sources_bindings b
    JOIN domains d ON d.id = b.domain_id
    WHERE b.id = ${bindingId}::uuid AND b.enabled = true
  `)) as unknown as ExecResult<{
    binding_id: string;
    domain_id: string;
    domain_slug: string;
    locale: string | null;
    allowed_paths: string[];
  }>;
  const row = rows.rows[0];
  if (row === undefined) return null;
  const localeRaw = row.locale ?? "auto";
  const locale: "en" | "pl" | "auto" =
    localeRaw === "en" || localeRaw === "pl" ? localeRaw : "auto";
  return {
    bindingId: row.binding_id,
    domainId: row.domain_id,
    domainSlug: row.domain_slug,
    domainLocale: locale,
    allowedPaths: row.allowed_paths ?? [],
    allowedDomains: [row.domain_slug],
  };
}
