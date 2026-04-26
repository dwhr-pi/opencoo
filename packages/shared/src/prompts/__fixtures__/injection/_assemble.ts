// Prompt-assembly helper for the injection corpus.
//
// Mirrors the production assembly: `loadPrompt(...).body` joined
// with a single spotlighted envelope around the untrusted source
// content. THIS IS THE ONE PLACE the corpus replicates the
// production prompt shape — if production prompts ever start
// embedding multiple envelopes (e.g. compiler with both
// `<existing_page>` and `<source_content>`), extend this helper
// rather than letting the runner know about per-prompt shapes.
//
// Today every v0.1 prompt body documents exactly one
// `<source_content>` envelope as the untrusted-input boundary
// (per architecture §6.6 layer 1 + THREAT-MODEL §3.4). The
// `<existing_page>` and `<worldview>` envelopes are TRUSTED
// channels in production but the corpus models them as part of
// `injectedContent` when needed — keeping the assembler shape
// universal across prompts.

import { spotlight } from "../../../spotlight/index.js";
import { loadPrompt } from "../../loader.js";
import type { InjectionFixture } from "./_schema.js";

export interface AssembledPrompt {
  /** The full prompt string the LLM would see — body + newline +
   *  spotlighted envelope. */
  readonly assembled: string;
  /** The body half (just the prompt body), kept separate so
   *  invariants can be stated against either half independently. */
  readonly body: string;
  /** The spotlighted envelope half — exactly one
   *  `<source_content>` block per the production contract. */
  readonly envelope: string;
  /** Effective version of the loaded prompt — compared to
   *  `fixture.promptVersion` to detect drift. */
  readonly effectiveVersion: string;
}

export function assembleForFixture(fixture: InjectionFixture): AssembledPrompt {
  const loaded = loadPrompt({ name: fixture.prompt, locale: fixture.locale });
  const envelope = spotlight({
    content: fixture.injectedContent,
    source: fixture.spotlightSource,
    fetchedAt: new Date(fixture.spotlightFetchedAt),
  });
  return {
    assembled: `${loaded.body}\n\n${envelope}`,
    body: loaded.body,
    envelope,
    effectiveVersion: loaded.version,
  };
}
