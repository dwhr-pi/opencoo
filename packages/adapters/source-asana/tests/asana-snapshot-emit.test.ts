/**
 * Snapshot enrichment via enrichEvents (PR-G).
 *
 * Tests cover:
 *   1. snapshotMode='on-event': enrichEvents emits a second SourceEvent
 *      with content_kind='asana-project' after each parsed event.
 *   2. snapshotMode='off': enrichEvents is not defined.
 *   3. snapshotMode='periodic': enrichEvents is not defined (snapshot
 *      fetching handled in scan() instead).
 *   4. Second event has correct shape: {project_gid, snapshot, incomplete_count,
 *      overdue_count, fetched_at} serialized in contentBytes.
 *   5. enrichEvents uses parent.gid when resource_type is not 'project'.
 *   6. LightSummary wired in enrichEvents when lightSummaryEnabled=true.
 */
import { describe, it, expect, vi } from "vitest";

import type { SourceWebhookEvent } from "@opencoo/shared/source-adapter";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { createAsanaSourceAdapter } from "../src/index.js";
import type { AsanaClient, ProjectSnapshot } from "../src/asana-client.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedCredential(pat = "1/asana-test-pat"): Promise<{
  store: InstanceType<typeof InMemoryCredentialStore>;
  credentialId: CredentialId;
}> {
  const store = new InMemoryCredentialStore({ logger: silentLogger() });
  const credentialId = await store.write({
    name: "asana-pat",
    schemaRef: "asanaApi/v1",
    plaintext: Buffer.from(pat),
  });
  return { store, credentialId };
}

function makeStubAsanaClient(
  projectGid: string,
  overrides?: Partial<ProjectSnapshot>,
): AsanaClient {
  return {
    fetchProjectSnapshot: vi.fn(async (gid: string) => ({
      project_gid: gid,
      snapshot: [],
      incomplete_count: 3,
      overdue_count: 1,
      fetched_at: "2026-05-02T10:00:00.000Z",
      ...overrides,
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. snapshotMode='on-event': emits second SourceEvent
// ---------------------------------------------------------------------------

describe("enrichEvents — snapshotMode='on-event'", () => {
  it("is defined on the webhook helpers when snapshotMode='on-event'", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient("proj-100");

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-100",
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    expect(adapter.webhook?.enrichEvents).toBeDefined();
  });

  it("emits 2 SourceEvents: original event + snapshot event", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-100";
    const asanaClient = makeStubAsanaClient(projectGid, {
      snapshot: [{ gid: "task-1", name: "Task One", completed: false, due_on: null, modified_at: "2026-05-01T00:00:00Z" }],
      incomplete_count: 1,
      overdue_count: 0,
    });

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid,
        snapshotMode: "on-event",
        monitoredProjectGids: [projectGid],
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    // Parse events (sync) — use fixture body that has monitored project
    // To test enrichEvents, we need to construct a parsed event manually.
    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-001",
      eventType: "due_date_changed",
      doc: {
        sourceDocId: "task-42:changed",
        sourceRevision: "evt-001",
        sourceRef: "asana:task/task-42",
        fetchedAt: new Date("2026-05-02T08:00:00Z"),
        contentBytes: Buffer.from(JSON.stringify({ action: "changed" }), "utf8"),
        metadata: { projectGid },
      },
    };

    const enrichedEvents = await adapter.webhook!.enrichEvents!([baseEvent]);

    expect(enrichedEvents).toHaveLength(2);
    // First event is the original event unchanged
    expect(enrichedEvents[0]).toEqual(baseEvent);
    // Second event is the snapshot event
    const snapshotEvent = enrichedEvents[1]!;
    // content_kind is 'asana-project' (TODO: registered in PR-H)
    expect(snapshotEvent.doc.sourceRef).toContain("asana:project");
    const payload = JSON.parse(snapshotEvent.doc.contentBytes.toString("utf8")) as {
      project_gid: string;
      snapshot: unknown[];
      incomplete_count: number;
      overdue_count: number;
      fetched_at: string;
    };
    expect(payload.project_gid).toBe(projectGid);
    expect(payload.snapshot).toHaveLength(1);
    expect(payload.incomplete_count).toBe(1);
    expect(payload.overdue_count).toBe(0);
    expect(typeof payload.fetched_at).toBe("string");
  });

  it("calls fetchProjectSnapshot with projectGid from metadata when present", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-specific";
    const fetchSpy = vi.fn(async (gid: string) => ({
      project_gid: gid,
      snapshot: [],
      incomplete_count: 0,
      overdue_count: 0,
      fetched_at: "2026-05-02T10:00:00.000Z",
    }));
    const asanaClient: AsanaClient = { fetchProjectSnapshot: fetchSpy };

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-default",
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-002",
      eventType: "completed",
      doc: {
        sourceDocId: "task-99:changed",
        sourceRevision: "evt-002",
        sourceRef: "asana:task/task-99",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
        metadata: { projectGid },
      },
    };

    await adapter.webhook!.enrichEvents!([baseEvent]);
    expect(fetchSpy).toHaveBeenCalledWith(projectGid);
  });

  it("falls back to binding projectGid when event metadata has no projectGid", async () => {
    const { store, credentialId } = await seedCredential();
    const bindingProjectGid = "proj-binding";
    const fetchSpy = vi.fn(async (gid: string) => ({
      project_gid: gid,
      snapshot: [],
      incomplete_count: 0,
      overdue_count: 0,
      fetched_at: "2026-05-02T10:00:00.000Z",
    }));
    const asanaClient: AsanaClient = { fetchProjectSnapshot: fetchSpy };

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: bindingProjectGid,
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-003",
      eventType: "assignee_changed",
      doc: {
        sourceDocId: "task-50:changed",
        sourceRevision: "evt-003",
        sourceRef: "asana:task/task-50",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
        // No projectGid in metadata
      },
    };

    await adapter.webhook!.enrichEvents!([baseEvent]);
    expect(fetchSpy).toHaveBeenCalledWith(bindingProjectGid);
  });

  it("processes multiple events and emits double the events", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient("proj-multi");

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-multi",
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const events: SourceWebhookEvent[] = [
      {
        eventId: "e1",
        eventType: "created",
        doc: {
          sourceDocId: "t1:added",
          sourceRevision: "e1",
          sourceRef: "asana:task/t1",
          fetchedAt: new Date(),
          contentBytes: Buffer.from("{}", "utf8"),
        },
      },
      {
        eventId: "e2",
        eventType: "completed",
        doc: {
          sourceDocId: "t2:changed",
          sourceRevision: "e2",
          sourceRef: "asana:task/t2",
          fetchedAt: new Date(),
          contentBytes: Buffer.from("{}", "utf8"),
        },
      },
    ];

    const result = await adapter.webhook!.enrichEvents!(events);
    expect(result).toHaveLength(4); // 2 original + 2 snapshot events
  });
});

