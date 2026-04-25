/**
 * Reusable contract suite for the `WikiAdapter` port (THREAT-MODEL §2
 * invariant 2). Every backend that satisfies the port — the in-memory
 * fixture, the Gitea adapter, a future GitHub or GitLab adapter — runs
 * this exact 13-assertion matrix so the boundary stays port-faithful
 * across them all.
 *
 * Why this lives in `@opencoo/shared`:
 *
 * - `wikiWrite()` (the orchestrator) is itself in this package, so the
 *   contract sits next to the source of truth for the port.
 * - Adapter packages depend on `@opencoo/shared` already; importing the
 *   suite from here costs zero dependency surface.
 * - Two backends sharing the same suite means a port-shape regression in
 *   ONE blocks BOTH — drift is impossible by construction.
 *
 * Pass-through invariants the suite locks (Correction A from PR-11):
 *
 * - The adapter MUST use `WriteAtomicArgs.commitMessage` byte-for-byte.
 *   `wikiWrite()` already builds the full message (tag, description,
 *   body, Co-authored-by trailers, Opencoo-Instance trailer); the
 *   adapter does not reconstruct, append, strip, or normalise.
 * - `WriteAtomicArgs.coAuthors` is informational ONLY (telemetry /
 *   logging at the transport tier). Adapters MUST NOT inject those
 *   coAuthors into the commit message text — they're already in
 *   `commitMessage` if the caller wanted them there.
 * - Adapters MUST NOT alter the resulting commit's git author (it has
 *   to match `args.author` byte-for-byte name+email).
 *
 * Path-guard invariant (defense-in-depth): every backend re-validates
 * `op.path` via `validatePath()` and surfaces `WikiPathError` on
 * rejection. `wikiWrite()` ALREADY runs path-guard at orchestration
 * time, but a backend that trusts the port input would let a future
 * direct-adapter caller (a CLI tool, a misconfigured pipeline) leak
 * out-of-bounds writes. Belt-and-suspenders, contract-locked.
 */
import { describe, it, expect } from "vitest";

import type { DomainSlug } from "../db/brands.js";
import { WikiPathError } from "../wiki-write/errors.js";
import type {
  WikiAdapter,
  WikiAuthor,
  WriteAtomicArgs,
} from "../wiki-write/interface.js";

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

/**
 * Per-test backend handle. `cleanup` runs after each `it()` and lets
 * a network-backed adapter (Gitea) reset shared state — push a
 * fresh branch, delete the repo, whatever the backend needs. The
 * in-memory fixture's cleanup is a no-op (each test gets a fresh
 * adapter instance).
 */
export interface WikiAdapterHandle {
  readonly adapter: WikiAdapter;
  readonly cleanup: () => Promise<void>;
}

/**
 * What an adapter package passes to the contract generator.
 * `backendName` shows up in test titles so a flake on Gitea reads as
 * "wikiAdapterContract / gitea / writeAtomic.replace …".
 */
