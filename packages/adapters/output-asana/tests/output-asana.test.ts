/**
 * output-asana adapter tests (PR 24 / plan #115).
 *
 * Layers:
 *   1. Shared `outputAdapterContract` — runs the 8 assertions
 *      against the adapter wired with `makeMockAsanaApi`.
 *   2. Adapter-specific tests covering payload schema strict
 *      validation, error classification per status code,
 *      credential-store resolution.
 */
import { describe, expect, it } from "vitest";

import { outputAdapterContract } from "@opencoo/shared/adapter-contract-tests";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";
import { OutputAdapterError } from "@opencoo/shared/output-adapter";

import {
  ASANA_OUTPUT_ADAPTER_SLUG,
  asanaOutputCredentialSchema,
  asanaTaskPayloadSchema,
  createAsanaOutputAdapter,
  type AsanaTaskPayload,
} from "../src/index.js";
import {
  createMockAsanaApiState,
  makeMockAsanaApi,
} from "../src/testing/mock-asana-tasks.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedToken(
  store: CredentialStore,
): Promise<CredentialId> {
  return store.write({
    name: "asana-test-pat",
    schemaRef: "asana-pat/v1",
    plaintext: Buffer.from("asana_test_pat_12345"),
  });
}

const VALID_PAYLOAD: AsanaTaskPayload = {
  title: "Q3 deck reminder",
  notes: "Sales asked for Q3 deck status.",
  projectGid: "1214005588882595",
};

interface MakeFixtureOptions {
  /** Initial mock-API behavior. Defaults to `{kind:'ok'}`. */
  readonly behavior?: import(
    "../src/testing/mock-asana-tasks.js"
  ).UpstreamBehavior;
}

async function makeFixture(opts: MakeFixtureOptions = {}): Promise<{
  readonly state: ReturnType<typeof createMockAsanaApiState>;
  readonly adapter: ReturnType<typeof createAsanaOutputAdapter>;
  readonly store: CredentialStore;
  readonly credentialId: CredentialId;
}> {
  const state = createMockAsanaApiState();
  if (opts.behavior !== undefined) state.behavior = opts.behavior;
  const adapter = createAsanaOutputAdapter({
    makeApi: () => makeMockAsanaApi(state),
  });
  const store = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await seedToken(store);
  return { state, adapter, store, credentialId };
}

// ---------------------------------------------------------------------------
// Shared outputAdapterContract — 8 assertions
// ---------------------------------------------------------------------------

// Unique secret marker present in the seeded credential bytes —
// assertion 9 (no-raw-credentials-in-result) checks the marker
// never appears in JSON.stringify(OutputWriteResult).
const CONTRACT_SECRET_MARKER = "asana_test_pat_contract_secret_marker_xyz";

