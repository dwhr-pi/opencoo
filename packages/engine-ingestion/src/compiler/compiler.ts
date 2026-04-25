/**
 * `compile()` — end-to-end orchestrator.
 *
 * For each page_path the Classifier routed to this domain:
 *   1. Read the existing page (may be empty/null).
 *   2. Call mergePage to get the new body + worldview_impact
 *      bullets from the LLM (Zod-strict, sentinel-scrubbed).
 *   3. Skip-write optimisation (Q6): if the new body equals
 *      the existing body (modulo frontmatter), log
 *      `compiler.no-op` and emit no operation for this page.
 *
 * Then, atomically (Q7):
 *   - if EVERY page was a no-op, return early with commitSha:null
 *     and pagePathsWritten:[] (citations still get appended for
 *     audit completeness — we processed the source).
 *   - otherwise, build ONE wikiWrite call containing every
 *     non-no-op replace operation. Atomicity is fail-fast: any
 *     mergePage failure throws BEFORE the wikiWrite call so the
 *     domain never ends up with a partial multi-page commit.
 *
 * Post-commit (Q8): append page_citations rows for every page
 * processed (no-op + written alike). A failure here is logged
 * + alerted but does NOT roll back the wiki commit.
 */

import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { LlmRouter } from "@opencoo/shared/llm-router";
import type {
  AgentRunId,
  DomainId,
  DomainSlug,
  SourceBindingId,
} from "@opencoo/shared/db";
import {
  wikiWrite,
  type WikiAuthor,
  type WikiOperation,
  type WikiWriteDeps,
  type WikiWriteInput,
} from "@opencoo/shared/wiki-write";
import type { PromptLocale } from "@opencoo/shared/prompts";

import { buildFrontmatter } from "./frontmatter.js";
import { mergePage } from "./merge-page.js";
import { recordPageCitations } from "./page-citations.js";
import { normaliseWorldviewImpact } from "./worldview-impact.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface CompileArgs {
  readonly router: LlmRouter;
  readonly db: Db;
  readonly domainId: DomainId;
  readonly domainSlug: string;
  readonly bindingId: SourceBindingId;
  readonly sourceRef: string;
  readonly sourceContent: string;
  readonly pagePaths: readonly string[];
  readonly locale: PromptLocale;
  readonly wikiDeps: WikiWriteDeps;
  readonly author: WikiAuthor;
  /** Optional: when the orchestrator is itself running inside an
   *  agent_run, pass the run id so page_citations.compiled_by_run_id
   *  is filled in. */
  readonly compiledByRunId?: AgentRunId;
  /** Optional clock for compiled_at timestamps; defaults to wall
   *  clock. Tests inject a fixed clock for deterministic
   *  frontmatter assertions. */
  readonly clock?: () => Date;
  /**
   * Optional post-commit review-dispatch callback (PR 17 / plan
   * #77 extension 5). Fires AFTER the wikiWrite commit lands and
   * AFTER page_citations are recorded — never before, and never
   * inline with the wikiWrite call (atomicity per Q7 must remain:
   * exactly one wikiWrite per compile run). The callback is
   * invoked only when:
   *   - a commit actually happened (no-op skip-write returns
   *     null commitSha → no dispatch), AND
   *   - the domain row's `review_role` is non-null (D4: routing
   *     key lives on the domain, not the binding).
   * The compiler treats `review_role` as opaque text — log,
   * don't dereference. The callback owns delivery (e.g. enqueue
   * an `ingestion.review.dispatch` BullMQ job).
   */
  readonly reviewDispatch?: ReviewDispatchHook;
}

/** Argument shape passed to `CompileArgs.reviewDispatch`. */
export interface ReviewDispatchEvent {
  readonly domainSlug: string;
  readonly reviewRole: string;
  readonly commitSha: string;
  readonly pagePaths: readonly string[];
  readonly sourceRef: string;
}

export type ReviewDispatchHook = (
  event: ReviewDispatchEvent,
) => Promise<void>;

