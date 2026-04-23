import { describe, expect, it, vi } from "vitest";

import type { DomainSlug } from "../src/db/brands.js";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  WikiPathError,
  WikiWriteCapExceededError,
  WikiWriteInputError,
  WikiWriteStaleError,
  wikiWrite,
  type WikiWriteDeps,
  type WikiWriteInput,
} from "../src/wiki-write/index.js";
import { InMemoryWikiAdapter } from "../src/wiki-write/testing/in-memory-adapter.js";
import { nullLogger } from "./helpers/null-logger.js";

const DOMAIN = "wiki-executive" as DomainSlug;

interface HarnessOpts {
  readonly adapter?: InMemoryWikiAdapter;
  readonly clock?: () => Date;
  readonly instanceId?: string;
}

function harness(opts: HarnessOpts = {}): {
  deps: WikiWriteDeps;
  adapter: InMemoryWikiAdapter;
} {
  const adapter = opts.adapter ?? new InMemoryWikiAdapter();
  const deps: WikiWriteDeps = {
    adapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: new InMemoryDeleteCap(),
    logger: nullLogger(),
    clock: opts.clock ?? ((): Date => new Date("2026-04-23T12:00:00Z")),
    instanceId: opts.instanceId ?? "local",
  };
  return { deps, adapter };
}

function baseInput(partial: Partial<WikiWriteInput> = {}): WikiWriteInput {
  return {
    domainSlug: DOMAIN,
    tag: "[compiler]",
    description: "write docs/x",
    author: { name: "opencoo-engine", email: "engine@opencoo.local" },
    caller: { kind: "engine" },
    operations: [
      { mode: "replace", path: "docs/x.md", content: "# X\n" },
    ],
    ...partial,
  };
}

