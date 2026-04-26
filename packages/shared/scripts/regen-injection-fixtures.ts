// Byte-deterministic regenerator for the injection-corpus
// fixture matrix. Invoked via `pnpm fixtures:regen` from the
// repo root. The CI guard re-runs this on every PR and fails if
// the on-disk fixtures differ from the regenerated output —
// catches "I edited a fixture by hand and didn't update the
// template" drift.
//
// Determinism rules (planner #145 Q11):
//   - JSON.stringify with `sortedKeyReplacer` so object keys
//     appear in alphabetical order regardless of construction
//     order.
//   - Two-space indentation + trailing newline (matches `prettier`
//     defaults so editors don't churn the file on save).
//   - LF line endings (`\n`), never CRLF.
//   - Spotlight `fetchedAt` is a hard-coded constant per
//     `_categories.ts` so re-runs don't perturb the timestamp.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INJECTION_CATEGORIES,
  INJECTION_LOCALES,
  type InjectionCategory,
  type InjectionLocale,
} from "../src/prompts/__fixtures__/injection/_categories.js";
import {
  isSkipped,
} from "../src/prompts/__fixtures__/injection/_skips.js";
import {
  InjectionFixtureSchema,
  type InjectionFixture,
} from "../src/prompts/__fixtures__/injection/_schema.js";
import { generateTemplate } from "../src/prompts/__fixtures__/injection/templates/index.js";
import {
  PROMPT_NAMES,
  type PromptName,
} from "../src/prompts/loader.js";
import { PROMPT_VERSION_MANIFEST } from "../src/prompts/version-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_ROOT = join(
  __dirname,
  "..",
  "src",
  "prompts",
  "__fixtures__",
  "injection",
);

const FIXED_FETCHED_AT = "2026-04-25T00:00:00.000Z";
const SOURCE_PREFIX = "test://corpus/injection";

function sortedKeyReplacer(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}

function serialise(fixture: InjectionFixture): string {
  // Two-space indent, sorted keys, trailing newline. The runner
  // and the loader read with `JSON.parse`, so the only thing
  // determinism affects is the *bytes on disk*.
  return `${JSON.stringify(fixture, sortedKeyReplacer, 2)}\n`;
}

function buildFixture(
  prompt: PromptName,
  locale: InjectionLocale,
  category: InjectionCategory,
): InjectionFixture {
  const tpl = generateTemplate(category, locale, prompt);
  const promptVersion = PROMPT_VERSION_MANIFEST[prompt];
  const relPath = `${locale}/${prompt}/${category}.json`;
  const fixture: InjectionFixture = {
    fixture: relPath,
    prompt,
    locale,
    category,
    promptVersion,
    injectionDirective: tpl.injectionDirective,
    injectedContent: tpl.injectedContent,
    spotlightSource: `${SOURCE_PREFIX}/${prompt}/${locale}/${category}`,
    spotlightFetchedAt: FIXED_FETCHED_AT,
    adversaryGoal: tpl.adversaryGoal,
    ...(tpl.attackerOutput !== undefined
      ? { attackerOutput: tpl.attackerOutput }
      : {}),
  };
  // Self-check: the template must produce an object that round-
  // trips through Zod. Catches a template change that violates
  // the schema before it lands on disk.
  const result = InjectionFixtureSchema.safeParse(fixture);
  if (!result.success) {
    throw new Error(
      `template for (${prompt}, ${locale}, ${category}) produced a Zod-invalid fixture: ${result.error.message}`,
    );
  }
  // Self-check: the directive must be a verbatim case-insensitive
  // substring of the injected content. This is the invariant the
  // runner asserts; if a template drifts, the runner would
  // surface it as an opaque "directive missing from envelope" —
  // catch it here with a precise template-name in the error.
  if (
    !fixture.injectedContent
      .toLowerCase()
      .includes(fixture.injectionDirective.toLowerCase())
  ) {
    throw new Error(
      `template for (${prompt}, ${locale}, ${category}) violates the directive⊆content invariant: directive='${fixture.injectionDirective}' is not a substring of injectedContent`,
    );
  }
  return result.data as InjectionFixture;
}

interface CliOptions {
  readonly check: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const check = argv.includes("--check");
  return { check };
}

/** Recursively walk `dir` and return every `.json` path found.
 *  Used by `--check` mode to detect orphan fixtures that aren't
 *  produced by the generator (a stale file from a previously-
 *  covered cell, or a hand-edited file an operator forgot to
 *  clean up). Returns empty array if `dir` doesn't exist. */
async function walkJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkJsonFiles(p)));
    } else if (e.isFile() && e.name.endsWith(".json")) {
      out.push(p);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // Stage all generated fixtures in a Map so we can compare
  // against on-disk content (in --check mode) or write them out
  // (in regen mode) without partial-write hazards.
  const generated = new Map<string, string>();
  const expectedPaths = new Set<string>();

  for (const locale of INJECTION_LOCALES) {
    for (const prompt of PROMPT_NAMES) {
      for (const category of INJECTION_CATEGORIES) {
        if (isSkipped(prompt, category)) continue;
        const fixture = buildFixture(prompt, locale, category);
        const filePath = join(FIXTURES_ROOT, fixture.fixture);
        generated.set(filePath, serialise(fixture));
        expectedPaths.add(filePath);
      }
    }
  }

  if (opts.check) {
    // Drift guard. Three failure modes:
    //   - missing on-disk: a generated path has no file.
    //   - content drift: bytes differ.
    //   - orphan on-disk: a `.json` under FIXTURES_ROOT exists
    //     but isn't in `expectedPaths` (a stale fixture left from
    //     a previously-covered cell that became skipped, or a
    //     hand-edited file an operator forgot to clean up).
    const drift: string[] = [];
    for (const [filePath, want] of generated) {
      let got: string | undefined;
      try {
        got = await readFile(filePath, "utf8");
      } catch {
        drift.push(`${filePath}  (missing on disk)`);
        continue;
      }
      if (got !== want) {
        drift.push(`${filePath}  (content drift)`);
      }
    }
    // Walk the FIXTURES_ROOT and compare against expectedPaths.
    const onDisk = await walkJsonFiles(FIXTURES_ROOT);
    for (const filePath of onDisk) {
      if (!expectedPaths.has(filePath)) {
        drift.push(`${filePath}  (orphan — not produced by generator; remove or regen)`);
      }
    }
    if (drift.length > 0) {
      console.error("FIXTURES DRIFT — re-run pnpm fixtures:regen:");
      for (const d of drift) console.error(`  ${d}`);
      process.exit(1);
    }
    console.log(
      `OK — ${generated.size} fixtures match on-disk regeneration output (no drift, no orphans).`,
    );
    return;
  }

  // Write mode: clear out any orphaned per-prompt directories
  // first (a previously-covered cell that became skipped should
  // not leave a stale fixture behind), then write every staged
  // fixture.
  for (const locale of INJECTION_LOCALES) {
    for (const prompt of PROMPT_NAMES) {
      const dir = join(FIXTURES_ROOT, locale, prompt);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore — first run won't have these
      }
    }
  }
  for (const [filePath, body] of generated) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body, { encoding: "utf8" });
  }
  console.log(`Wrote ${generated.size} fixtures under ${FIXTURES_ROOT}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