export interface CompileResult {
  /** The wikiWrite commit sha, or null when EVERY page was a
   *  no-op (Q6) and no commit happened. */
  readonly commitSha: string | null;
  /** Page paths that produced a wiki write. Subset of args.pagePaths;
   *  paths that were no-ops are absent. */
  readonly pagePathsWritten: readonly string[];
  /** The worldview_impact bullets that LANDED in the commit:
   *  aggregated across pages, normalised, capped at the wikiWrite
   *  Zod max of 20. Empty when nothing was written (skip-write
   *  no-op). Matches what an audit grep over git log would find
   *  for this commit (copilot #18). */
  readonly worldviewImpact: readonly string[];
}

/**
 * Strip a leading YAML frontmatter block, if present. Returns the
 * raw body for skip-write comparison so we don't false-trigger on
 * a regenerated `compiled_at` timestamp.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

/** Derive a default page title from the path's basename. The
 *  compiler's v0.1 contract (planner's plan §3 step 9) is that
 *  the title is the basename minus extension with the first
 *  letter capitalised — humans rename via the Management UI later. */
function deriveTitle(pagePath: string): string {
  const parts = pagePath.split("/");
  const base = parts[parts.length - 1] ?? pagePath;
  const noExt = base.replace(/\.(md|yml|yaml|json)$/i, "");
  if (noExt.length === 0) return pagePath;
  return noExt.charAt(0).toUpperCase() + noExt.slice(1);
}

interface PerPageResult {
  readonly pagePath: string;
  readonly merged: Awaited<ReturnType<typeof mergePage>>;
  readonly existingBody: string;
  readonly fullPageContent: string; // frontmatter + body
}