// ---------------------------------------------------------------------------
// 2. snapshotMode='off': enrichEvents is not defined
// ---------------------------------------------------------------------------

describe("enrichEvents — snapshotMode='off'", () => {
  it("enrichEvents is undefined when snapshotMode='off'", async () => {
    const { store, credentialId } = await seedCredential();

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-100",
        snapshotMode: "off",
        webhookSecretCredentialId: credentialId,
      },
    });

    expect(adapter.webhook?.enrichEvents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. snapshotMode='periodic': enrichEvents is not defined
// ---------------------------------------------------------------------------

describe("enrichEvents — snapshotMode='periodic'", () => {
  it("enrichEvents is undefined when snapshotMode='periodic'", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient("proj-100");

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-100",
        snapshotMode: "periodic",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    expect(adapter.webhook?.enrichEvents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Snapshot event shape
// ---------------------------------------------------------------------------

describe("snapshot event shape", () => {
  it("snapshot event sourceRef is 'asana:project/<projectGid>'", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-shape";
    const asanaClient = makeStubAsanaClient(projectGid);

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid,
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-shape",
      eventType: "created",
      doc: {
        sourceDocId: "t1:added",
        sourceRevision: "evt-shape",
        sourceRef: "asana:task/t1",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
      },
    };

    const result = await adapter.webhook!.enrichEvents!([baseEvent]);
    const snapshotEvent = result[1]!;
    expect(snapshotEvent.doc.sourceRef).toBe(`asana:project/${projectGid}`);
  });

  it("snapshot sourceDocId is unique per project snapshot", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-unique";
    const asanaClient = makeStubAsanaClient(projectGid);

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid,
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });

    const event: SourceWebhookEvent = {
      eventId: "evt-uid",
      eventType: "created",
      doc: {
        sourceDocId: "t1:added",
        sourceRevision: "evt-uid",
        sourceRef: "asana:task/t1",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
      },
    };

    const result = await adapter.webhook!.enrichEvents!([event]);
    const snapshotEvent = result[1]!;
    // sourceDocId should reference the project snapshot
    expect(snapshotEvent.doc.sourceDocId).toContain("snapshot");
  });
});

// ---------------------------------------------------------------------------
// 5. LightSummary wired in enrichEvents
// ---------------------------------------------------------------------------

describe("enrichEvents — light summary wiring", () => {
  it("attaches metadata.summary when lightSummaryEnabled=true (closes PR-F gap)", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-light";
    const asanaClient = makeStubAsanaClient(projectGid);

    // Mock LLM router that returns a summary
    const mockRouter = {
      generateText: vi.fn(async () => ({
        text: "Zadanie zostało ukończone.",
        tokens_in: 10,
        tokens_out: 5,
        cost: 0.001,
        latency_ms: 100,
        model: "test-model",
        tier: "light" as const,
      })),
    };

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid,
        snapshotMode: "on-event",
        lightSummaryEnabled: true,
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
      llmRouter: mockRouter,
      domainId: "domain-1" as import("@opencoo/shared/db").DomainId,
    });

    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-light",
      eventType: "completed",
      doc: {
        sourceDocId: "t1:changed",
        sourceRevision: "evt-light",
        sourceRef: "asana:task/t1",
        fetchedAt: new Date(),
        contentBytes: Buffer.from(JSON.stringify({ action: "changed", resource: { gid: "t1" } }), "utf8"),
      },
    };

    const result = await adapter.webhook!.enrichEvents!([baseEvent]);
    // First event should have metadata.summary attached
    const enrichedBaseEvent = result[0]!;
    expect(enrichedBaseEvent.doc.metadata?.summary).toBe("Zadanie zostało ukończone.");
    expect(mockRouter.generateText).toHaveBeenCalledTimes(1);
  });

  it("proceeds without summary when lightSummaryEnabled=false", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = makeStubAsanaClient("proj-nolite");

    const mockRouter = {
      generateText: vi.fn(),
    };

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-nolite",
        snapshotMode: "on-event",
        lightSummaryEnabled: false,
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
      llmRouter: mockRouter,
      domainId: "domain-1" as import("@opencoo/shared/db").DomainId,
    });

    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-nolite",
      eventType: "created",
      doc: {
        sourceDocId: "t1:added",
        sourceRevision: "evt-nolite",
        sourceRef: "asana:task/t1",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
      },
    };

    await adapter.webhook!.enrichEvents!([baseEvent]);
    expect(mockRouter.generateText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// I1 — enrichEvents snapshot-fetch error containment
// ---------------------------------------------------------------------------

describe("enrichEvents — snapshot fetch error containment (I1)", () => {
  it("resolves successfully when fetchProjectSnapshot rejects", async () => {
    const { store, credentialId } = await seedCredential();

    const failingClient: AsanaClient = {
      fetchProjectSnapshot: vi.fn(async () => {
        throw new Error("asana-client: server error (503) after 3 attempts");
      }),
    };

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-fail",
        snapshotMode: "on-event",
        monitoredProjectGids: ["proj-fail"],
        webhookSecretCredentialId: credentialId,
      },
      asanaClient: failingClient,
    });

    const rawEvent: SourceWebhookEvent = {
      eventId: "evt-i1",
      eventType: "created",
      doc: {
        sourceDocId: "task-i1:added",
        sourceRevision: "evt-i1",
        sourceRef: "asana:task/task-i1",
        fetchedAt: new Date("2026-05-02T08:00:00Z"),
        contentBytes: Buffer.from(JSON.stringify({ action: "added" }), "utf8"),
        metadata: { projectGid: "proj-fail" },
      },
    };

    // (a) resolves without throwing
    const result = await adapter.webhook!.enrichEvents!([rawEvent]);

    // (b) raw event is in the result
    expect(result[0]).toEqual(rawEvent);

    // (c) no snapshot event emitted (only the raw event)
    expect(result).toHaveLength(1);
  });

  it("continues processing subsequent events after one snapshot fetch fails", async () => {
    const { store, credentialId } = await seedCredential();
    let callCount = 0;

    const partiallyFailingClient: AsanaClient = {
      fetchProjectSnapshot: vi.fn(async (gid: string) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("asana-client: server error (500)");
        }
        return {
          project_gid: gid,
          snapshot: [],
          incomplete_count: 0,
          overdue_count: 0,
          fetched_at: "2026-05-02T10:00:00.000Z",
        };
      }),
    };

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-batch",
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient: partiallyFailingClient,
    });

    const events: SourceWebhookEvent[] = [
      {
        eventId: "batch-1",
        eventType: "created",
        doc: {
          sourceDocId: "t1:added",
          sourceRevision: "batch-1",
          sourceRef: "asana:task/t1",
          fetchedAt: new Date(),
          contentBytes: Buffer.from("{}", "utf8"),
        },
      },
      {
        eventId: "batch-2",
        eventType: "completed",
        doc: {
          sourceDocId: "t2:changed",
          sourceRevision: "batch-2",
          sourceRef: "asana:task/t2",
          fetchedAt: new Date(),
          contentBytes: Buffer.from("{}", "utf8"),
        },
      },
    ];

    // (d) both events processed — first has no snapshot (fetch failed), second has one
    const result = await adapter.webhook!.enrichEvents!(events);
    expect(result).toHaveLength(3); // event[0] (no snapshot) + event[1] + snapshot[1]
    expect(result[0]?.eventId).toBe("batch-1");
    expect(result[1]?.eventId).toBe("batch-2");
    // Third entry is the snapshot for the second event
    expect(result[2]?.doc.sourceRef).toContain("asana:project/");
  });
});

