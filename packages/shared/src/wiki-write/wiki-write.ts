import { z } from "zod";

import type { DomainSlug } from "../db/brands.js";
import type { Logger } from "../logger.js";

import { WikiWriteInputError, WikiWriteStaleError } from "./errors.js";
import type { DeleteCap } from "./daily-cap.js";
import type {
  WikiAdapter,
  WikiWriteInput,
  WriteAtomicArgs,
} from "./interface.js";
import { WikiWriteInputSchema } from "./interface.js";
import { validatePath } from "./path-guard.js";
import type { WikiWriteQueue } from "./queue.js";

const MAX_STALE_RETRIES = 3;

export interface WikiWriteDeps {
  readonly adapter: WikiAdapter;
  readonly queue: WikiWriteQueue;
  readonly deleteCap: DeleteCap;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly instanceId: string;
}

export interface WikiWriteResult {
  readonly sha: string;
}

function buildCommitMessage(
  input: WikiWriteInput,
  instanceId: string,
): string {
  // First line: `${tag} ${description}` — downstream audit greps key
  // on the tag prefix (CONVENTIONS §4.2).
  const firstLine = `${input.tag} ${input.description}`;

  const trailerLines: string[] = [];
  if (input.coAuthors !== undefined) {
    for (const co of input.coAuthors) {
      trailerLines.push(`Co-authored-by: ${co.name} <${co.email}>`);
    }
  }
  // `Opencoo-Instance` trailer always last so consumers find it at a
  // stable position regardless of coAuthor count.
  trailerLines.push(`Opencoo-Instance: ${instanceId}`);

  const parts = [firstLine];
  if (input.body !== undefined && input.body.length > 0) {
    parts.push("", input.body);
  }
  parts.push("", trailerLines.join("\n"));
  return parts.join("\n");
}

export async function wikiWrite(
  deps: WikiWriteDeps,
  rawInput: WikiWriteInput,
): Promise<WikiWriteResult> {
  let input: WikiWriteInput;
  try {
    input = WikiWriteInputSchema.parse(rawInput);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new WikiWriteInputError(
        `wiki-write input failed validation: ${err.message}`,
        { cause: err },
      );
    }
    throw err;
  }

  // Path-guard BEFORE queue/cap: a bad path is a caller bug, fail
  // fast and leave no queue slot or cap budget consumed.
  for (const op of input.operations) {
    validatePath(op.path);
  }

  // Delete-cap check also BEFORE the queue. Engine callers are
  // capped; admin caller bypasses entirely. Reserve-at-entry:
  // retries don't refund budget.
  const deleteCount = input.operations.filter(
    (op) => op.mode === "delete",
  ).length;
  if (deleteCount > 0 && input.caller.kind !== "admin") {
    deps.deleteCap.reserve(
      input.domainSlug as DomainSlug,
      deleteCount,
      deps.clock(),
    );
  }

  return deps.queue.enqueue(
    input.domainSlug as DomainSlug,
    () => runWithRetries(deps, input),
  );
}

async function runWithRetries(
  deps: WikiWriteDeps,
  input: WikiWriteInput,
): Promise<WikiWriteResult> {
  const message = buildCommitMessage(input, deps.instanceId);
  let lastStaleSha: string | null = null;
  for (let attempt = 1; attempt <= MAX_STALE_RETRIES; attempt++) {
    const parentSha = await deps.adapter.getHeadSha(
      input.domainSlug as DomainSlug,
    );
    const writeArgs: WriteAtomicArgs = {
      domainSlug: input.domainSlug as DomainSlug,
      operations: input.operations,
      commitMessage: message,
      author: input.author,
      parentSha,
      // Conditional spread keeps `coAuthors` absent (not `undefined`)
      // when the caller omitted it — required under
      // `exactOptionalPropertyTypes`.
      ...(input.coAuthors !== undefined
        ? { coAuthors: input.coAuthors }
        : {}),
    };
    const result = await deps.adapter.writeAtomic(writeArgs);
    if (result.status === "ok") {
      deps.logger.info("wiki.write", {
        domain_slug: input.domainSlug,
        tag: input.tag,
        sha: result.sha,
        ops: input.operations.length,
      });
      return { sha: result.sha };
    }
    lastStaleSha = result.currentSha;
    deps.logger.warn("wiki.write.stale", {
      domain_slug: input.domainSlug,
      attempt,
      current_sha: result.currentSha,
    });
  }
  throw new WikiWriteStaleError(
    `wiki-write for ${input.domainSlug} went stale ${MAX_STALE_RETRIES} times in a row (last currentSha=${lastStaleSha ?? "<none>"})`,
  );
}