export async function compile(args: CompileArgs): Promise<CompileResult> {
  const clock = args.clock ?? ((): Date => new Date());
  const compiledAt = clock();

  // Phase 1 — gather merge results for every page BEFORE any
  // wikiWrite. Fail-fast: any mergePage rejection throws here
  // and the wiki repo is untouched (Q7).
  const perPage: PerPageResult[] = [];
  for (const pagePath of args.pagePaths) {
    const existing = await args.wikiDeps.adapter.readPage(
      args.domainSlug as DomainSlug,
      pagePath,
    );
    const existingFull = existing?.content ?? "";
    const existingBody = stripFrontmatter(existingFull);
    const merged = await mergePage({
      router: args.router,
      domainId: args.domainId,
      sourceRef: args.sourceRef,
      sourceContent: args.sourceContent,
      existingPageContent: existingBody,
      pagePath,
      locale: args.locale,
    });
    const frontmatter = buildFrontmatter({
      title: deriveTitle(pagePath),
      pagePath,
      domainSlug: args.domainSlug,
      compiledAt,
      promptVersion: merged.promptVersion,
    });
    const fullPageContent = `${frontmatter}${merged.mergedBody}`;
    perPage.push({ pagePath, merged, existingBody, fullPageContent });
  }

  // Phase 2 — partition no-ops from real writes. Q6: the
  // skip-write check compares BODIES (not full content) so a
  // regenerated frontmatter timestamp doesn't false-trigger
  // a write.
  const ops: WikiOperation[] = [];
  const writtenPaths: string[] = [];
  const aggregatedImpact: string[] = [];
  // Every mergePage call resolved against the same compiler prompt,
  // so all per-page promptVersion strings are identical; pick any.
  const promptVersionForCitations = perPage[0]?.merged.promptVersion ?? "";
  for (const p of perPage) {
    if (p.merged.mergedBody === p.existingBody) {
      args.wikiDeps.logger.info("compiler.no-op", {
        domain_slug: args.domainSlug,
        page_path: p.pagePath,
        source_ref: args.sourceRef,
      });
      continue;
    }
    ops.push({
      mode: "replace",
      path: p.pagePath,
      content: p.fullPageContent,
    });
    writtenPaths.push(p.pagePath);
    for (const bullet of p.merged.worldviewImpact) {
      aggregatedImpact.push(bullet);
    }
  }

  // Phase 3 — single wikiWrite for the whole batch, or skip
  // entirely when every page was a no-op. The list of bullets
  // that ACTUALLY land in the commit is computed here and
  // returned to the caller so CompileResult.worldviewImpact
  // matches what the audit grep would find (copilot #18).
  let commitSha: string | null = null;
  let landedImpact: string[] = [];
  if (ops.length > 0) {
    const normalisedImpact = normaliseWorldviewImpact(aggregatedImpact);
    // Cap at 20 to match the wikiWrite Zod max (and the prompt's
    // per-call ≤20 rule). When N pages each emit 5+ bullets the
    // aggregate can overflow; truncate deterministically and log.
    landedImpact = normalisedImpact.slice(0, 20);
    if (landedImpact.length < normalisedImpact.length) {
      args.wikiDeps.logger.warn("compiler.worldview_impact.truncated", {
        domain_slug: args.domainSlug,
        original_count: normalisedImpact.length,
        kept_count: landedImpact.length,
      });
    }
    const writeInput: WikiWriteInput = {
      domainSlug: args.domainSlug,
      tag: "[compiler]",
      description: `compile ${args.sourceRef} → ${ops.length} page(s)`,
      author: args.author,
      caller: { kind: "engine" },
      operations: ops,
      ...(landedImpact.length > 0
        ? { worldviewImpact: landedImpact }
        : {}),
    };
    const result = await wikiWrite(args.wikiDeps, writeInput);
    commitSha = result.sha;
  }

  // Phase 4 — page_citations append. Q8: soft failure path.
  try {
    await recordPageCitations({
      db: args.db,
      domainSlug: args.domainSlug,
      pagePaths: args.pagePaths,
      sourceBindingId: args.bindingId,
      sourceRef: args.sourceRef,
      promptVersion: promptVersionForCitations,
      ...(args.compiledByRunId !== undefined
        ? { compiledByRunId: args.compiledByRunId }
        : {}),
    });
  } catch (err) {
    args.wikiDeps.logger.error("compiler.page_citations.failed", {
      domain_slug: args.domainSlug,
      page_count: args.pagePaths.length,
      source_ref: args.sourceRef,
      error: err instanceof Error ? err.message : String(err),
    });
    // Do NOT rethrow — the wiki commit landed, which is the
    // load-bearing side-effect. A reconciliation pass (future PR)
    // will backfill missing citations.
  }

  // Phase 5 — review-dispatch (PR 17 / plan #77 extension 5).
  // Fires AFTER the wikiWrite + page_citations. Atomicity per
  // Q7 is preserved: the wikiWrite happened in Phase 3 above
  // exactly once, and the dispatch is a separate post-commit
  // side effect that does NOT issue another wiki write.
  if (commitSha !== null && args.reviewDispatch !== undefined) {
    try {
      const reviewRole = await fetchReviewRole(args.db, args.domainId);
      if (reviewRole !== null) {
        await args.reviewDispatch({
          domainSlug: args.domainSlug,
          reviewRole,
          commitSha,
          pagePaths: writtenPaths,
          sourceRef: args.sourceRef,
        });
      }
    } catch (err) {
      args.wikiDeps.logger.error("compiler.review_dispatch.failed", {
        domain_slug: args.domainSlug,
        commit_sha: commitSha,
        source_ref: args.sourceRef,
        error: err instanceof Error ? err.message : String(err),
      });
      // Soft-fail same as page_citations: the wiki commit
      // landed, the dispatch can be retried via reconciliation
      // or by re-running the cron.
    }
  }

  return {
    commitSha,
    pagePathsWritten: writtenPaths,
    worldviewImpact: landedImpact,
  };
}

interface ExecResult<R> {
  readonly rows: R[];
  readonly rowCount?: number;
  readonly affectedRows?: number;
}

async function fetchReviewRole(
  db: Db,
  domainId: DomainId,
): Promise<string | null> {
  const result = (await db.execute(
    sql`SELECT review_role FROM domains WHERE id = ${domainId}::uuid`,
  )) as unknown as ExecResult<{ review_role: string | null }>;
  const row = result.rows[0];
  if (row === undefined) return null;
  const role = row.review_role;
  if (role === null || role === "") return null;
  return role;
}
