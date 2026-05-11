/**
 * Asana `seed()` primitive tests (PR-Z2, phase-a appendix #12 G2).
 *
 * Coverage:
 *   1. Happy path — one `SourceChangedDocument` per task with
 *      the right `sourceRef` + `sourceRevision`.
 *   2. Cursor handoff — returns the `asana-seeded:<ISO>` sentinel
 *      (the scanner uses cursor-non-null as the "is this binding
 *      seeded?" flag, and Asana has no resumable cursor).
 *   3. Multi-project iteration — `monitoredProjectGids` with 2
 *      entries fetches snapshots for both.
 *   4. Fail-open per-project — one project failing doesn't abort
 *      the seed; the surviving project's docs still land.
 *   5. Lazy client (`makeAsanaClient`) injection — invoked exactly
 *      once on first seed and cached.
 *   6. seed undefined when neither client wired — webhook-only
 *      deployments get scan-fallback behavior.
 *   7. AsanaClient seed-path pagination smoke — verify the
 *      `fetchProjectSnapshot` helper handles `next_page.uri` so
 *      seeds over 100-task projects don't truncate.
 */
import { describe, expect, it, vi } from "vitest";

import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { createAsanaSourceAdapter } from "../src/index.js";
import { ASANA_SEED_CURSOR_PREFIX } from "../src/seed.js";
import {
  createAsanaClient,
  type AsanaClient,
  type AsanaTaskRow,
  type ProjectSnapshot,
} from "../src/asana-client.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

async function seedCredential(pat = "1/asana-seed-test-pat"): Promise<{
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

function makeTask(gid: string, name: string, modifiedAt: string): AsanaTaskRow {
  return {
    gid,
    name,
    assignee: null,
    completed: false,
    due_on: null,
    modified_at: modifiedAt,
  };
}

function stubClient(snapshot: ProjectSnapshot | ((gid: string) => ProjectSnapshot)): AsanaClient {
  return {
    fetchProjectSnapshot: vi.fn(async (gid: string) =>
      typeof snapshot === "function" ? snapshot(gid) : snapshot,
    ),
  };
}

// ---------------------------------------------------------------------------
// 1. Happy path — one doc per task
// ---------------------------------------------------------------------------

describe("Asana seed — happy path", () => {
  it("emits one SourceChangedDocument per task in the bound project", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-1";
    const asanaClient = stubClient({
      project_gid: projectGid,
      snapshot: [
        makeTask("task-a", "First", "2026-05-01T00:00:00Z"),
        makeTask("task-b", "Second", "2026-05-01T01:00:00Z"),
        makeTask("task-c", "Third", "2026-05-01T02:00:00Z"),
      ],
      incomplete_count: 3,
      overdue_count: 0,
      fetched_at: "2026-05-10T00:00:00.000Z",
    });

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

    const result = await adapter.seed!({});
    expect(result.documents).toHaveLength(3);
    expect(result.documents.map((d) => d.sourceDocId)).toEqual([
      "task-task-a:seeded",
      "task-task-b:seeded",
      "task-task-c:seeded",
    ]);
    expect(result.documents.map((d) => d.sourceRef)).toEqual([
      "asana:task/task-a",
      "asana:task/task-b",
      "asana:task/task-c",
    ]);
    expect(result.documents[0]?.sourceRevision).toBe("2026-05-01T00:00:00Z");
  });

  it("returns the asana-seeded:<ISO> sentinel cursor (scanner uses it as the seeded-flag)", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-2";
    const asanaClient = stubClient({
      project_gid: projectGid,
      snapshot: [makeTask("task-z", "Z", "2026-05-01T00:00:00Z")],
      incomplete_count: 1,
      overdue_count: 0,
      fetched_at: "2026-05-10T00:00:00.000Z",
    });
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
    const result = await adapter.seed!({});
    expect(result.cursor).toMatch(new RegExp(`^${ASANA_SEED_CURSOR_PREFIX}`));
    // Sentinel is parseable as ISO — operator-readability pin.
    const isoPart = result.cursor!.slice(ASANA_SEED_CURSOR_PREFIX.length);
    expect(Number.isNaN(Date.parse(isoPart))).toBe(false);
  });

  it("contentBytes is the JSON-encoded task row", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-bytes";
    const task = makeTask("task-1", "JSON-me", "2026-05-01T00:00:00Z");
    const asanaClient = stubClient({
      project_gid: projectGid,
      snapshot: [task],
      incomplete_count: 1,
      overdue_count: 0,
      fetched_at: "2026-05-10T00:00:00.000Z",
    });
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
    const result = await adapter.seed!({});
    const decoded = JSON.parse(
      result.documents[0]!.contentBytes.toString("utf8"),
    );
    expect(decoded).toEqual(task);
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-project iteration via monitoredProjectGids
// ---------------------------------------------------------------------------

describe("Asana seed — multi-project iteration", () => {
  it("iterates every gid in monitoredProjectGids", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = stubClient((gid: string) => ({
      project_gid: gid,
      snapshot: [makeTask(`${gid}-task`, "X", "2026-05-01T00:00:00Z")],
      incomplete_count: 1,
      overdue_count: 0,
      fetched_at: "2026-05-10T00:00:00.000Z",
    }));

    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-1",
        monitoredProjectGids: ["proj-1", "proj-2"],
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });
    const result = await adapter.seed!({});
    expect(result.documents).toHaveLength(2);
    expect(asanaClient.fetchProjectSnapshot).toHaveBeenCalledTimes(2);
    expect(asanaClient.fetchProjectSnapshot).toHaveBeenNthCalledWith(1, "proj-1");
    expect(asanaClient.fetchProjectSnapshot).toHaveBeenNthCalledWith(2, "proj-2");
  });

  it("falls back to the primary projectGid when monitoredProjectGids is absent", async () => {
    const { store, credentialId } = await seedCredential();
    const asanaClient = stubClient({
      project_gid: "primary",
      snapshot: [makeTask("only-task", "X", "2026-05-01T00:00:00Z")],
      incomplete_count: 1,
      overdue_count: 0,
      fetched_at: "2026-05-10T00:00:00.000Z",
    });
    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "primary",
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });
    await adapter.seed!({});
    expect(asanaClient.fetchProjectSnapshot).toHaveBeenCalledWith("primary");
  });
});