export interface WikiAdapterFixtureOptions {
  readonly backendName: string;
  /**
   * Returns a freshly-initialised adapter pointed at empty state for
   * the given domain. The contract suite calls this from inside each
   * `it()` so tests are independent.
   */
  readonly makeAdapter: (
    domainSlug: DomainSlug,
  ) => Promise<WikiAdapterHandle>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DOMAIN = "wiki-test" as DomainSlug;

const AUTHOR: WikiAuthor = {
  name: "opencoo-engine",
  email: "engine@opencoo.test",
};

const CO_AUTHOR: WikiAuthor = {
  name: "Reviewer Two",
  email: "reviewer-two@opencoo.test",
};

/** Build a WriteAtomicArgs from a parentSha + ops + message, with
 *  the conditional-spread coAuthors pattern wikiWrite() uses. */
function makeArgs(input: {
  parentSha: string;
  operations: WriteAtomicArgs["operations"];
  commitMessage: string;
  coAuthors?: ReadonlyArray<WikiAuthor>;
  author?: WikiAuthor;
}): WriteAtomicArgs {
  return {
    domainSlug: DOMAIN,
    operations: input.operations,
    commitMessage: input.commitMessage,
    author: input.author ?? AUTHOR,
    parentSha: input.parentSha,
    ...(input.coAuthors !== undefined ? { coAuthors: input.coAuthors } : {}),
  };
}

/**
 * Some backends (Gitea) record the resulting commit's author/message
 * server-side; some (in-memory) only return a sha and require the test
 * to read state back through the port. The contract abstracts that:
 * if the backend exposes commit metadata via an opt-in extension
 * interface, we use it; otherwise the relevant assertion is skipped
 * gracefully so the port-shape contract stays valid for both.
 *
 * Adapter packages declare `inspectCommit(sha)` on the fixture HANDLE
 * (NOT the public `WikiAdapter` port) when they can support it. Tests
 * do an instanceof-style probe.
 */
export interface CommitInspector {
  inspectCommit(sha: string): Promise<{
    readonly message: string;
    readonly authorName: string;
    readonly authorEmail: string;
  }>;
}

function asInspector(handle: WikiAdapterHandle): CommitInspector | null {
  const candidate = handle as unknown as Partial<CommitInspector>;
  return typeof candidate.inspectCommit === "function"
    ? (candidate as CommitInspector)
    : null;
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * Run the 13-assertion port-shape suite against the given backend.
 * Call from inside an adapter's test file; the suite registers a
 * single top-level `describe` so the caller can add backend-specific
 * tests above or below.
 */
export function wikiAdapterContract(
  options: WikiAdapterFixtureOptions,
): void {
  describe(`wikiAdapterContract / ${options.backendName}`, () => {
    // 1. Initial-state head SHA.
    it("getHeadSha returns a stable string for an unwritten domain", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha = await handle.adapter.getHeadSha(DOMAIN);
        expect(typeof sha).toBe("string");
        expect(sha.length).toBeGreaterThan(0);
        // Calling twice without writing must be stable.
        const sha2 = await handle.adapter.getHeadSha(DOMAIN);
        expect(sha2).toBe(sha);
      } finally {
        await handle.cleanup();
      }
    });

    // 2. readPage on missing key.
    it("readPage returns null for an unknown path", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const page = await handle.adapter.readPage(DOMAIN, "missing.md");
        expect(page).toBeNull();
      } finally {
        await handle.cleanup();
      }
    });

