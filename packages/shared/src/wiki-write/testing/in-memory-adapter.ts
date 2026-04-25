import { createHash } from "node:crypto";

import type { DomainSlug } from "../../db/brands.js";
import { validatePath } from "../path-guard.js";
import type {
  WikiAdapter,
  WikiOperation,
  WriteAtomicArgs,
  WriteAtomicResult,
} from "../interface.js";

interface StoredPage {
  readonly sha: string;
  readonly content: string;
}

interface DomainState {
  head: string;
  pages: Map<string, StoredPage>;
}

const INITIAL_HEAD = "0000000000000000";

function nextSha(prevHead: string, serialisedOps: string): string {
  return createHash("sha256")
    .update(prevHead)
    .update("\n")
    .update(serialisedOps)
    .digest("hex")
    .slice(0, 16);
}

function serialiseOps(ops: ReadonlyArray<WikiOperation>): string {
  return ops
    .map((op) => {
      if (op.mode === "delete") return `D ${op.path}`;
      return `${op.mode === "replace" ? "R" : "A"} ${op.path}\n${op.content}`;
    })
    .join("\n\0\n");
}

// In-memory WikiAdapter fixture used by use-case tests. Per-domain
// state: a Map<path, {sha, content}> plus a current HEAD sha. Each
// `writeAtomic` call derives the next HEAD from `sha256(prevHead ||
// serialisedOps)` so two identical ops on the same base state
// produce the same SHA (deterministic; test-friendly).
//
// The `inject` method is the TEST-ONLY backdoor tests use to
// simulate an external write that advances HEAD without going
// through the adapter's `writeAtomic`. Production code must never
// touch it — it's marked `@internal`.
export class InMemoryWikiAdapter implements WikiAdapter {
  private readonly domains: Map<DomainSlug, DomainState> = new Map();

  async getHeadSha(domainSlug: DomainSlug): Promise<string> {
    return this.stateOf(domainSlug).head;
  }

  async readPage(
    domainSlug: DomainSlug,
    path: string,
  ): Promise<{ sha: string; content: string } | null> {
    const state = this.domains.get(domainSlug);
    const page = state?.pages.get(path);
    if (page === undefined) return null;
    return { sha: page.sha, content: page.content };
  }

  async writeAtomic(args: WriteAtomicArgs): Promise<WriteAtomicResult> {
    // Defense-in-depth path-guard. wikiWrite() already validates paths
    // before reaching here, but the adapter may also be called directly
    // by future tooling (CLI, recovery scripts). The contract suite
    // (wiki-adapter.ts assertion #11) locks this rejection for every
    // backend.
    for (const op of args.operations) {
      validatePath(op.path);
    }
    const state = this.stateOf(args.domainSlug);
    if (args.parentSha !== state.head) {
      return { status: "stale", currentSha: state.head };
    }
    const newHead = nextSha(state.head, serialiseOps(args.operations));
    for (const op of args.operations) {
      if (op.mode === "delete") {
        state.pages.delete(op.path);
      } else {
        const prev = state.pages.get(op.path);
        const content =
          op.mode === "append" && prev !== undefined
            ? prev.content + op.content
            : op.content;
        state.pages.set(op.path, { sha: newHead, content });
      }
    }
    state.head = newHead;
    return { status: "ok", sha: newHead };
  }

  async listMarkdown(domainSlug: DomainSlug): Promise<readonly string[]> {
    const state = this.domains.get(domainSlug);
    if (state === undefined) return [];
    const out: string[] = [];
    for (const path of state.pages.keys()) {
      if (path.endsWith(".md")) out.push(path);
    }
    out.sort();
    return out;
  }

  /** @internal TEST ONLY — advance HEAD by a simulated external write. */
  inject(domainSlug: DomainSlug, path: string, content: string): void {
    const state = this.stateOf(domainSlug);
    const newHead = nextSha(state.head, `INJECT ${path}\n${content}`);
    state.pages.set(path, { sha: newHead, content });
    state.head = newHead;
  }

  private stateOf(domainSlug: DomainSlug): DomainState {
    let state = this.domains.get(domainSlug);
    if (state === undefined) {
      state = { head: INITIAL_HEAD, pages: new Map() };
      this.domains.set(domainSlug, state);
    }
    return state;
  }
}