// ---------------------------------------------------------------------------
// 3. Fail-open per-project
// ---------------------------------------------------------------------------

describe("Asana seed — fail-open per-project", () => {
  it("logs + skips a failing project but emits docs from the surviving project", async () => {
    const { store, credentialId } = await seedCredential();
    let n = 0;
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const asanaClient: AsanaClient = {
      fetchProjectSnapshot: vi.fn(async (gid: string) => {
        n++;
        if (n === 1) throw new Error("asana-client: server error (503)");
        return {
          project_gid: gid,
          snapshot: [makeTask("surv-task", "X", "2026-05-01T00:00:00Z")],
          incomplete_count: 1,
          overdue_count: 0,
          fetched_at: "2026-05-10T00:00:00.000Z",
        };
      }),
    };
    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "boom",
        monitoredProjectGids: ["boom", "ok"],
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient,
    });
    const result = await adapter.seed!({});
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.sourceDocId).toBe("task-surv-task:seeded");
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("seed() snapshot fetch failed"),
      expect.objectContaining({ projectGid: "boom" }),
    );
    consoleWarnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. Lazy makeAsanaClient
// ---------------------------------------------------------------------------

describe("Asana seed — makeAsanaClient lazy injection", () => {
  it("invokes makeAsanaClient exactly once across multiple seed calls", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-lazy";
    const fetchSpy = vi.fn(async (gid: string) => ({
      project_gid: gid,
      snapshot: [makeTask("lazy-task", "X", "2026-05-01T00:00:00Z")],
      incomplete_count: 1,
      overdue_count: 0,
      fetched_at: "2026-05-10T00:00:00.000Z",
    }));
    const make = vi.fn<() => AsanaClient>(() => ({ fetchProjectSnapshot: fetchSpy }));

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

    await adapter.seed!({});
    await adapter.seed!({});
    expect(make).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws when neither asanaClient nor makeAsanaClient is wired", async () => {
    const { store, credentialId } = await seedCredential();
    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "proj-naked",
        snapshotMode: "off",
        webhookSecretCredentialId: credentialId,
      },
    });
    // With snapshotMode='off' there's no asanaClient nor makeAsanaClient —
    // the adapter should omit the seed property entirely.
    expect(adapter.seed).toBeUndefined();
  });

  // PR-Z2 Copilot triage: previously `seedFactoryInvoked` flipped to true
  // BEFORE calling `makeAsanaClient()`. A transient factory failure
  // (network blip during a credential reload) would set the flag, leave the
  // cached client undefined, and lock subsequent seed attempts out of the
  // factory forever. Fix: only mark "invoked" on success — the next tick
  // retries.
  it("retries makeAsanaClient on the next seed call when the factory throws once", async () => {
    const { store, credentialId } = await seedCredential();
    const projectGid = "proj-retry";
    const fetchSpy = vi.fn(async (gid: string) => ({
      project_gid: gid,
      snapshot: [makeTask("retry-task", "X", "2026-05-01T00:00:00Z")],
      incomplete_count: 1,
      overdue_count: 0,
      fetched_at: "2026-05-10T00:00:00.000Z",
    }));
    let call = 0;
    const make = vi.fn<() => AsanaClient>(() => {
      call++;
      if (call === 1) {
        throw new Error("simulated transient factory failure");
      }
      return { fetchProjectSnapshot: fetchSpy };
    });
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

    // First seed() call: factory throws, the adapter fails open and
    // surfaces the no-client error to the caller (scanner's catch path
    // logs + leaves cursor null → re-tries on the next tick).
    await expect(adapter.seed!({})).rejects.toThrow(
      /seed\(\) requires asanaClient or makeAsanaClient injection/,
    );
    expect(make).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "source-asana: seed() makeAsanaClient threw; seed will skip",
      expect.objectContaining({ error: expect.stringContaining("transient") }),
    );

    // Second seed() call: factory succeeds, the seed runs to completion.
    // If the bug regressed (flag flipped before invocation), this call
    // would hit `if (seedFactoryInvoked) return undefined` and throw the
    // same "no client" error — i.e. the binding would be permanently
    // locked out.
    const result = await adapter.seed!({});
    expect(make).toHaveBeenCalledTimes(2);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.sourceDocId).toBe("task-retry-task:seeded");
    consoleWarnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 5. AsanaClient pagination smoke (>100-task projects via next_page.path)
