// Zod schema for injection-corpus fixture files. Loader uses
// this to reject malformed JSON BEFORE the runner sees it — a
// silently-malformed fixture (missing `injectionDirective`,
// unknown category) would otherwise "pass" by virtue of the
// runner doing nothing useful with the missing field.
//
// The schema is the only canonical description of the fixture
// shape; the generator (`scripts/regen-injection-fixtures.ts`)
// emits objects that round-trip through this schema.

import { z } from "zod";

import { PROMPT_NAMES, type PromptName } from "../../loader.js";
import {
  INJECTION_CATEGORIES,
  INJECTION_LOCALES,
  type InjectionCategory,
  type InjectionLocale,
} from "./_categories.js";

// Worst-case attacker-controlled LLM output for output-side
// validators. Optional — most fixtures only test the input-side
// (assembly + spotlight) invariants. When present, the runner
// feeds it through the prompt's downstream Zod gate (where one
// exists) and asserts rejection.
const AttackerOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("json"),
    body: z.unknown(),
  }),
  z.object({
    kind: z.literal("text"),
    body: z.string(),
  }),
]);

// Manual narrow-then-refine: zod's `z.enum(constTuple)` is the
// happy path but returns a `ZodEnum<string>` here because the
// imported tuples are exported with `as const` — the type
// information is on the *type-level alias* (`PromptName` /
// `InjectionLocale` / `InjectionCategory`), not preserved on the
// runtime tuple. We bridge the two by validating with
// `z.string()` + `.refine` and then casting the parsed value to
// the literal-typed alias inside a `z.transform`. Net effect:
// parsed fixture has `prompt: PromptName`, `locale:
// InjectionLocale`, `category: InjectionCategory` — strict
// enough that callers downstream don't need their own widening
// cast.
const PromptNameSchema: z.ZodType<PromptName> = z
  .string()
  .refine((v): v is PromptName => (PROMPT_NAMES as readonly string[]).includes(v), {
    message: `prompt must be one of ${PROMPT_NAMES.join(", ")}`,
  });
const InjectionLocaleSchema: z.ZodType<InjectionLocale> = z
  .string()
  .refine(
    (v): v is InjectionLocale =>
      (INJECTION_LOCALES as readonly string[]).includes(v),
    { message: `locale must be one of ${INJECTION_LOCALES.join(", ")}` },
  );
const InjectionCategorySchema: z.ZodType<InjectionCategory> = z
  .string()
  .refine(
    (v): v is InjectionCategory =>
      (INJECTION_CATEGORIES as readonly string[]).includes(v),
    {
      message: `category must be one of ${INJECTION_CATEGORIES.join(", ")}`,
    },
  );

export const InjectionFixtureSchema = z.object({
  /** Fixture path relative to `__fixtures__/injection/`. The
   *  runner uses this in test names + assertion messages. */
  fixture: z.string().min(1),

  /** Which prompt this fixture targets. Limited to the closed
   *  PROMPT_NAMES tuple so a renamed prompt fails fixture parse
   *  rather than silently mismatching. */
  prompt: PromptNameSchema,

  locale: InjectionLocaleSchema,

  category: InjectionCategorySchema,

  /** Pinned version of the targeted prompt at fixture-generation
   *  time. The runner compares against `loadPrompt().version`; a
   *  mismatch means the prompt body changed without regenerating
   *  the fixtures — CI fails with the actionable message. */
  promptVersion: z.string().min(1),

  /** The natural-language injection directive (e.g. "ignore
   *  previous instructions"). The runner verifies it appears
   *  inside (and only inside) the spotlighted envelope of the
   *  assembled prompt. */
  injectionDirective: z.string().min(1),

  /** The full untrusted-source body that the corpus feeds to
   *  spotlight(). Embeds `injectionDirective` plus any framing. */
  injectedContent: z.string().min(1),

  /** Stable, deterministic spotlight metadata. Hard-coded so
   *  fixture regeneration is byte-identical between runs. */
  spotlightSource: z.string().min(1),
  spotlightFetchedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),

  /** One-sentence description of the adversary's goal. Visible
   *  in CI test names so a fixture failure reads like a
   *  threat-model statement, not a stack trace. */
  adversaryGoal: z.string().min(1),

  /** Optional worst-case fully-pwned LLM output, used by the
   *  output-side checks where the prompt has a Zod-validated
   *  output schema (today: classifier; future: compiler). */
  attackerOutput: AttackerOutputSchema.optional(),
});

export type InjectionFixture = z.infer<typeof InjectionFixtureSchema>;
export type AttackerOutput = z.infer<typeof AttackerOutputSchema>;
