/**
 * Catalog-workflow compiler template (PR 26 / plan #122).
 *
 * Deterministic compile path for `content_kind: 'n8n-workflow'`
 * bindings. v0.1 makes ZERO LLM calls — the body is purely
 * mechanical:
 *
 *   1. Strip top-level `updatedAt` from the workflow JSON
 *      (decision 3 — "stripped in BOTH layers"; the source-n8n
 *      adapter already strips at fetch time, but the compiler
 *      strips again so a future non-n8n upstream can't smuggle
 *      `updatedAt` through).
 *   2. Pretty-print the workflow as JSON (2-space indent) and
 *      embed it inside a fenced block whose info-string is the
 *      shared `CATALOG_WORKFLOW_FENCE_LANG` constant (decision
 *      5 — same string as the `'n8n-workflow'` content-kind
 *      enum value).
 *   3. Prepend a YAML frontmatter block with `tags: string[]`
 *      derived from the workflow's tag list (decision 2 —
 *      array form, NOT singular `tag: 'catalog'`); default to
 *      `['catalog']` when the workflow has no tags.
 *   4. Single atomic wikiWrite to
 *      `catalog/workflows/<slug>-<id>.md` (decision 4 —
 *      human-readable git diffs, id suffix avoids slug
 *      collisions).
 *   5. Append ONE page_citations row with
 *      `prompt_version: 'catalog-workflow:1.0'` (decision 7 —
 *      sentinel, mirrors the document compiler's per-source
 *      attribution).
 *
 * The MUST-NOT-IMPORT discipline: this module does NOT import
 * `@opencoo/shared/llm-router`. The catalog-workflow.test.ts
 * source-greps for that import as a regression guard.
 *
 * Strict parser: `parseCatalogWorkflowBody` rejects any body
 * that is not exactly `<frontmatter>\n<fenced n8n-workflow
 * block>\n` — extra prose, an unknown fence info-string, or
 * malformed JSON inside the fence all throw
 * CompilerValidationError. Round-trip cleanness is the
 * load-bearing assertion.
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { CATALOG_WORKFLOW_FENCE_LANG } from "@opencoo/shared/db";
import type {
  AgentRunId,
  DomainId,
  DomainSlug,
  SourceBindingId,
} from "@opencoo/shared/db";
import {
  wikiWrite,
  type WikiAuthor,
  type WikiWriteDeps,
  type WikiWriteInput,
} from "@opencoo/shared/wiki-write";

import { CompilerValidationError } from "./errors.js";
import { recordPageCitations } from "./page-citations.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * `prompt_version` sentinel for catalog-workflow page_citations
 * rows. The literal string is part of the persisted audit trail —
 * change it only via a deliberate template version bump.
 */
export const CATALOG_WORKFLOW_PROMPT_VERSION = "catalog-workflow:1.0";

/** Identifies catalog-workflow inputs the template accepts. */
export interface CatalogWorkflowInput {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
  // The workflow is stored as a JSON-serialisable object; the
  // template treats it opaquely except for `id`, `name`, `tags`,
  // and the top-level `updatedAt` it strips. Use a record over
  // `unknown` because we must JSON-stringify the body verbatim.
  readonly [key: string]: unknown;
}

export interface BuildCatalogWorkflowBodyArgs {
  readonly workflow: CatalogWorkflowInput;
  readonly domainSlug: string;
  readonly compiledAt: Date;
}

export interface BuildCatalogWorkflowBodyResult {
  readonly body: string;
  /** The body MINUS frontmatter — used by the compile orchestrator
   *  for the skip-write no-op comparison. */
  readonly bodyWithoutFrontmatter: string;
}

/**
 * Lowercase, drop non-[a-z0-9] characters, dash-collapse
 * spaces. Used to derive the page-path slug from the workflow
 * name. Falls back to `'workflow'` on empty or all-special
 * inputs.
 */
export function slugifyName(name: string): string {
  const lower = name.toLowerCase().normalize("NFKD");
  const replaced = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (replaced.length === 0) return "workflow";
  return replaced;
}

export function catalogPagePathForWorkflow(args: {
  readonly id: string;
  readonly name: string;
}): string {
  return `catalog/workflows/${slugifyName(args.name)}-${args.id}.md`;
}