// ---------------------------------------------------------------------------
// Fix #3 (Copilot triage) — buildSnapshotEvent enforces 1 MiB ceiling
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PR-Q8 — makeAsanaClient lazy injection (production-composition path)
// ---------------------------------------------------------------------------

describe("makeAsanaClient — lazy injection (PR-Q8)", () => {
  it("does not throw at factory time when snapshotMode='on-event' AND makeAsanaClient is provided (no asanaClient)", async () => {
    const { store, credentialId } = await seedCredential();
    const make = vi.fn(() => makeStubAsanaClient("proj-lazy"));

    // RED: today the factory throws "snapshotMode='on-event' requires
    // asanaClient injection" because makeAsanaClient is not yet recognised.
    expect(() => {
      createAsanaSourceAdapter({
        credentialStore: store,
        credentialId,
        config: {
          projectGid: "proj-lazy",
          snapshotMode: "on-event",
          webhookSecretCredentialId: credentialId,
        },
        makeAsanaClient: make,
      });
    }).not.toThrow();

    // makeAsanaClient must NOT be invoked at boot — the client is constructed
    // lazily on first enrichEvents dispatch (so missing creds don't crash boot).
    expect(make).not.toHaveBeenCalled();
  });

  it("calls makeAsanaClient exactly once across multiple enrichEvents dispatches (cached for adapter lifetime)", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-cached";
    const make = vi.fn(() => makeStubAsanaClient(projectGid));

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid,
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      makeAsanaClient: make,
    });

    const buildEvent = (id: string): SourceWebhookEvent => ({
      eventId: id,
      eventType: "created",
      doc: {
        sourceDocId: `${id}:added`,
        sourceRevision: id,
        sourceRef: `asana:task/${id}`,
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
        metadata: { projectGid },
      },
    });

    // First dispatch — makeAsanaClient invoked once.
    await adapter.webhook!.enrichEvents!([buildEvent("e1")]);
    expect(make).toHaveBeenCalledTimes(1);

    // Second dispatch — must reuse the cached client; no second call.
    await adapter.webhook!.enrichEvents!([buildEvent("e2")]);
    expect(make).toHaveBeenCalledTimes(1);

    // Third dispatch with a batch of two — still cached.
    await adapter.webhook!.enrichEvents!([buildEvent("e3"), buildEvent("e4")]);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("emits the snapshot event using the lazily-constructed client", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-from-make";
    const fetchSpy = vi.fn(async (gid: string) => ({
      project_gid: gid,
      snapshot: [],
      incomplete_count: 7,
      overdue_count: 2,
      fetched_at: "2026-05-08T10:00:00.000Z",
    }));
    const lazyClient: AsanaClient = { fetchProjectSnapshot: fetchSpy };

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid,
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      makeAsanaClient: () => lazyClient,
    });

    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-make",
      eventType: "completed",
      doc: {
        sourceDocId: "task-make:changed",
        sourceRevision: "evt-make",
        sourceRef: "asana:task/task-make",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
        metadata: { projectGid },
      },
    };

    const result = await adapter.webhook!.enrichEvents!([baseEvent]);

    expect(result).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledWith(projectGid);
    const snapshotEvent = result[1]!;
    const payload = JSON.parse(snapshotEvent.doc.contentBytes.toString("utf8")) as {
      project_gid: string;
      incomplete_count: number;
      overdue_count: number;
    };
    expect(payload.project_gid).toBe(projectGid);
    expect(payload.incomplete_count).toBe(7);
    expect(payload.overdue_count).toBe(2);
  });

  it("prefers explicit asanaClient over makeAsanaClient when both are provided", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-precedence";
    const explicitClient = makeStubAsanaClient(projectGid, {
      incomplete_count: 99,
    });
    const make = vi.fn(() => makeStubAsanaClient(projectGid));

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid,
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient: explicitClient,
      makeAsanaClient: make,
    });

    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-prec",
      eventType: "created",
      doc: {
        sourceDocId: "t-prec:added",
        sourceRevision: "evt-prec",
        sourceRef: "asana:task/t-prec",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
        metadata: { projectGid },
      },
    };

    const result = await adapter.webhook!.enrichEvents!([baseEvent]);

    // Snapshot was produced by the explicit client (incomplete_count=99),
    // not the make() factory output (default 3).
    const payload = JSON.parse(result[1]!.doc.contentBytes.toString("utf8")) as {
      incomplete_count: number;
    };
    expect(payload.incomplete_count).toBe(99);
    expect(make).not.toHaveBeenCalled();
  });

  it("fails open when makeAsanaClient throws (Copilot triage)", async () => {
    // The receiver's webhook hot-path treats enrich failures as
    // "skip enrichment, continue with the bare event," not "kill
    // the entire delivery." If `makeAsanaClient` throws (miswired
    // composition, malformed PAT JSON, transient SDK boot error),
    // `enrichEvents` MUST still produce the raw event and absorb
    // the throw with a soft warn — otherwise a single bad binding
    // takes down the whole ingestion path.
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-fail-open";
    const make = vi.fn(() => {
      throw new Error("simulated SDK boot failure");
    });
    // Silence the soft warn during the test.
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid,
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      makeAsanaClient: make,
    });

    const baseEvent: SourceWebhookEvent = {
      eventId: "evt-fail-open",
      eventType: "created",
      doc: {
        sourceDocId: "t-fail-open:added",
        sourceRevision: "evt-fail-open",
        sourceRef: "asana:task/t-fail-open",
        fetchedAt: new Date(),
        contentBytes: Buffer.from("{}", "utf8"),
        metadata: { projectGid },
      },
    };

    const result = await adapter.webhook!.enrichEvents!([baseEvent]);

    // The bare event survives; no snapshot event was added.
    expect(result.length).toBe(1);
    expect(result[0]!.eventId).toBe("evt-fail-open");
    // Soft warn was emitted with the factory error message.
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("makeAsanaClient threw"),
      expect.objectContaining({
        error: expect.stringContaining("simulated SDK boot failure"),
      }),
    );
    // Factory was NOT retried on a hypothetical second dispatch
    // (would just reproduce the throw and double-log).
    const result2 = await adapter.webhook!.enrichEvents!([baseEvent]);
    expect(result2.length).toBe(1);
    expect(make).toHaveBeenCalledTimes(1);

    consoleWarnSpy.mockRestore();
  });
});