outputAdapterContract<AsanaTaskPayload>({
  backendName: "output-asana",
  makeAdapter: async () => {
    const state = createMockAsanaApiState();
    const adapter = createAsanaOutputAdapter({
      makeApi: () => makeMockAsanaApi(state),
    });
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await store.write({
      name: "asana-contract-pat",
      schemaRef: "asana-pat/v1",
      plaintext: Buffer.from(CONTRACT_SECRET_MARKER),
    });
    return {
      adapter,
      credentialStore: store,
      credentialId,
      secretMarker: CONTRACT_SECRET_MARKER,
      validPayload: VALID_PAYLOAD,
      // Over-keyed payload — the schema's .strict() rejects
      // the extra `__smuggled` key BEFORE the API call.
      overKeyedPayload: {
        ...VALID_PAYLOAD,
        // @ts-expect-error — this extra key violates the strict schema; the test asserts behavior at runtime
        __smuggled: "agent-injected-field",
      } as AsanaTaskPayload,
      programUpstream: (behavior) => {
        if (behavior.kind === "ok") {
          state.behavior = { kind: "ok" };
        } else if (behavior.kind === "http-error") {
          state.behavior = {
            kind: "http-error",
            status: behavior.status,
            ...(behavior.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: behavior.retryAfterSeconds }
              : {}),
          };
        } else {
          state.behavior = { kind: "transient" };
        }
      },
      inspectCalls: () => state.calls.map((c) => ({ payload: c })),
      cleanup: async () => undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// Adapter-specific tests
// ---------------------------------------------------------------------------

describe("output-asana — payload schema", () => {
  it("requires title, notes, projectGid", () => {
    expect(() =>
      asanaTaskPayloadSchema.parse({ projectGid: "p", notes: "n" }),
    ).toThrow();
    expect(() =>
      asanaTaskPayloadSchema.parse({ title: "t", notes: "n" }),
    ).toThrow();
  });

  it("accepts optional dueOn (YYYY-MM-DD) and assigneeGid", () => {
    expect(
      asanaTaskPayloadSchema.parse({
        ...VALID_PAYLOAD,
        dueOn: "2026-04-30",
        assigneeGid: "u-1",
      }),
    ).toMatchObject({ dueOn: "2026-04-30", assigneeGid: "u-1" });
  });

  it("rejects malformed dueOn", () => {
    expect(() =>
      asanaTaskPayloadSchema.parse({
        ...VALID_PAYLOAD,
        dueOn: "April 30 2026",
      }),
    ).toThrow();
  });

  it("rejects extra keys (.strict — assertion 8)", () => {
    const bad = {
      ...VALID_PAYLOAD,
      __smuggled: "x",
    };
    expect(() => asanaTaskPayloadSchema.parse(bad)).toThrow();
  });

  it("caps notes at 32 KB", () => {
    const tooLong = {
      ...VALID_PAYLOAD,
      notes: "x".repeat(32_769),
    };
    expect(() => asanaTaskPayloadSchema.parse(tooLong)).toThrow();
  });

  // ── PR-W2 (phase-a appendix #13) — html_notes payload path ────────────

  it("accepts htmlNotes alone (no notes)", () => {
    const html = "<body><h2>Heartbeat</h2><p>Body</p></body>";
    const parsed = asanaTaskPayloadSchema.parse({
      title: "t",
      htmlNotes: html,
      projectGid: "p",
    });
    expect(parsed.htmlNotes).toBe(html);
    expect(parsed.notes).toBeUndefined();
  });

  it("rejects payloads carrying BOTH notes and htmlNotes (Asana 400s on both)", () => {
    expect(() =>
      asanaTaskPayloadSchema.parse({
        ...VALID_PAYLOAD,
        htmlNotes: "<body><p>nope</p></body>",
      }),
    ).toThrow();
  });

  it("rejects payloads with neither notes nor htmlNotes (task body required)", () => {
    expect(() =>
      asanaTaskPayloadSchema.parse({
        title: "t",
        projectGid: "p",
      }),
    ).toThrow();
  });

  it("caps htmlNotes at 32 KB", () => {
    expect(() =>
      asanaTaskPayloadSchema.parse({
        title: "t",
        htmlNotes: "x".repeat(32_769),
        projectGid: "p",
      }),
    ).toThrow();
  });
});

describe("output-asana — credential schema", () => {
  it("declares the secret asanaPersonalAccessToken field", () => {
    expect(asanaOutputCredentialSchema.type).toBe("object");
    const field =
      asanaOutputCredentialSchema.properties["asanaPersonalAccessToken"];
    expect(field?.type).toBe("string");
    expect(field?.secret).toBe(true);
  });

  it("requires asanaPersonalAccessToken", () => {
    expect(asanaOutputCredentialSchema.required).toContain(
      "asanaPersonalAccessToken",
    );
  });
});

describe("output-asana — adapter wiring", () => {
  it("slug is 'asana'", async () => {
    const { adapter } = await makeFixture();
    expect(adapter.slug).toBe(ASANA_OUTPUT_ADAPTER_SLUG);
    expect(adapter.slug).toBe("asana");
  });

  it("write() resolves the access token from CredentialStore + passes through to API", async () => {
    const { adapter, store, credentialId, state } = await makeFixture();
    const result = await adapter.write({
      credentialStore: store,
      credentialId,
      payload: VALID_PAYLOAD,
    });
    expect(result.externalId).toMatch(/^asana-task-\d+$/);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.accessToken.toString("utf8")).toBe(
      "asana_test_pat_12345",
    );
    expect(state.calls[0]?.title).toBe(VALID_PAYLOAD.title);
    expect(state.calls[0]?.projectGid).toBe(VALID_PAYLOAD.projectGid);
    expect(state.calls[0]?.notes).toBe(VALID_PAYLOAD.notes);
    expect(state.calls[0]?.htmlNotes).toBeUndefined();
  });

  // ── PR-W2 (phase-a appendix #13) — html_notes round-trip ──────────────

  it("write() forwards htmlNotes-only payloads to the API as htmlNotes (NOT notes)", async () => {
    const { adapter, store, credentialId, state } = await makeFixture();
    const html =
      "<body><h2>opencoo heartbeat</h2><p>One alert today.</p></body>";
    const result = await adapter.write({
      credentialStore: store,
      credentialId,
      payload: {
        title: "Heartbeat",
        htmlNotes: html,
        projectGid: VALID_PAYLOAD.projectGid,
      },
    });
    expect(result.externalId).toMatch(/^asana-task-\d+$/);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.htmlNotes).toBe(html);
    expect(state.calls[0]?.notes).toBeUndefined();
  });

  it("write() rejects payloads that carry BOTH notes and htmlNotes (validation, no API call)", async () => {
    const { adapter, store, credentialId, state } = await makeFixture();
    await expect(
      adapter.write({
        credentialStore: store,
        credentialId,
        payload: {
          title: "t",
          notes: "plain",
          // @ts-expect-error — schema rejects both; runtime asserts the error path.
          htmlNotes: "<body><p>html</p></body>",
          projectGid: VALID_PAYLOAD.projectGid,
        },
      }),
    ).rejects.toThrow();
    // The mock state must show ZERO upstream calls — Zod-rejected
    // payloads do not reach the API. Mirrors assertion 8 of the
    // output-adapter contract.
    expect(state.calls).toHaveLength(0);
  });

  it("classifies HTTP 429 as upstream-quota with retryAfterSeconds", async () => {
    const { adapter, store, credentialId } = await makeFixture({
      behavior: {
        kind: "http-error",
        status: 429,
        retryAfterSeconds: 60,
      },
    });
    try {
      await adapter.write({
        credentialStore: store,
        credentialId,
        payload: VALID_PAYLOAD,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OutputAdapterError);
      const e = err as OutputAdapterError;
      expect(e.errorClass).toBe("upstream-quota");
      expect(e.retryAfterSeconds).toBe(60);
    }
  });

  it("classifies HTTP 503 as transient", async () => {
    const { adapter, store, credentialId } = await makeFixture({
      behavior: { kind: "http-error", status: 503 },
    });
    try {
      await adapter.write({
        credentialStore: store,
        credentialId,
        payload: VALID_PAYLOAD,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as OutputAdapterError).errorClass).toBe("transient");
    }
  });

  it("classifies HTTP 400 as validation (4xx other)", async () => {
    const { adapter, store, credentialId } = await makeFixture({
      behavior: { kind: "http-error", status: 400 },
    });
    try {
      await adapter.write({
        credentialStore: store,
        credentialId,
        payload: VALID_PAYLOAD,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as OutputAdapterError).errorClass).toBe("validation");
    }
  });

  it("classifies a transient (network drop) shape from the SDK as transient", async () => {
    const { adapter, store, credentialId } = await makeFixture({
      behavior: { kind: "transient" },
    });
    try {
      await adapter.write({
        credentialStore: store,
        credentialId,
        payload: VALID_PAYLOAD,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as OutputAdapterError).errorClass).toBe("transient");
    }
  });
});