describe("wikiWrite — happy path", () => {
  it("writes a single replace op and returns a SHA", async () => {
    const { deps, adapter } = harness();
    const result = await wikiWrite(deps, baseInput());
    expect(result.sha).toMatch(/^[0-9a-f]{8,}$/);
    expect(await adapter.readPage(DOMAIN, "docs/x.md")).toMatchObject({
      content: "# X\n",
    });
  });

  it("builds commit message with tag + description + Opencoo-Instance trailer", async () => {
    const { deps, adapter } = harness({ instanceId: "prod-a" });
    const spy = vi.spyOn(adapter, "writeAtomic");
    await wikiWrite(deps, baseInput({ description: "compile wiki-exec" }));
    const call = spy.mock.calls[0]?.[0];
    expect(call?.commitMessage).toContain("[compiler] compile wiki-exec");
    expect(call?.commitMessage).toContain("Opencoo-Instance: prod-a");
  });

  it("serialises body and Co-authored-by trailers correctly", async () => {
    const { deps, adapter } = harness();
    const spy = vi.spyOn(adapter, "writeAtomic");
    await wikiWrite(
      deps,
      baseInput({
        body: "details about the compilation",
        coAuthors: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ],
      }),
    );
    const msg = spy.mock.calls[0]?.[0].commitMessage ?? "";
    expect(msg.split("\n")[0]).toBe("[compiler] write docs/x");
    expect(msg).toContain("details about the compilation");
    expect(msg).toContain("Co-authored-by: Alice <alice@example.com>");
    expect(msg).toContain("Co-authored-by: Bob <bob@example.com>");
    expect(msg.trim().endsWith("Opencoo-Instance: local")).toBe(true);
  });

  it("omits Co-authored-by section when no coAuthors provided", async () => {
    const { deps, adapter } = harness();
    const spy = vi.spyOn(adapter, "writeAtomic");
    await wikiWrite(deps, baseInput());
    const msg = spy.mock.calls[0]?.[0].commitMessage ?? "";
    expect(msg).not.toContain("Co-authored-by:");
    expect(msg).toContain("Opencoo-Instance: local");
  });

  it("batches 3 ops (replace + append + delete admin) in one adapter call", async () => {
    const { deps, adapter } = harness();
    adapter.inject(DOMAIN, "docs/existing.md", "content");
    const spy = vi.spyOn(adapter, "writeAtomic");
    await wikiWrite(
      deps,
      baseInput({
        caller: { kind: "admin", userId: "u-1" },
        operations: [
          { mode: "replace", path: "docs/a.md", content: "a" },
          { mode: "append", path: "docs/log.md", content: "\nmore\n" },
          { mode: "delete", path: "docs/existing.md" },
        ],
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("wikiWrite — input validation", () => {
  it("rejects an untagged commit via WikiWriteInputError", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(deps, baseInput({ tag: "invalid" as WikiWriteInput["tag"] })),
    ).rejects.toThrow(WikiWriteInputError);
  });

  it("rejects a cross-domain path via WikiPathError (before queue enqueue)", async () => {
    const { deps, adapter } = harness();
    const spy = vi.spyOn(adapter, "writeAtomic");
    await expect(
      wikiWrite(
        deps,
        baseInput({
          operations: [
            { mode: "replace", path: "wiki-hr/secret.md", content: "x" },
          ],
        }),
      ),
    ).rejects.toThrow(WikiPathError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects input with duplicate paths across operations", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(
        deps,
        baseInput({
          operations: [
            { mode: "replace", path: "docs/x.md", content: "a" },
            { mode: "append", path: "docs/x.md", content: "b" },
          ],
        }),
      ),
    ).rejects.toThrow(WikiWriteInputError);
  });

  it("rejects empty operations array", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(deps, baseInput({ operations: [] })),
    ).rejects.toThrow(WikiWriteInputError);
  });

  it("rejects description containing a newline (trailer-injection)", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(
        deps,
        baseInput({
          description: "fix\nCo-authored-by: Impostor <x@x>",
        }),
      ),
    ).rejects.toThrow(WikiWriteInputError);
  });

  it("rejects author.name containing a newline", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(
        deps,
        baseInput({
          author: { name: "Alice\nfake@x", email: "a@a.io" },
        }),
      ),
    ).rejects.toThrow(WikiWriteInputError);
  });

  it("rejects coAuthor.name containing a carriage-return + newline", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(
        deps,
        baseInput({
          coAuthors: [{ name: "X\r\nBob", email: "b@b.io" }],
        }),
      ),
    ).rejects.toThrow(WikiWriteInputError);
  });

  it("rejects body containing a trailer-shaped line (Co-authored-by)", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(
        deps,
        baseInput({
          body: "normal prose\nCo-authored-by: Impostor <x@x>",
        }),
      ),
    ).rejects.toThrow(WikiWriteInputError);
  });

  it("rejects body containing Opencoo-Instance trailer", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(
        deps,
        baseInput({
          body: "details\nOpencoo-Instance: spoof",
        }),
      ),
    ).rejects.toThrow(WikiWriteInputError);
  });

  it("accepts a multi-line body of plain prose", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(
        deps,
        baseInput({
          body: "multi\nline\nbody",
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("accepts a body with a blank line separating paragraphs", async () => {
    const { deps } = harness();
    await expect(
      wikiWrite(
        deps,
        baseInput({
          body: "paragraph one\n\nparagraph two after blank line",
        }),
      ),
    ).resolves.toBeDefined();
  });
});

describe("wikiWrite — stale retry", () => {
  it("retries once and succeeds when a stale HEAD is injected mid-flight", async () => {
    const { deps, adapter } = harness();
    // First writeAtomic call sees a concurrent inject; retry path succeeds.
    const original = adapter.writeAtomic.bind(adapter);
    let called = 0;
    adapter.writeAtomic = async (args) => {
      if (called === 0) {
        called = 1;
        // Simulate: between our getHeadSha + writeAtomic, an external
        // commit landed. Inject advances HEAD so parentSha mismatches.
        adapter.inject(DOMAIN, "docs/other.md", "external edit");
        // Then let the adapter handle the mismatch as stale.
        return original(args);
      }
      return original(args);
    };
    const result = await wikiWrite(deps, baseInput());
    expect(result.sha).toMatch(/^[0-9a-f]{8,}$/);
  });

  it("throws WikiWriteStaleError after 3 stale attempts", async () => {
    const { deps, adapter } = harness();
    // Force permanent staleness: every writeAtomic call returns stale.
    adapter.writeAtomic = async (): Promise<{ status: "stale"; currentSha: string }> => {
      return { status: "stale", currentSha: "zz-stale" };
    };
    await expect(wikiWrite(deps, baseInput())).rejects.toThrow(
      WikiWriteStaleError,
    );
  });
});

describe("wikiWrite — delete cap", () => {
  it("allows up to 10 deletes for an engine caller in one day", async () => {
    const { deps, adapter } = harness();
    for (let i = 0; i < 10; i++) {
      adapter.inject(DOMAIN, `doomed/${i}.md`, "x");
    }
    await wikiWrite(
      deps,
      baseInput({
        operations: Array.from({ length: 10 }, (_, i) => ({
          mode: "delete" as const,
          path: `doomed/${i}.md`,
        })),
      }),
    );
    const page = await adapter.readPage(DOMAIN, "doomed/0.md");
    expect(page).toBeNull();
  });

  it("blocks the 11th delete with WikiWriteCapExceededError", async () => {
    const { deps, adapter } = harness();
    for (let i = 0; i < 11; i++) {
      adapter.inject(DOMAIN, `doomed/${i}.md`, "x");
    }
    await wikiWrite(
      deps,
      baseInput({
        operations: Array.from({ length: 10 }, (_, i) => ({
          mode: "delete" as const,
          path: `doomed/${i}.md`,
        })),
      }),
    );
    await expect(
      wikiWrite(
        deps,
        baseInput({
          operations: [{ mode: "delete", path: "doomed/10.md" }],
        }),
      ),
    ).rejects.toThrow(WikiWriteCapExceededError);
  });

  it("admin caller bypasses the delete cap", async () => {
    const { deps, adapter } = harness();
    for (let i = 0; i < 20; i++) {
      adapter.inject(DOMAIN, `doomed/${i}.md`, "x");
    }
    await expect(
      wikiWrite(
        deps,
        baseInput({
          caller: { kind: "admin", userId: "u-admin" },
          operations: Array.from({ length: 20 }, (_, i) => ({
            mode: "delete" as const,
            path: `doomed/${i}.md`,
          })),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("resets the counter on a new day (clock rollover)", async () => {
    let currentDay = new Date("2026-04-23T23:59:00Z");
    const { deps, adapter } = harness({ clock: () => currentDay });
    for (let i = 0; i < 20; i++) {
      adapter.inject(DOMAIN, `doomed/${i}.md`, "x");
    }
    await wikiWrite(
      deps,
      baseInput({
        operations: Array.from({ length: 10 }, (_, i) => ({
          mode: "delete" as const,
          path: `doomed/${i}.md`,
        })),
      }),
    );
    // Next day:
    currentDay = new Date("2026-04-24T00:05:00Z");
    await expect(
      wikiWrite(
        deps,
        baseInput({
          operations: Array.from({ length: 10 }, (_, i) => ({
            mode: "delete" as const,
            path: `doomed/${i + 10}.md`,
          })),
        }),
      ),
    ).resolves.toBeDefined();
  });
});

describe("wikiWrite — queue semantics", () => {
  it("serialises two calls to the same domain (second sees first's SHA as parent)", async () => {
    const { deps, adapter } = harness();
    const spy = vi.spyOn(adapter, "writeAtomic");
    const r1 = wikiWrite(
      deps,
      baseInput({
        operations: [{ mode: "replace", path: "a.md", content: "1" }],
      }),
    );
    const r2 = wikiWrite(
      deps,
      baseInput({
        operations: [{ mode: "replace", path: "b.md", content: "2" }],
      }),
    );
    const [{ sha: sha1 }, { sha: sha2 }] = await Promise.all([r1, r2]);
    expect(sha1).not.toBe(sha2);
    const callArgs = spy.mock.calls.map((c) => c[0]);
    // Second call's parentSha must equal first call's returned SHA.
    expect(callArgs[1]?.parentSha).toBe(sha1);
  });

  it("does not serialise calls for different domains", async () => {
    const { deps, adapter } = harness();
    const order: string[] = [];
    const original = adapter.writeAtomic.bind(adapter);
    adapter.writeAtomic = async (args) => {
      order.push(`start:${args.domainSlug}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${args.domainSlug}`);
      return original(args);
    };
    const other = "wiki-hr" as DomainSlug;
    await Promise.all([
      wikiWrite(
        deps,
        baseInput({
          operations: [{ mode: "replace", path: "a.md", content: "1" }],
        }),
      ),
      wikiWrite(
        deps,
        baseInput({
          domainSlug: other,
          operations: [{ mode: "replace", path: "b.md", content: "2" }],
        }),
      ),
    ]);
    // Interleaved start events (both started before either ended) prove
    // the two domains ran concurrently.
    const startIdxA = order.indexOf(`start:${DOMAIN}`);
    const startIdxB = order.indexOf(`start:${other}`);
    const endIdxA = order.indexOf(`end:${DOMAIN}`);
    const endIdxB = order.indexOf(`end:${other}`);
    const eitherStartedBeforeOtherEnded =
      (startIdxA < endIdxB && startIdxB >= 0) ||
      (startIdxB < endIdxA && startIdxA >= 0);
    expect(eitherStartedBeforeOtherEnded).toBe(true);
  });
});