/**
 * Strip top-level `updatedAt` from the workflow object. The
 * source-n8n adapter already strips this; we strip again as
 * defense-in-depth (decision 3) so a non-n8n upstream cannot
 * smuggle the field through.
 */
function stripTopLevelUpdatedAt(
  wf: CatalogWorkflowInput,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...wf };
  delete copy["updatedAt"];
  return copy;
}

function buildTagsLine(workflow: CatalogWorkflowInput): string {
  const tags = workflow.tags && workflow.tags.length > 0 ? workflow.tags : ["catalog"];
  // Emit YAML flow-list — `tags: ["a", "b"]`. Tags are simple
  // identifiers; we double-quote to keep the format consistent
  // even when a single tag is alphanumeric.
  const escaped = tags.map((t) => `"${t.replace(/"/g, '\\"')}"`);
  return `tags: [${escaped.join(", ")}]`;
}

/**
 * Build the catalog-workflow page body. Pure function: given
 * the same inputs, produces the same bytes — there is no
 * locale-specific formatting, no LLM, no clock-dependent line
 * within the fenced block (compiledAt lives in the frontmatter).
 */
export function buildCatalogWorkflowBody(
  args: BuildCatalogWorkflowBodyArgs,
): BuildCatalogWorkflowBodyResult {
  if (args.workflow.id.length === 0) {
    throw new CompilerValidationError(
      "buildCatalogWorkflowBody: workflow.id must not be empty",
    );
  }
  if (args.workflow.name.length === 0) {
    throw new CompilerValidationError(
      "buildCatalogWorkflowBody: workflow.name must not be empty",
    );
  }
  const stripped = stripTopLevelUpdatedAt(args.workflow);
  const json = JSON.stringify(stripped, null, 2);
  const frontmatterLines = [
    "---",
    `title: "${args.workflow.name.replace(/"/g, '\\"')}"`,
    `page_path: "${catalogPagePathForWorkflow({ id: args.workflow.id, name: args.workflow.name })}"`,
    `domain_slug: "${args.domainSlug}"`,
    `compiled_at: "${args.compiledAt.toISOString()}"`,
    `prompt_version: "${CATALOG_WORKFLOW_PROMPT_VERSION}"`,
    `schema_version: "1.0.0"`,
    buildTagsLine(args.workflow),
    "---",
  ];
  const frontmatter = frontmatterLines.join("\n") + "\n";
  const fenced = `\`\`\`${CATALOG_WORKFLOW_FENCE_LANG}\n${json}\n\`\`\`\n`;
  return {
    body: frontmatter + fenced,
    bodyWithoutFrontmatter: fenced,
  };
}

/**
 * Strict catalog-page body parser. Returns the workflow JSON
 * the page wraps; throws CompilerValidationError on any shape
 * deviation:
 *   - body has prose outside the fence,
 *   - fence info-string is not the shared constant,
 *   - JSON inside the fence is malformed,
 *   - the fence is missing entirely.
 */