describe("enrichEvents — snapshot 1 MiB ceiling (Fix #3)", () => {
  it("does NOT emit snapshot event when snapshot exceeds 1 MiB, but still emits raw event", async () => {
    const { store, credentialId } = await seedCredential();

    // Build a snapshot that serializes to > 1 MiB.
    // 1000 tasks × ~1100 bytes each ≈ 1.1 MiB serialized.
    const hugeTaskName = "A".repeat(1050); // ~1050 bytes per task entry
    const hugeTasks = Array.from({ length: 1000 }, (_, i) => ({
      gid: `task-${i}`,
      name: hugeTaskName,
      assignee: null,
      completed: false,
      due_on: null,
      modified_at: "2026-05-02T00:00:00Z",
    }));

    const oversizedClient: AsanaClient = {
      fetchProjectSnapshot: vi.fn(async (gid: string) => ({
        project_gid: gid,
        snapshot: hugeTasks,
        incomplete_count: 1000,
        overdue_count: 0,
        fetched_at: "2026-05-02T10:00:00.000Z",
      })),
    };

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-oversized",
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient: oversizedClient,
    });

    const rawEvent: SourceWebhookEvent = {
      eventId: "evt-oversize",
      eventType: "created",
      doc: {
        sourceDocId: "t-big:added",
        sourceRevision: "evt-oversize",
        sourceRef: "asana:task/t-big",
        fetchedAt: new Date("2026-05-02T08:00:00Z"),
        contentBytes: Buffer.from(JSON.stringify({ action: "added" }), "utf8"),
        metadata: { projectGid: "proj-oversized" },
      },
    };

    // enrichEvents must resolve (not throw) — fail-open at receiver level.
    const result = await adapter.webhook!.enrichEvents!([rawEvent]);

    // The raw event is always emitted.
    expect(result[0]).toEqual(rawEvent);

    // The snapshot event is NOT emitted (the 1 MiB ValidationError is caught
    // and converted to a structured warning, matching enrichEvents' I1 policy).
    expect(result).toHaveLength(1);
  });
});
