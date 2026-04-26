// Per-prompt skip rationales for the injection corpus.
//
// **The rationale IS the test.** Each skipped (prompt, category)
// cell records WHY the category is genuinely inapplicable to that
// prompt — not "we didn't get to it." A reviewer who disagrees
// with a skip rationale should add a fixture that exercises the
// concern; the corpus then expands. The cells listed here are the
// ones planner #145 explicitly approved.
//
// `data-exfiltration` is intentionally absent from every skip
// list — every LLM-facing prompt could be coerced into leaking
// information from its grounding context, so coverage is total.
//
// The runner (`_runner.ts`) consults this map BEFORE attempting to
// load a fixture; a missing fixture for a covered (prompt, category,
// locale) cell is a hard failure, while a missing fixture for a
// skipped cell is silently allowed (and the rationale is rendered
// into the test name so the reason stays visible in CI output).

import type { PromptName } from "../../loader.js";
import type { InjectionCategory } from "./_categories.js";

export interface SkipEntry {
  readonly category: InjectionCategory;
  /** One-sentence rationale visible in CI output. Lead with WHY,
   *  not WHAT. */
  readonly rationale: string;
}

export const INJECTION_SKIPS: Readonly<Record<PromptName, readonly SkipEntry[]>> = {
  // Classifier covers all six categories — it is the prompt that
  // most directly authors paths and domain refs that the engine
  // then trusts as authorisation tokens.
  classifier: [],

  // Compiler authors a free-form merged_body whose footnote-style
  // links could embed `../` traversal or cross-domain refs, so
  // both apply. (The wiki-write path-guard is the second wall;
  // the prompt is the first.)
  compiler: [],

  // Heartbeat returns alerts with citation paths but never
  // authors a write — the read-side concerns (homoglyph in a
  // citation pointing at a non-existent page; exfiltrating data
  // in `body`) are covered.
  heartbeat: [
    {
      category: "cross-domain-write",
      rationale:
        "Heartbeat is read-only — it never writes wiki pages, and `wikiWrite` is not in its tool surface. The cross-domain LEAK concern (mentioning a domain outside scope in `body`) is covered by `data-exfiltration` instead.",
    },
    {
      category: "path-traversal",
      rationale:
        "Heartbeat emits citation strings, not write targets. A `../` in a citation is a broken citation, not an exploit; the no-invent-paths instruction is what we actually care about and it falls under `direct-injection` regression coverage.",
    },
  ],

  // Lint compares pre-supplied page bodies and emits page_a /
  // page_b paths copied from the input — its threat surface is
  // narrower than Compiler's. Path traversal applies because the
  // model could echo a fabricated `../../wiki-x/...` in page_a.
  lint: [
    {
      category: "cross-domain-write",
      rationale:
        "Lint is read-only — it never writes wiki pages. The closest concern is fabricating a contradiction citing a page outside the input set; that surfaces as `path-traversal` and `data-exfiltration` coverage rather than a write concern.",
    },
  ],

  // Chat is read-only but the cross-domain LEAK concern is real
  // (an attacker prompts the model to quote a wiki page from a
  // domain the user's PAT doesn't grant). The MCP server enforces
  // PAT scope on tool calls, but the model could still
  // hallucinate / quote remembered context. We cover the LEAK
  // shape under `data-exfiltration` (which DOES apply); the
  // strict cross-domain WRITE category is genuinely
  // inapplicable.
  chat: [
    {
      category: "cross-domain-write",
      rationale:
        "Chat is read-only by construction — no write tool is registered. The read-side cross-domain LEAK concern (model summarises a page outside the caller's PAT scope) is covered under `data-exfiltration` and `unicode-homoglyph` (homoglyph in a quoted citation). End-to-end PAT-scope enforcement lands in the e2e suite (PR 32).",
    },
  ],

  // Surfacer proposes; the engine writes `automation_candidates`
  // rows. The page_path field has a path-traversal concern (the
  // surfaced candidate could later be Built into a workflow that
  // reads from the wrong page). Strict cross-domain WRITE is
  // mediated by the engine's automation_candidates writer.
  surfacer: [
    {
      category: "cross-domain-write",
      rationale:
        "Surfacer never writes wiki pages — it proposes automation candidates which the engine persists into `automation_candidates`. Cross-domain validation happens at the engine writer (rejects `domain_slug` outside the surfacer-binding's `scan_domains`); the prompt-level concern reduces to `path-traversal` on `page_path` (which IS covered).",
    },
  ],

  // Builder operates on a single pre-approved candidate. It does
  // not author paths or template slugs from scratch — it
  // resolves params on a slug already vetted by Surfacer + human
  // approval. Path-traversal and cross-domain-write therefore
  // genuinely don't apply at the Builder prompt level.
  builder: [
    {
      category: "cross-domain-write",
      rationale:
        "Builder consumes a single approved candidate; the candidate's domain is already pinned by Surfacer + human Gate-1 approval. Builder never authors a domain ref. Gate-3 (manual activation) is covered by `direct-injection` (verifying the prompt still forbids activation language) rather than this category.",
    },
    {
      category: "path-traversal",
      rationale:
        "Builder's output is `resolved_params` for a pre-vetted template slug — there is no path field that the model authors. Template slug fabrication is a separate concern covered under `unicode-homoglyph` (slug-spoofing).",
    },
  ],

  // Worldview-domain reads its own domain's pages and writes a
  // single, fixed-name `worldview.md`. The output target path is
  // hard-coded by the engine; the model has no path output. The
  // domain-scope is fixed by the pipeline driver.
  "worldview-domain": [
    {
      category: "cross-domain-write",
      rationale:
        "The worldview compiler runs per domain with a hard-coded output path (`worldview.md`); the prompt has no field where the model could name a different domain. Cross-domain LEAK from input pages is covered by `data-exfiltration`.",
    },
    {
      category: "path-traversal",
      rationale:
        "Output path is fixed by the engine (`worldview.md`); the model produces only `body`, not a target path. There is no path field that traversal could attack.",
    },
  ],

  // Worldview-company reads each non-aggregator domain's
  // `worldview.md` and writes `company.md` on the aggregator
  // domain — both paths are hard-coded by the pipeline.
  "worldview-company": [
    {
      category: "cross-domain-write",
      rationale:
        "Aggregator-only pipeline with the output path fixed at `company.md` on the `is_aggregator=true` domain. The model has no field through which to redirect the write. Cross-domain LEAK in `body` is covered by `data-exfiltration`.",
    },
    {
      category: "path-traversal",
      rationale:
        "Output path is fixed (`company.md`); the model produces only `body`. There is no path field for traversal.",
    },
  ],
};

/** True if `(prompt, category)` is a documented skip — i.e. the
 *  category is intentionally not covered for this prompt. */
export function isSkipped(
  prompt: PromptName,
  category: InjectionCategory,
): boolean {
  return INJECTION_SKIPS[prompt].some((s) => s.category === category);
}

/** Return the skip rationale, or `undefined` if the cell is
 *  covered. Visible in CI test names so the reason stays surfaced. */
export function skipRationale(
  prompt: PromptName,
  category: InjectionCategory,
): string | undefined {
  return INJECTION_SKIPS[prompt].find((s) => s.category === category)
    ?.rationale;
}
