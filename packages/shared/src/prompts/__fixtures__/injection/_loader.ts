// Filesystem-walking loader for the injection corpus.
//
// Layout: `__fixtures__/injection/{locale}/{prompt}/{category}.json`.
// Every covered (prompt, locale, category) cell MUST have a
// matching fixture file or loadAll() throws — silent missing
// fixtures are how a prompt-injection corpus quietly degrades to
// uselessness over time. Skipped cells (per `_skips.ts`) are
// allowed to be absent.
//
// The loader runs Zod validation on every file before returning;
// a malformed fixture is a hard error so the runner sees only
// validated `InjectionFixture` shapes.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROMPT_NAMES, type PromptName } from "../../loader.js";
import {
  INJECTION_CATEGORIES,
  INJECTION_LOCALES,
  type InjectionCategory,
  type InjectionLocale,
} from "./_categories.js";
import { isSkipped } from "./_skips.js";
import { InjectionFixtureSchema, type InjectionFixture } from "./_schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const FIXTURES_ROOT = __dirname;

export class InjectionFixtureLoadError extends Error {
  override readonly name = "InjectionFixtureLoadError";
}

function pathFor(
  locale: InjectionLocale,
  prompt: PromptName,
  category: InjectionCategory,
): string {
  return join(FIXTURES_ROOT, locale, prompt, `${category}.json`);
}

/** Load a single fixture by (locale, prompt, category). Throws
 *  `InjectionFixtureLoadError` with the file path if the file is
 *  missing, isn't valid JSON, or fails Zod validation. */
export async function loadFixture(
  locale: InjectionLocale,
  prompt: PromptName,
  category: InjectionCategory,
): Promise<InjectionFixture> {
  const file = pathFor(locale, prompt, category);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new InjectionFixtureLoadError(
      `injection fixture not found at ${file}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InjectionFixtureLoadError(
      `injection fixture ${file} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = InjectionFixtureSchema.safeParse(parsed);
  if (!result.success) {
    throw new InjectionFixtureLoadError(
      `injection fixture ${file} failed schema validation: ${result.error.message}`,
    );
  }
  // Cross-check: the in-file `prompt`, `locale`, `category` must
  // agree with the file's location. Catches a copy-paste mistake
  // (fixture content from one cell pasted into another file).
  const data = result.data as InjectionFixture;
  if (data.prompt !== prompt) {
    throw new InjectionFixtureLoadError(
      `injection fixture ${file} declares prompt='${data.prompt}' but is filed under '${prompt}'`,
    );
  }
  if (data.locale !== locale) {
    throw new InjectionFixtureLoadError(
      `injection fixture ${file} declares locale='${data.locale}' but is filed under '${locale}'`,
    );
  }
  if (data.category !== category) {
    throw new InjectionFixtureLoadError(
      `injection fixture ${file} declares category='${data.category}' but is filed under '${category}'`,
    );
  }
  return data;
}

/** Load every fixture file for a single prompt, across all
 *  (locale, category) cells the skip map says are covered. The
 *  result is sorted (locale asc, category in `INJECTION_CATEGORIES`
 *  order) so test discovery is deterministic. */
export async function loadFixturesForPrompt(
  prompt: PromptName,
): Promise<readonly InjectionFixture[]> {
  const out: InjectionFixture[] = [];
  for (const locale of INJECTION_LOCALES) {
    for (const category of INJECTION_CATEGORIES) {
      if (isSkipped(prompt, category)) continue;
      out.push(await loadFixture(locale, prompt, category));
    }
  }
  return out;
}

/** Verify every covered (prompt, locale, category) cell is
 *  present on disk; useful as a global sanity check (and is what
 *  `prompt-injection-corpus` CI guard runs first). */
export async function assertCorpusCoverageComplete(): Promise<void> {
  for (const prompt of PROMPT_NAMES) {
    for (const locale of INJECTION_LOCALES) {
      for (const category of INJECTION_CATEGORIES) {
        if (isSkipped(prompt, category)) continue;
        await loadFixture(locale, prompt, category);
      }
    }
  }
}

/** List every fixture directory (one per (locale, prompt))
 *  observed on disk. Used by the regenerator + drift-guard to
 *  detect orphaned fixtures (fixtures present on disk that the
 *  generator does not produce). */
export async function listOnDiskFixturePaths(): Promise<readonly string[]> {
  const out: string[] = [];
  for (const locale of INJECTION_LOCALES) {
    for (const prompt of PROMPT_NAMES) {
      const dir = join(FIXTURES_ROOT, locale, prompt);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (entry.endsWith(".json")) {
          out.push(join(dir, entry));
        }
      }
    }
  }
  return out;
}
