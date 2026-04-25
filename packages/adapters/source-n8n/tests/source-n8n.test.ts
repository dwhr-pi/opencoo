/**
 * source-n8n adapter tests (PR 26 / plan #122).
 *
 * Two layers:
 *   1. The shared sourceAdapterContract (polling mode) against
 *      the n8n adapter wired with makeMockN8nListing.
 *   2. Adapter-specific tests: binding-config Zod, tag filter
 *      defense-in-depth, sourceRevision stability across
 *      updatedAt-only changes, 1 MiB ceiling, slug, credentials
 *      via CredentialStore (THREAT-MODEL §3.6 invariant 11
 *      type-pin), cursor semantics, contentKind always emitted
 *      as 'n8n-workflow'.
 */
import { describe, expect, it } from "vitest";

import { sourceAdapterContract } from "@opencoo/shared/adapter-contract-tests";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  N8N_ADAPTER_SLUG,
  N8N_DEFAULT_TAG_FILTER,
  createN8nSourceAdapter,
  n8nBindingConfigSchema,
  type N8nBindingConfig,
} from "../src/index.js";
import { computeWorkflowRevision } from "../src/canonical-bytes.js";
import type { N8nWorkflowSummary } from "../src/n8n-listing-api.js";
import {
  createMockN8nListingState,
  makeMockN8nListing,
} from "../src/testing/mock-n8n-listing.js";

const TEST_TAG = "catalog";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedToken(
  store: CredentialStore,
): Promise<CredentialId> {
  return store.write({
    name: "n8n-test-pat",
    schemaRef: "n8n-source/v1",
    plaintext: Buffer.from("n8n_token_test_only"),
  });
}

interface MakeFixtureOptions {
  readonly config?: Partial<N8nBindingConfig> & { baseUrl: string };
  readonly wrapStore?: (store: CredentialStore) => CredentialStore;
}

interface N8nTestFixture {
  readonly store: CredentialStore;
  readonly credentialId: CredentialId;
  readonly state: ReturnType<typeof createMockN8nListingState>;
  readonly adapter: ReturnType<typeof createN8nSourceAdapter>;
}

async function makeFixture(
  opts: MakeFixtureOptions = {},
): Promise<N8nTestFixture> {
  const baseStore = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await seedToken(baseStore);
  const store = opts.wrapStore !== undefined ? opts.wrapStore(baseStore) : baseStore;
  const state = createMockN8nListingState();
  const adapter = createN8nSourceAdapter({
    credentialStore: store,
    credentialId,
    config: opts.config ?? { baseUrl: "https://n8n.example.test" },
    makeApi: makeMockN8nListing({ state }),
  });
  return { store, credentialId, state, adapter };
}