export function parseCatalogWorkflowBody(body: string): Record<string, unknown> {
  // Strip an optional leading frontmatter block.
  let rest = body;
  if (rest.startsWith("---\n")) {
    const end = rest.indexOf("\n---\n", 4);
    if (end === -1) {
      throw new CompilerValidationError(
        "parseCatalogWorkflowBody: unterminated frontmatter",
      );
    }
    rest = rest.slice(end + 5);
  }
  const expectedOpen = `\`\`\`${CATALOG_WORKFLOW_FENCE_LANG}\n`;
  if (!rest.startsWith(expectedOpen)) {
    // Either a leading prose line or a different fence info.
    // Scan for a fence to give a precise error.
    const firstFence = rest.indexOf("```");
    if (firstFence === -1) {
      throw new CompilerValidationError(
        "parseCatalogWorkflowBody: missing required fenced block",
      );
    }
    if (firstFence > 0) {
      throw new CompilerValidationError(
        "parseCatalogWorkflowBody: stray content before fenced block",
      );
    }
    throw new CompilerValidationError(
      `parseCatalogWorkflowBody: fence info-string must be '${CATALOG_WORKFLOW_FENCE_LANG}'`,
    );
  }
  rest = rest.slice(expectedOpen.length);
  const closeIdx = rest.indexOf("\n```");
  if (closeIdx === -1) {
    throw new CompilerValidationError(
      "parseCatalogWorkflowBody: unterminated fenced block",
    );
  }
  const json = rest.slice(0, closeIdx);
  const tail = rest.slice(closeIdx + 4);
  if (tail.replace(/\s+/g, "").length > 0) {
    throw new CompilerValidationError(
      "parseCatalogWorkflowBody: stray content after fenced block",
    );
  }
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new CompilerValidationError(
      `parseCatalogWorkflowBody: malformed JSON inside fence (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export interface CompileCatalogWorkflowArgs {
  readonly db: Db;
  readonly domainId: DomainId;
  readonly domainSlug: string;
  readonly bindingId: SourceBindingId;
  readonly sourceRef: string;
  readonly workflow: CatalogWorkflowInput;
  readonly wikiDeps: WikiWriteDeps;
  readonly author: WikiAuthor;
  readonly compiledByRunId?: AgentRunId;
  readonly clock?: () => Date;
}

export interface CompileCatalogWorkflowResult {
  /** wikiWrite commit sha, or null on a no-op skip-write. */
  readonly commitSha: string | null;
  /** Path of the catalog page that was (or would have been)
   *  written. */
  readonly pagePath: string;
}

export async function compileCatalogWorkflow(
  args: CompileCatalogWorkflowArgs,
): Promise<CompileCatalogWorkflowResult> {
  const clock = args.clock ?? ((): Date => new Date());
  const compiledAt = clock();
  const pagePath = catalogPagePathForWorkflow(args.workflow);

  const built = buildCatalogWorkflowBody({
    workflow: args.workflow,
    domainSlug: args.domainSlug,
    compiledAt,
  });

  // Skip-write check (matches the document compiler's
  // optimisation, plan #77 Q6): compare BODIES (not full
  // content) so a regenerated frontmatter timestamp doesn't
  // false-trigger a write.
  const existing = await args.wikiDeps.adapter.readPage(
    args.domainSlug as DomainSlug,
    pagePath,
  );
  if (existing !== null) {
    const existingBody = stripFrontmatter(existing.content);
    if (existingBody === built.bodyWithoutFrontmatter) {
      args.wikiDeps.logger.info("compiler.catalog_workflow.no-op", {
        domain_slug: args.domainSlug,
        page_path: pagePath,
        source_ref: args.sourceRef,
      });
      // Even on a no-op we record the citation — same audit
      // semantics as the document compiler.
      await tryRecordCitation(args, pagePath);
      return { commitSha: null, pagePath };
    }
  }

  const writeInput: WikiWriteInput = {
    domainSlug: args.domainSlug,
    // Reuse the existing `[compiler]` tag — catalog-workflow IS a
    // compiler-tier write (just deterministic, no LLM). Adding a
    // new tag enum value would require updating every audit-grep
    // / `opencoo source forget` consumer (CONVENTIONS §4.2),
    // which is out of PR 26 scope.
    tag: "[compiler]",
    description: `compile ${args.sourceRef} → ${pagePath}`,
    author: args.author,
    caller: { kind: "engine" },
    operations: [
      { mode: "replace", path: pagePath, content: built.body },
    ],
  };
  const result = await wikiWrite(args.wikiDeps, writeInput);

  await tryRecordCitation(args, pagePath);

  return { commitSha: result.sha, pagePath };
}

/** Strip a leading YAML frontmatter block. Mirrors the helper in
 *  `compiler.ts` — duplicated rather than shared to keep this
 *  module self-contained (tiny, no risk of drift). */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

async function tryRecordCitation(
  args: CompileCatalogWorkflowArgs,
  pagePath: string,
): Promise<void> {
  try {
    await recordPageCitations({
      db: args.db,
      domainSlug: args.domainSlug,
      pagePaths: [pagePath],
      sourceBindingId: args.bindingId,
      sourceRef: args.sourceRef,
      promptVersion: CATALOG_WORKFLOW_PROMPT_VERSION,
      ...(args.compiledByRunId !== undefined
        ? { compiledByRunId: args.compiledByRunId }
        : {}),
    });
  } catch (err) {
    args.wikiDeps.logger.error("compiler.catalog_workflow.page_citations.failed", {
      domain_slug: args.domainSlug,
      page_path: pagePath,
      source_ref: args.sourceRef,
      error: err instanceof Error ? err.message : String(err),
    });
    // Soft-fail — same as the document compiler. The wiki commit
    // landed; reconciliation can backfill missing citations.
  }
}
