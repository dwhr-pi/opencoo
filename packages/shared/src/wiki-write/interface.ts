import { z } from "zod";

import type { DomainSlug } from "../db/brands.js";

// Tags enforced on every wiki commit per CONVENTIONS §4.2. Downstream
// audit tooling (git log greps, `opencoo source forget` machinery)
// keys on the prefix — adding a tag without updating those consumers
// will create tag-shaped commits they ignore.
export const WikiWriteTagSchema = z.enum([
  "[compiler]",
  "[lint]",
  "[builder]",
  "[review-applied]",
  "[schema-edit]",
  "[catalog-rename]",
  "[catalog-unarchive]",
  "[skill-supersede]",
  "[index-rebuild]",
]);
export type WikiWriteTag = z.infer<typeof WikiWriteTagSchema>;

// Three operation modes; discriminated by `mode`. `delete` needs no
// content; `replace`/`append` do. Runtime path-guard runs separately
// from Zod because the check is belt-and-suspenders — even if the
// caller pre-validates, wikiWrite re-validates.
export const WikiOperationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("replace"),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    mode: z.literal("append"),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    mode: z.literal("delete"),
    path: z.string().min(1),
  }),
]);
export type WikiOperation = z.infer<typeof WikiOperationSchema>;

// Who asked for the write. `engine` (machine) is capped per-domain
// on deletes; `admin` (human with override authority) bypasses the
// cap but MUST carry the acting user id for audit.
export const WikiWriteCallerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("engine") }),
  z.object({ kind: z.literal("admin"), userId: z.string().min(1) }),
]);
export type WikiWriteCaller = z.infer<typeof WikiWriteCallerSchema>;

// Single-line string — rejects `\n`, `\r`, and any mix. Used for all
// commit-message fields that land on a SINGLE line (tag, description,
// author.name, coAuthor.name). Blocks newline-injection attacks where
// a caller-supplied value would forge a trailer like
// `"fix\nCo-authored-by: Impostor <x>"`.
const singleLineString = z
  .string()
  .min(1)
  .refine((s) => !/[\n\r]/.test(s), "must not contain newline or carriage-return");

// Trailer-shaped line detector. Case-insensitive match on the
// trailer prefixes opencoo emits (`Co-authored-by:`,
// `Opencoo-Instance:`, `Worldview-Impact:`). Body prose
// legitimately spans multiple lines and blank-line paragraph
// breaks, so we don't ban `\n`; we only ban lines that look like
// trailers a downstream audit grep would mistake for ours.
//
// `:(?:\s|$)` matches both `Key: value` and a bare `Key:` at
// end-of-line — audit greppers treat both as trailer-shaped
// (copilot #18). The previous `:\s` form let `Co-authored-by:`
// (no trailing space) slip through.
const TRAILER_LINE =
  /^(Co-authored-by|Opencoo-Instance|Worldview-Impact):(?:\s|$)/i;

export const WikiAuthorSchema = z.object({
  name: singleLineString,
  email: z.string().email(),
});
export type WikiAuthor = z.infer<typeof WikiAuthorSchema>;

// Full entrypoint input. Refinements beyond the field Zod:
//   1. `operations.length >= 1` — empty batch is a caller bug.
//   2. No duplicate `path` across operations — ambiguity is a caller
//      bug; fail loud rather than adopt silent last-write-wins.
//   3. `description` single-line (covered by `singleLineString`);
//      `body` may be multi-line but cannot contain a trailer-shaped
//      line (`Co-authored-by:` / `Opencoo-Instance:` /
//      `Worldview-Impact:`).
//   4. `worldviewImpact` (PR 16, plan #72) — at most 20 entries,
//      each ≤200 chars, single-line. The compiler sources these
//      from the LLM's `worldview_impact` array; one bullet =
//      one trailer line in the commit message.
export const WikiWriteInputSchema = z
  .object({
    domainSlug: z.string().min(1).max(64),
    tag: WikiWriteTagSchema,
    description: singleLineString.max(200),
    body: z
      .string()
      .refine(
        (s) => !s.split("\n").some((line) => TRAILER_LINE.test(line)),
        "body must not contain trailer-shaped lines (Co-authored-by: / Opencoo-Instance: / Worldview-Impact:)",
      )
      .optional(),
    author: WikiAuthorSchema,
    coAuthors: z.array(WikiAuthorSchema).optional(),
    caller: WikiWriteCallerSchema,
    operations: z.array(WikiOperationSchema).min(1),
    worldviewImpact: z
      .array(singleLineString.max(200))
      .max(20)
      .optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const op of value.operations) {
      if (seen.has(op.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["operations"],
          message: `duplicate path in operations: ${op.path}`,
        });
        return;
      }
      seen.add(op.path);
    }
  });
export type WikiWriteInput = z.infer<typeof WikiWriteInputSchema>;

// Adapter surface. `writeAtomic` NEVER throws for staleness — stale
// is a normal return with `status: 'stale'` + the current HEAD so the
// caller can reload and retry. Transport/other failures go through
// exceptions (caller translates to WikiTransportError).
export type WriteAtomicResult =
  | { status: "ok"; sha: string }
  | { status: "stale"; currentSha: string };

export interface WriteAtomicArgs {
  readonly domainSlug: DomainSlug;
  readonly operations: ReadonlyArray<WikiOperation>;
  readonly commitMessage: string;
  readonly author: WikiAuthor;
  readonly coAuthors?: ReadonlyArray<WikiAuthor>;
  readonly parentSha: string;
}

export interface WikiAdapter {
  getHeadSha(domainSlug: DomainSlug): Promise<string>;
  readPage(
    domainSlug: DomainSlug,
    path: string,
  ): Promise<{ sha: string; content: string } | null>;
  writeAtomic(args: WriteAtomicArgs): Promise<WriteAtomicResult>;
  /**
   * List every `*.md` path in the domain's wiki, sorted
   * alphabetically (deterministic so the Index Rebuilder
   * pipeline's diffs are stable run-to-run). Returns `[]` for
   * an empty domain. Non-`.md` files (JSON, YAML, anything else
   * an adapter might end up storing) are filtered out by the
   * adapter — the caller does not re-filter.
   *
   * Added PR 17 / plan #77 for the Index Rebuilder pipeline.
   */
  listMarkdown(domainSlug: DomainSlug): Promise<readonly string[]>;
}