// Build a minimal n8n workflow shape for tests. id, name, tags,
// nodes, connections, settings + updatedAt (which the adapter
// must strip before computing sourceRevision).
function buildWorkflow(overrides: {
  id: string;
  name: string;
  tags?: readonly string[];
  nodes?: readonly unknown[];
  updatedAt?: string;
  active?: boolean;
}): N8nWorkflowSummary {
  return {
    id: overrides.id,
    name: overrides.name,
    active: overrides.active ?? false,
    tags: overrides.tags ?? [TEST_TAG],
    nodes: overrides.nodes ?? [],
    connections: {},
    settings: {},
    updatedAt: overrides.updatedAt ?? "2026-04-25T10:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Shared sourceAdapterContract — polling
// ---------------------------------------------------------------------------

sourceAdapterContract({
  backendName: "source-n8n",
  mode: "polling",
  makeAdapter: async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedToken(store);
    const state = createMockN8nListingState();
    const config: N8nBindingConfig = {
      baseUrl: "https://n8n.example.test",
      tagFilter: [TEST_TAG],
      contentKind: "n8n-workflow",
    };
    const adapter = createN8nSourceAdapter({
      credentialStore: store,
      credentialId,
      config,
      makeApi: makeMockN8nListing({ state }),
    });
    return {
      adapter,
      seed: (initial) => {
        for (const seed of initial) {
          // The contract suite seeds via SourceChangedDocument-like
          // shape; we re-hydrate as a minimal n8n workflow with a
          // stable id + nodes-list derived from the seed bytes.
          const id = seed.sourceDocId.replace(/^n8n:/, "");
          state.workflows.push(
            buildWorkflow({
              id,
              name: `seed-${id}`,
              nodes: [
                { name: "noop", type: "n8n-nodes-base.NoOp" },
                // Dump the seed bytes as a node parameter so revision
                // can vary between seeds.
                { parameters: { seed: seed.contentBytes.toString("utf8") } },
              ],
            }),
          );
        }
      },
      simulate: {
        addDoc: (doc) => {
          const id = doc.sourceDocId.replace(/^n8n:/, "");
          state.workflows.push(
            buildWorkflow({
              id,
              name: `add-${id}`,
              nodes: [
                { parameters: { seed: doc.contentBytes.toString("utf8") } },
              ],
            }),
          );
        },
        bumpRevision: (sourceDocId, _rev, bytes) => {
          const id = sourceDocId.replace(/^n8n:/, "");
          const wf = state.workflows.find((w) => w.id === id);
          if (wf === undefined) return;
          wf.nodes = [{ parameters: { seed: bytes.toString("utf8") } }];
          wf.updatedAt = new Date(Date.now() + 1).toISOString();
        },
        removeDoc: (sourceDocId) => {
          const id = sourceDocId.replace(/^n8n:/, "");
          const idx = state.workflows.findIndex((w) => w.id === id);
          if (idx >= 0) state.workflows.splice(idx, 1);
        },
      },
      cleanup: async () => undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// Binding-config schema
// ---------------------------------------------------------------------------

describe("source-n8n — binding-config schema", () => {
  it("requires baseUrl", () => {
    expect(() => n8nBindingConfigSchema.parse({})).toThrow();
  });

  it("defaults tagFilter to ['catalog']", () => {
    const parsed = n8nBindingConfigSchema.parse({
      baseUrl: "https://n8n.example.test",
    });
    expect(parsed.tagFilter).toEqual([...N8N_DEFAULT_TAG_FILTER]);
    expect(parsed.tagFilter).toEqual(["catalog"]);
  });

  it("defaults contentKind to 'n8n-workflow'", () => {
    const parsed = n8nBindingConfigSchema.parse({
      baseUrl: "https://n8n.example.test",
    });
    expect(parsed.contentKind).toBe("n8n-workflow");
  });

  it("rejects unknown top-level fields (.strict)", () => {
    expect(() =>
      n8nBindingConfigSchema.parse({
        baseUrl: "https://n8n.example.test",
        ghost: "no",
      }),
    ).toThrow();
  });

  it("rejects empty baseUrl", () => {
    expect(() => n8nBindingConfigSchema.parse({ baseUrl: "" })).toThrow();
  });

  it("rejects empty tagFilter", () => {
    expect(() =>
      n8nBindingConfigSchema.parse({
        baseUrl: "https://n8n.example.test",
        tagFilter: [],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Adapter wiring
// ---------------------------------------------------------------------------

describe("source-n8n — adapter wiring", () => {
  it("slug is 'n8n'", async () => {
    const { adapter } = await makeFixture();
    expect(adapter.slug).toBe(N8N_ADAPTER_SLUG);
    expect(adapter.slug).toBe("n8n");
  });

  it("emits sourceRef in the form 'n8n:<id>'", async () => {
    const { state, adapter } = await makeFixture();
    state.workflows.push(buildWorkflow({ id: "wf-001", name: "alpha" }));
    const result = await adapter.scan({ cursor: null });
    expect(result.documents[0]?.sourceRef).toBe("n8n:wf-001");
  });

  it("filters out workflows whose tags don't intersect tagFilter (defense-in-depth)", async () => {
    // Inject a deliberately-misbehaving listing API that returns
    // BOTH on-tag and off-tag workflows regardless of `tagFilter`
    // — this simulates an n8n upstream whose tag query is broken
    // OR a workflow whose tags were edited mid-scan to no longer
    // match. The adapter's post-filter is the ONLY thing dropping
    // the off-tag result here. Using `makeMockN8nListing` would
    // server-side filter by tag and leave the post-filter
    // unexercised — this targeted test keeps the assertion honest.
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedToken(store);
    const adapter = createN8nSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        baseUrl: "https://example.test",
        tagFilter: ["catalog"],
      } satisfies N8nBindingConfig,
      makeApi: () => ({
        listWorkflows: async () => ({
          workflows: [
            buildWorkflow({ id: "in-cat", name: "in", tags: ["catalog"] }),
            buildWorkflow({ id: "off-cat", name: "off", tags: ["other"] }),
          ],
          nextCursor: null,
        }),
      }),
    });
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["in-cat"]);
  });

  it("queries the listing API with the binding's tagFilter (passes through)", async () => {
    const { state, adapter } = await makeFixture();
    await adapter.scan({ cursor: null });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.tagFilter).toEqual(["catalog"]);
  });

  it("contentBytes is the workflow JSON minus top-level updatedAt", async () => {
    const { state, adapter } = await makeFixture();
    state.workflows.push(buildWorkflow({ id: "wf-ub", name: "ub" }));
    const result = await adapter.scan({ cursor: null });
    const doc = result.documents[0];
    expect(doc).toBeDefined();
    const parsed = JSON.parse(doc!.contentBytes.toString("utf8")) as Record<string, unknown>;
    expect("updatedAt" in parsed).toBe(false);
    expect(parsed["id"]).toBe("wf-ub");
    expect(parsed["name"]).toBe("ub");
  });

  it("emits documents with contentKind-aligned fence-language path (sourceRef carries the slug, not contentKind)", async () => {
    const { state, adapter } = await makeFixture();
    state.workflows.push(buildWorkflow({ id: "wf-x", name: "x" }));
    const result = await adapter.scan({ cursor: null });
    // The contentKind is on the binding (read by the engine);
    // the adapter doesn't replicate it on the document.
    expect(result.documents[0]?.sourceRef.startsWith("n8n:")).toBe(true);
  });

  it("invalid binding config (missing baseUrl) throws at factory time, not scan time", async () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await seedToken(store);
    expect(() =>
      createN8nSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {},
        makeApi: makeMockN8nListing({ state: createMockN8nListingState() }),
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// sourceRevision — stable across updatedAt-only changes
// ---------------------------------------------------------------------------

describe("source-n8n — sourceRevision (canonical bytes minus updatedAt)", () => {
  it("is sha256-derived and 16 hex chars long", async () => {
    const { state, adapter } = await makeFixture();
    state.workflows.push(buildWorkflow({ id: "rev-1", name: "r1" }));
    const result = await adapter.scan({ cursor: null });
    const rev = result.documents[0]?.sourceRevision ?? "";
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable when ONLY updatedAt changes (replay-stable)", async () => {
    const wf = buildWorkflow({ id: "rev-stable", name: "rs" });
    const rev1 = computeWorkflowRevision(wf);
    const rev2 = computeWorkflowRevision({
      ...wf,
      updatedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(rev1).toBe(rev2);
  });

  it("changes when nodes change", async () => {
    const wf = buildWorkflow({ id: "rev-c", name: "rc" });
    const rev1 = computeWorkflowRevision(wf);
    const rev2 = computeWorkflowRevision({
      ...wf,
      nodes: [{ added: true }],
    });
    expect(rev1).not.toBe(rev2);
  });

  it("is order-independent for object keys (canonical sort)", async () => {
    const a = computeWorkflowRevision({
      id: "k",
      name: "k",
      tags: ["catalog"],
      nodes: [],
      connections: {},
      settings: { foo: 1, bar: 2 },
      active: false,
      updatedAt: "2026-04-25T00:00:00.000Z",
    });
    const b = computeWorkflowRevision({
      // Same content but with a different key order in the object
      // literal — JS preserves insertion order so the canonical
      // bytes must sort.
      settings: { bar: 2, foo: 1 },
      tags: ["catalog"],
      active: false,
      nodes: [],
      name: "k",
      id: "k",
      connections: {},
      updatedAt: "different",
    });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Credentials — CredentialStore is the only source (THREAT-MODEL §3.6)
// ---------------------------------------------------------------------------

describe("source-n8n — credentials sourcing (THREAT-MODEL §3.6 invariant 11)", () => {
  it("factory rejects inline credential strings at the type level", () => {
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const fakeInlineCreds = { token: "y" };
    // @ts-expect-error — invariant 11: no inline credentials accepted.
    void (() =>
      createN8nSourceAdapter({
        credentialStore: store,
        config: { baseUrl: "https://n8n.example.test" },
        creds: fakeInlineCreds,
        makeApi: () => ({}) as never,
      }));
    expect(typeof store.read).toBe("function");
  });

  it("reads the token from the CredentialStore on every scan (rotation-friendly)", async () => {
    let readCount = 0;
    const { state, adapter } = await makeFixture({
      wrapStore: (store) => ({
        read: (id) => {
          readCount += 1;
          return store.read(id);
        },
        write: (input) => store.write(input),
        rotate: (id, plaintext) => store.rotate(id, plaintext),
        delete: (id) => store.delete(id),
      }),
    });
    state.workflows.push(buildWorkflow({ id: "rot-1", name: "r" }));
    await adapter.scan({ cursor: null });
    await adapter.scan({ cursor: "anything" });
    expect(readCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 1 MiB ceiling
// ---------------------------------------------------------------------------

describe("source-n8n — 1 MiB ceiling (contract assertion 7)", () => {
  it("skips workflows whose canonical-bytes form exceeds 1 MiB", async () => {
    const { state, adapter } = await makeFixture();
    // Build a giant nodes array — contentBytes for this exceeds 1 MiB.
    const fatNodes: unknown[] = [];
    for (let i = 0; i < 50_000; i++) {
      fatNodes.push({ name: `node-${i}`, parameters: { foo: "x".repeat(64) } });
    }
    state.workflows.push(
      buildWorkflow({ id: "fat", name: "fat", nodes: fatNodes }),
    );
    state.workflows.push(buildWorkflow({ id: "thin", name: "thin" }));
    const result = await adapter.scan({ cursor: null });
    expect(result.documents.map((d) => d.sourceDocId)).toEqual(["thin"]);
  });
});

// ---------------------------------------------------------------------------
// Cursor semantics
// ---------------------------------------------------------------------------

describe("source-n8n — cursor semantics", () => {
  it("first scan with cursor=null sets a cursor (since-timestamp ISO)", async () => {
    const { state, adapter } = await makeFixture();
    state.workflows.push(buildWorkflow({ id: "c-1", name: "c1" }));
    const result = await adapter.scan({ cursor: null });
    expect(result.nextCursor).not.toBeNull();
    // ISO-8601 shape.
    expect(result.nextCursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("passes the cursor through to the listing API as `since`", async () => {
    const { state, adapter } = await makeFixture();
    await adapter.scan({ cursor: "2026-01-01T00:00:00Z" });
    expect(state.calls[0]?.since).toBe("2026-01-01T00:00:00Z");
  });
});
