/**
 * Asana task payload schema (PR 24 / plan #115).
 *
 * The schema is `.strict()` per the OutputAdapter contract
 * suite assertion 8 — over-keyed payloads fail Zod-parse
 * BEFORE any external call. Defense-in-depth against agent
 * field-smuggling.
 *
 * PR-W2 (phase-a appendix #13) — adds `htmlNotes` for the
 * rich-formatting path. Asana's REST API accepts either
 * `notes` (plain text) OR `html_notes` (restricted HTML
 * subset); sending BOTH yields a 400 from Asana, so the Zod
 * schema rejects payloads that carry both fields. At least
 * one MUST be present so the task body is never empty.
 */
import { z } from "zod";

export const asanaTaskPayloadSchema = z
  .object({
    /** Task title — required, single-line. */
    title: z.string().min(1).max(500),
    /** Plain-text notes / description. Either `notes` OR
     *  `htmlNotes` MUST be present; sending both is a 400 from
     *  Asana and the `.refine()` below rejects it server-side.
     *  Cap at 32 KB to keep prompt-side payloads bounded
     *  (Asana's hard ceiling is 65,535). */
    notes: z.string().max(32_768).optional(),
    /** Restricted-HTML body (Asana's `html_notes` field). Asana
     *  parses this as XML and supports a small whitelist:
     *  `<body>`, `<h1>`, `<h2>`, `<p>`, `<ul>/<ol>/<li>`,
     *  `<a>`, `<b>/<strong>`, `<i>/<em>`, `<u>`, `<s>`,
     *  `<code>`, `<pre>`. Any agent-supplied text MUST be
     *  HTML-entity-escaped by the caller (the per-(agent,
     *  adapter) transformer in cli/output-transformers does
     *  this). 32 KB cap mirrors `notes`. */
    htmlNotes: z.string().max(32_768).optional(),
    /** Project gid the task lands in. */
    projectGid: z.string().min(1),
    /** Optional ISO-date string `YYYY-MM-DD`. Asana's
     *  `due_on` field. */
    dueOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "dueOn must be YYYY-MM-DD")
      .optional(),
    /** Optional Asana user gid for assignment. */
    assigneeGid: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (v) =>
      !(v.notes !== undefined && v.htmlNotes !== undefined),
    {
      message:
        "asana payload: `notes` and `htmlNotes` are mutually exclusive (Asana rejects sending both)",
      path: ["htmlNotes"],
    },
  )
  .refine((v) => v.notes !== undefined || v.htmlNotes !== undefined, {
    message:
      "asana payload: one of `notes` (plain text) or `htmlNotes` (restricted HTML) is required",
    path: ["notes"],
  });

export type AsanaTaskPayload = z.infer<typeof asanaTaskPayloadSchema>;