    // 3. writeAtomic happy-path round-trip on `replace`.
    it("writeAtomic replace returns status:ok + new sha + readPage sees the content", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const parentSha = await handle.adapter.getHeadSha(DOMAIN);
        const result = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha,
            operations: [
              { mode: "replace", path: "page.md", content: "# Hello\n" },
            ],
            commitMessage: "[compiler] write page",
          }),
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(typeof result.sha).toBe("string");
        expect(result.sha).not.toBe(parentSha);

        const page = await handle.adapter.readPage(DOMAIN, "page.md");
        expect(page).not.toBeNull();
        expect(page!.content).toBe("# Hello\n");
      } finally {
        await handle.cleanup();
      }
    });

    // 4. append concatenates onto existing content.
    it("writeAtomic append concatenates onto existing content", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        const r1 = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "log.md", content: "first\n" },
            ],
            commitMessage: "[compiler] init log",
          }),
        );
        expect(r1.status).toBe("ok");
        if (r1.status !== "ok") return;

        const r2 = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: r1.sha,
            operations: [
              { mode: "append", path: "log.md", content: "second\n" },
            ],
            commitMessage: "[compiler] append log",
          }),
        );
        expect(r2.status).toBe("ok");

        const page = await handle.adapter.readPage(DOMAIN, "log.md");
        expect(page).not.toBeNull();
        expect(page!.content).toBe("first\nsecond\n");
      } finally {
        await handle.cleanup();
      }
    });

    // 5. delete removes a page.
    it("writeAtomic delete removes a page (readPage returns null)", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        const r1 = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "drop.md", content: "delete me\n" },
            ],
            commitMessage: "[compiler] add drop",
          }),
        );
        expect(r1.status).toBe("ok");
        if (r1.status !== "ok") return;

        const r2 = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: r1.sha,
            operations: [{ mode: "delete", path: "drop.md" }],
            commitMessage: "[compiler] delete drop",
          }),
        );
        expect(r2.status).toBe("ok");
        const page = await handle.adapter.readPage(DOMAIN, "drop.md");
        expect(page).toBeNull();
      } finally {
        await handle.cleanup();
      }
    });

    // 6. After ok write, getHeadSha advances.
    it("getHeadSha advances to the result.sha after an ok write", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        const result = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "h.md", content: "h\n" },
            ],
            commitMessage: "[compiler] h",
          }),
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const sha1 = await handle.adapter.getHeadSha(DOMAIN);
        expect(sha1).toBe(result.sha);
      } finally {
        await handle.cleanup();
      }
    });

    // 7. Stale-detect: race returns status:stale, never throws.
    it("writeAtomic from a stale parentSha returns status:stale + currentSha (no throw)", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        const r1 = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "race.md", content: "first\n" },
            ],
            commitMessage: "[compiler] race-first",
          }),
        );
        expect(r1.status).toBe("ok");
        if (r1.status !== "ok") return;

        // Second write claims sha0 as parent — but HEAD has moved.
        const r2 = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "race.md", content: "second\n" },
            ],
            commitMessage: "[compiler] race-second",
          }),
        );
        expect(r2.status).toBe("stale");
        if (r2.status !== "stale") return;
        expect(r2.currentSha).toBe(r1.sha);
      } finally {
        await handle.cleanup();
      }
    });

    // 8. Pass-through proof — coAuthors in args but NOT in commitMessage
    //    must NOT appear in the resulting commit. Skipped for backends
    //    that don't expose commit metadata.
    it("does NOT inject coAuthors from WriteAtomicArgs into the commit message text", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const inspector = asInspector(handle);
        if (inspector === null) return; // backend cannot answer this question
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        const messageWithoutCoAuthor =
          "[compiler] no-co-author\n\nbody only\n\nOpencoo-Instance: test";
        const result = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "p.md", content: "x\n" },
            ],
            commitMessage: messageWithoutCoAuthor,
            // coAuthor IS in args, but NOT in the message — pass-through.
            coAuthors: [CO_AUTHOR],
          }),
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const inspected = await inspector.inspectCommit(result.sha);
        expect(inspected.message).not.toMatch(/Co-authored-by:/i);
        expect(inspected.message).not.toContain(CO_AUTHOR.email);
      } finally {
        await handle.cleanup();
      }
    });

    // 9. Author preservation.
    it("commit author matches args.author byte-for-byte", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const inspector = asInspector(handle);
        if (inspector === null) return;
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        const customAuthor: WikiAuthor = {
          name: "Some Specific Engine",
          email: "specific@opencoo.test",
        };
        const result = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "a.md", content: "a\n" },
            ],
            commitMessage: "[compiler] author-check",
            author: customAuthor,
          }),
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const inspected = await inspector.inspectCommit(result.sha);
        expect(inspected.authorName).toBe(customAuthor.name);
        expect(inspected.authorEmail).toBe(customAuthor.email);
      } finally {
        await handle.cleanup();
      }
    });

    // 10. commitMessage byte-preservation. Construct a message that
    //     already carries Co-authored-by and Opencoo-Instance trailers
    //     (the shape wikiWrite() builds) and read it back identically.
    it("commitMessage is preserved byte-for-byte in the resulting commit", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const inspector = asInspector(handle);
        if (inspector === null) return;
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        const message =
          "[compiler] preserve\n\nbody line 1\nbody line 2\n\n" +
          `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>\n` +
          "Opencoo-Instance: test-instance";
        const result = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "m.md", content: "m\n" },
            ],
            commitMessage: message,
          }),
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        const inspected = await inspector.inspectCommit(result.sha);
        // Some git transports normalise the trailing newline of a
        // commit message; allow exactly one trailing-newline tolerance
        // and assert otherwise byte-faithful.
        const normalisedExpected = message.replace(/\n+$/, "");
        const normalisedActual = inspected.message.replace(/\n+$/, "");
        expect(normalisedActual).toBe(normalisedExpected);
      } finally {
        await handle.cleanup();
      }
    });

    // 11. Path-guard belt-and-suspenders.
    it("rejects out-of-policy paths with WikiPathError (defense-in-depth)", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        // `..` component is rejected by `validatePath`; the contract
        // requires every backend to echo that rejection.
        await expect(
          handle.adapter.writeAtomic(
            makeArgs({
              parentSha: sha0,
              operations: [
                { mode: "replace", path: "x/../y.md", content: "n\n" },
              ],
              commitMessage: "[compiler] bad path",
            }),
          ),
        ).rejects.toBeInstanceOf(WikiPathError);
      } finally {
        await handle.cleanup();
      }
    });

    // 12. UTF-8 round-trip with multi-byte content.
    it("preserves UTF-8 multi-byte content byte-faithfully across write+read", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        // Mix of CJK, emoji, accented Latin, RTL — exercises 1-4 byte
        // UTF-8 sequences.
        const content =
          "# 你好 — Olá — مرحبا — 🌍\n\n" +
          "Café résumé naïve façade — straße — Düsseldorf.\n";
        const result = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "utf8.md", content },
            ],
            commitMessage: "[compiler] utf8",
          }),
        );
        expect(result.status).toBe("ok");
        const page = await handle.adapter.readPage(DOMAIN, "utf8.md");
        expect(page).not.toBeNull();
        expect(page!.content).toBe(content);
      } finally {
        await handle.cleanup();
      }
    });

    // 14. listMarkdown — empty domain returns [] (no thrown error).
    it("listMarkdown returns [] for an empty domain (plan #77)", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const paths = await handle.adapter.listMarkdown(DOMAIN);
        expect(paths).toEqual([]);
      } finally {
        await handle.cleanup();
      }
    });

    // 15. listMarkdown — only `.md` files at any depth, sorted (deterministic).
    it("listMarkdown returns *.md paths only, sorted, after writes (plan #77)", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "index.md", content: "# Index\n" },
              {
                mode: "replace",
                path: "strategy/q3.md",
                content: "# Q3\n",
              },
              {
                mode: "replace",
                path: "executive/log.md",
                content: "# Log\n",
              },
              {
                mode: "replace",
                path: "data/payload.json",
                content: '{"x":1}',
              },
            ],
            commitMessage: "[compiler] seed",
          }),
        );
        const paths = await handle.adapter.listMarkdown(DOMAIN);
        // Only .md files; deterministic sort so the Index Rebuilder
        // diffs are stable run-to-run.
        expect(paths).toEqual([
          "executive/log.md",
          "index.md",
          "strategy/q3.md",
        ]);
      } finally {
        await handle.cleanup();
      }
    });

    // 16. Max body — moderately large file (100KB) survives.
    it("preserves a moderately large body (~100KB) byte-faithfully", async () => {
      const handle = await options.makeAdapter(DOMAIN);
      try {
        const sha0 = await handle.adapter.getHeadSha(DOMAIN);
        // 100KB of compressible text — single-line Markdown so the
        // backend's commit machinery handles a non-trivial blob.
        const line = "lorem ipsum dolor sit amet ".repeat(10);
        const lines: string[] = [];
        // Total target ~100_000 bytes; each line is ~270 bytes.
        for (let i = 0; i < 380; i++) lines.push(`${i}: ${line}`);
        const content = `# Big\n\n${lines.join("\n")}\n`;
        const result = await handle.adapter.writeAtomic(
          makeArgs({
            parentSha: sha0,
            operations: [
              { mode: "replace", path: "big.md", content },
            ],
            commitMessage: "[compiler] big",
          }),
        );
        expect(result.status).toBe("ok");
        const page = await handle.adapter.readPage(DOMAIN, "big.md");
        expect(page).not.toBeNull();
        expect(page!.content).toBe(content);
        expect(page!.content.length).toBeGreaterThan(50_000);
      } finally {
        await handle.cleanup();
      }
    });
  });
}