// ---------------------------------------------------------------------------

describe("Asana seed — AsanaClient pagination (next_page.uri)", () => {
  it("walks past the first 100-task page via next_page.uri before completing the snapshot", async () => {
    const { store, credentialId } = await seedCredential();
    let call = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      call++;
      const url = typeof input === "string" ? input : input.toString();
      if (call === 1) {
        return new Response(
          JSON.stringify({
            data: [makeTask("page1-task", "P1", "2026-05-01T00:00:00Z")],
            next_page: { uri: "https://app.asana.com/api/1.0/projects/PROJ/tasks?offset=abc" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second page returns the rest + null next_page so the
      // client's while loop terminates.
      if (call === 2 && url.includes("offset=abc")) {
        return new Response(
          JSON.stringify({
            data: [makeTask("page2-task", "P2", "2026-05-01T01:00:00Z")],
            next_page: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch call ${call} -> ${url}`);
    });
    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      now: () => new Date("2026-05-10T00:00:00Z"),
    });
    const adapter = createAsanaSourceAdapter({
      credentialStore: store,
      credentialId,
      config: {
        projectGid: "PROJ",
        snapshotMode: "on-event",
        webhookSecretCredentialId: credentialId,
      },
      asanaClient: client,
    });
    const result = await adapter.seed!({});
    expect(result.documents.map((d) => d.sourceDocId)).toEqual([
      "task-page1-task:seeded",
      "task-page2-task:seeded",
    ]);
    expect(call).toBe(2);
  });
});
