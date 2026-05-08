/**
 * Binding-config schema tests for PR-G additions:
 *   - snapshotMode: 'on-event' | 'periodic' | 'off', default 'on-event'
 *   - optFields: string[], default to six PoC fields
 *
 * Also covers factory-time guards added in Copilot triage (PR #46):
 *   - Fix #1: snapshotMode='on-event' requires asanaClient injection
 *   - Fix #2: binding-level optFields reaches AsanaClient fetch URL
 */
import { describe, it, expect, vi } from "vitest";

import type { SourceWebhookEvent } from "@opencoo/shared/source-adapter";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { asanaBindingConfigSchema, createAsanaSourceAdapter } from "../src/index.js";
import {
  DEFAULT_OPT_FIELDS,
  createAsanaClient,
  type AsanaClient,
} from "../src/asana-client.js";

describe("asanaBindingConfigSchema — snapshotMode", () => {
  it("defaults snapshotMode to 'on-event'", () => {
    const parsed = asanaBindingConfigSchema.parse({ projectGid: "p" });
    expect(parsed.snapshotMode).toBe("on-event");
  });

  it("accepts snapshotMode='on-event'", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p", snapshotMode: "on-event" }),
    ).not.toThrow();
  });

  it("accepts snapshotMode='periodic'", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p", snapshotMode: "periodic" }),
    ).not.toThrow();
  });

  it("accepts snapshotMode='off'", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p", snapshotMode: "off" }),
    ).not.toThrow();
  });

  it("rejects unknown snapshotMode values", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p", snapshotMode: "always" }),
    ).toThrow();
  });
});

describe("asanaBindingConfigSchema — optFields", () => {
  it("defaults optFields to the six PoC fields", () => {
    const parsed = asanaBindingConfigSchema.parse({ projectGid: "p" });
    expect(parsed.optFields).toEqual([...DEFAULT_OPT_FIELDS]);
  });

  it("accepts custom optFields", () => {
    const custom = ["name", "completed"];
    const parsed = asanaBindingConfigSchema.parse({
      projectGid: "p",
      optFields: custom,
    });
    expect(parsed.optFields).toEqual(custom);
  });

  it("rejects non-string elements in optFields", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({
        projectGid: "p",
        optFields: [42, "name"],
      }),
    ).toThrow();
  });
});

describe("asanaBindingConfigSchema — combined PR-G fields", () => {
  it("parses a full valid config with all PR-G fields", () => {
    const parsed = asanaBindingConfigSchema.parse({
      projectGid: "project-123",
      snapshotMode: "periodic",
      optFields: ["name", "completed", "due_on"],
      monitoredProjectGids: ["proj-a", "proj-b"],
      lightSummaryEnabled: true,
      reviewMode: "auto",
    });

    expect(parsed.snapshotMode).toBe("periodic");
    expect(parsed.optFields).toEqual(["name", "completed", "due_on"]);
    expect(parsed.monitoredProjectGids).toEqual(["proj-a", "proj-b"]);
    expect(parsed.lightSummaryEnabled).toBe(true);
  });

  it("still rejects unknown fields (.strict remains)", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({
        projectGid: "p",
        snapshotMode: "on-event",
        unknownKey: "should-fail",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix #1 (Copilot triage) — factory guard: on-event requires asanaClient
// ---------------------------------------------------------------------------

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedCredential(): Promise<{
  store: InstanceType<typeof InMemoryCredentialStore>;
  credentialId: CredentialId;
}> {
  const store = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await store.write({
    name: "asana-pat",
    schemaRef: "asanaApi/v1",
    plaintext: Buffer.from("1/test-pat"),
  });
  return { store, credentialId };
}

describe("createAsanaSourceAdapter — factory guard: on-event requires asanaClient", () => {
  it("throws at factory time when snapshotMode='on-event' and asanaClient is not provided", async () => {
    const { store, credentialId } = await seedCredential();
    expect(() =>
      createAsanaSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {
          projectGid: "proj-1",
          snapshotMode: "on-event",
          webhookSecretCredentialId: credentialId,
        },
        // asanaClient intentionally omitted
      }),
    ).toThrow(
      "source-asana: snapshotMode='on-event' requires asanaClient or makeAsanaClient injection",
    );
  });

  it("does NOT throw for snapshotMode='off' without asanaClient", async () => {
    const { store, credentialId } = await seedCredential();
    expect(() =>
      createAsanaSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {
          projectGid: "proj-1",
          snapshotMode: "off",
          webhookSecretCredentialId: credentialId,
        },
      }),
    ).not.toThrow();
  });

  it("does NOT throw for snapshotMode='on-event' when asanaClient is provided", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient: AsanaClient = {
      fetchProjectSnapshot: vi.fn(async (gid: string) => ({
        project_gid: gid,
        snapshot: [],
        incomplete_count: 0,
        overdue_count: 0,
        fetched_at: new Date().toISOString(),
      })),
    };
    expect(() =>
      createAsanaSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {
          projectGid: "proj-1",
          snapshotMode: "on-event",
          webhookSecretCredentialId: credentialId,
        },
        asanaClient,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix #2 (Copilot triage) — binding optFields reaches AsanaClient fetch URL
//
// The factory accepts a pre-built AsanaClient via args.asanaClient. When an
// injected client is provided, the client owns its optFields configuration
// (set at createAsanaClient() time). This test verifies the end-to-end
// path: a client created with custom optFields sends those fields in the
// fetch URL during an enrichEvents snapshot fetch triggered by the adapter.
// ---------------------------------------------------------------------------

describe("Fix #2 — binding optFields reaches AsanaClient fetch URL via injected client", () => {
  it("AsanaClient built with custom optFields sends those fields in the Asana API URL", async () => {
    const store2 = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId2 = await store2.write({
      name: "asana-pat",
      schemaRef: "asanaApi/v1",
      plaintext: Buffer.from("1/test-pat-opts"),
    });

    const capturedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      capturedUrls.push(typeof url === "string" ? url : url.toString());
      return new Response(
        JSON.stringify({ data: [], next_page: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const customOptFields = ["name", "completed", "custom_field.gid"];

    // Build the client with custom optFields — this is how an operator would
    // wire binding-level optFields through createAsanaClient.
    const asanaClient = createAsanaClient({
      credentialStore: store2,
      credentialId: credentialId2,
      optFields: customOptFields,
      fetchImpl,
      retryDelayMs: 1,
    });

    const adapter = createAsanaSourceAdapter({
      credentialStore: store2,
      credentialId: credentialId2,
      config: {
        projectGid: "proj-optfields",
        snapshotMode: "on-event",
        optFields: customOptFields,
        webhookSecretCredentialId: credentialId2,
      },
      asanaClient,
    });

    // Trigger enrichEvents to exercise the snapshot fetch code path.
    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-opts",
      eventType: "created",
      doc: {
        sourceDocId: "t1:added",
        sourceRevision: "evt-opts",
        sourceRef: "asana:task/t1",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
        metadata: { projectGid: "proj-optfields" },
      },
    };

    await adapter.webhook!.enrichEvents!([baseEvent]);

    // The fetch URL must contain each custom opt_field.
    expect(capturedUrls.length).toBeGreaterThan(0);
    const url = capturedUrls[0]!;
    for (const field of customOptFields) {
      expect(url).toContain(field);
    }
    // Default fields are NOT present (custom optFields replaced them).
    expect(url).not.toContain("assignee.name");
  });
});
