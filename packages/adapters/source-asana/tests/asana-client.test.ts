/**
 * AsanaClient tests (PR-G).
 *
 * Tests cover:
 *   1. REST GET tasks with correct opt_fields and limit=100.
 *   2. Pagination via next_page.uri.
 *   3. 429 rate-limit retry with Retry-After header.
 *   4. 429 backoff when no Retry-After header (exponential with jitter).
 *   5. 5xx retry (up to 3 attempts) with backoff.
 *   6. 4xx (non-429) immediate failure.
 *   7. PAT never logged on error — THREAT-MODEL §3.6 invariant 11.
 *   8. incomplete_count and overdue_count computation.
 *   9. PAT cached in-process after first fetch.
 *
 * Uses fetchImpl injection for hermetic testing (no network calls).
 */
import { describe, it, expect, vi } from "vitest";

import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { createAsanaClient, DEFAULT_OPT_FIELDS } from "../src/asana-client.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const FAKE_PAT = "1/12345678901234567890";
const PROJECT_GID = "proj-1";

interface AsanaTask {
  gid: string;
  name: string;
  assignee?: { name: string } | null;
  completed: boolean;
  due_on: string | null;
  modified_at: string;
  memberships?: Array<{ section?: { name: string } }>;
}

function makeTask(overrides: Partial<AsanaTask> = {}): AsanaTask {
  return {
    gid: "task-1",
    name: "Test task",
    assignee: { name: "Alice" },
    completed: false,
    due_on: null,
    modified_at: "2026-04-25T12:00:00.000Z",
    memberships: [{ section: { name: "To Do" } }],
    ...overrides,
  };
}

function makeAsanaResponse(
  data: AsanaTask[],
  nextPageUri?: string,
): Response {
  const body = {
    data,
    next_page: nextPageUri ? { uri: nextPageUri, offset: "xxx" } : null,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function makeCredentialStore(pat: string = FAKE_PAT): Promise<{
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

// ---------------------------------------------------------------------------
// 1. Correct opt_fields and limit=100 in request URL
// ---------------------------------------------------------------------------

describe("AsanaClient — opt_fields and limit", () => {
  it("sends GET request with default opt_fields and limit=100", async () => {
    const { store, credentialId } = await makeCredentialStore();
    const capturedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      capturedUrls.push(typeof url === "string" ? url : url.toString());
      return makeAsanaResponse([makeTask()]);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
    });

    await client.fetchProjectSnapshot(PROJECT_GID);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = capturedUrls[0];
    expect(url).toBeDefined();
    expect(url).toContain(`/projects/${PROJECT_GID}/tasks`);
    expect(url).toContain("limit=100");
    // All six default opt_fields present
    for (const field of DEFAULT_OPT_FIELDS) {
      expect(url).toContain(field);
    }
  });

  it("uses custom opt_fields when specified", async () => {
    const { store, credentialId } = await makeCredentialStore();
    const capturedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      capturedUrls.push(typeof url === "string" ? url : url.toString());
      return makeAsanaResponse([makeTask()]);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      optFields: ["name", "completed"],
      fetchImpl,
    });

    await client.fetchProjectSnapshot(PROJECT_GID);

    const url = capturedUrls[0];
    expect(url).toContain("opt_fields=name%2Ccompleted");
  });
});

// ---------------------------------------------------------------------------
// 2. Pagination via next_page.uri
// ---------------------------------------------------------------------------

describe("AsanaClient — pagination", () => {
  it("follows next_page.uri until null, aggregating all tasks", async () => {
    const { store, credentialId } = await makeCredentialStore();
    const task1 = makeTask({ gid: "t1", name: "Task 1" });
    const task2 = makeTask({ gid: "t2", name: "Task 2" });
    const capturedUrls: string[] = [];

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      capturedUrls.push(urlStr);
      if (urlStr.includes("offset=page2")) {
        return makeAsanaResponse([task2]);
      }
      return makeAsanaResponse(
        [task1],
        "https://app.asana.com/api/1.0/projects/proj-1/tasks?offset=page2",
      );
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);

    expect(snapshot.snapshot).toHaveLength(2);
    expect(snapshot.snapshot.map((t) => t.gid)).toEqual(["t1", "t2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Second call uses the full next_page.uri
    expect(capturedUrls[1]).toContain("offset=page2");
  });
});

// ---------------------------------------------------------------------------
// 3. 429 with Retry-After header
// ---------------------------------------------------------------------------

describe("AsanaClient — 429 rate-limit retry", () => {
  it("retries on 429 respecting Retry-After header value", async () => {
    const { store, credentialId } = await makeCredentialStore();
    let callCount = 0;

    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ errors: [{ message: "Rate Limited" }] }), {
          status: 429,
          headers: { "Retry-After": "1", "content-type": "application/json" },
        });
      }
      return makeAsanaResponse([makeTask()]);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      // Short delays for tests
      retryDelayMs: 1,
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);
    expect(snapshot.snapshot).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries up to 5 times on 429 then throws", async () => {
    const { store, credentialId } = await makeCredentialStore();

    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ errors: [{ message: "Rate Limited" }] }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    await expect(client.fetchProjectSnapshot(PROJECT_GID)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  // I2: RFC 7231 §7.1.3 HTTP-date form support
  it("retries on 429 with HTTP-date Retry-After header", async () => {
    const { store, credentialId } = await makeCredentialStore();
    let callCount = 0;

    // Build a date ~1 second in the future so the computed delay is positive.
    const retryAfterDate = new Date(Date.now() + 1000).toUTCString();

    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ errors: [{ message: "Rate Limited" }] }), {
          status: 429,
          headers: { "Retry-After": retryAfterDate, "content-type": "application/json" },
        });
      }
      return makeAsanaResponse([makeTask()]);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);
    expect(snapshot.snapshot).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to exponential backoff for an invalid Retry-After value", async () => {
    const { store, credentialId } = await makeCredentialStore();
    let callCount = 0;

    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ errors: [{ message: "Rate Limited" }] }), {
          status: 429,
          headers: { "Retry-After": "not-a-date", "content-type": "application/json" },
        });
      }
      return makeAsanaResponse([makeTask()]);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);
    expect(snapshot.snapshot).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 4. 5xx retry
// ---------------------------------------------------------------------------

describe("AsanaClient — 5xx retry", () => {
  it("retries up to 3 times on 500 then throws", async () => {
    const { store, credentialId } = await makeCredentialStore();

    const fetchImpl = vi.fn(async () => {
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    await expect(client.fetchProjectSnapshot(PROJECT_GID)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("recovers from 500 on second attempt", async () => {
    const { store, credentialId } = await makeCredentialStore();
    let callCount = 0;

    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Server Error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      }
      return makeAsanaResponse([makeTask()]);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);
    expect(snapshot.snapshot).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 5. 4xx (non-429) immediate failure
// ---------------------------------------------------------------------------

describe("AsanaClient — 4xx immediate failure", () => {
  it("throws immediately on 404 without retrying", async () => {
    const { store, credentialId } = await makeCredentialStore();

    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ errors: [{ message: "Not Found" }] }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    await expect(client.fetchProjectSnapshot(PROJECT_GID)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws immediately on 403 without retrying", async () => {
    const { store, credentialId } = await makeCredentialStore();

    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ errors: [{ message: "Forbidden" }] }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    await expect(client.fetchProjectSnapshot(PROJECT_GID)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. PAT never logged on error — THREAT-MODEL §3.6 invariant 11
// ---------------------------------------------------------------------------

describe("AsanaClient — PAT scrubbing on error", () => {
  it("error message does not contain the PAT when request fails", async () => {
    const fakePat = "1/99887766554433221100";
    const { store, credentialId } = await makeCredentialStore(fakePat);

    const fetchImpl = vi.fn(async () => {
      // Simulate network error that leaks the URL (which could contain the PAT
      // if it were in the URL — we test the error message scrub path)
      throw new Error(`Request to https://app.asana.com failed with token ${fakePat}`);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    let thrownError: Error | undefined;
    try {
      await client.fetchProjectSnapshot(PROJECT_GID);
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err));
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.message).not.toContain(fakePat);
    expect(thrownError?.message).toContain("[REDACTED]");
  });

  it("error message does not contain Bearer token when injected in fetch error", async () => {
    const { store, credentialId } = await makeCredentialStore();

    const fetchImpl = vi.fn(async () => {
      throw new Error(`Request failed: Authorization: Bearer ${FAKE_PAT}`);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      retryDelayMs: 1,
    });

    let thrownError: Error | undefined;
    try {
      await client.fetchProjectSnapshot(PROJECT_GID);
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err));
    }

    expect(thrownError?.message).not.toContain(FAKE_PAT);
    expect(thrownError?.message).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// 7. incomplete_count and overdue_count computation
// ---------------------------------------------------------------------------

describe("AsanaClient — snapshot metrics", () => {
  const TODAY = "2026-05-02"; // test fixture date

  it("computes incomplete_count correctly", async () => {
    const { store, credentialId } = await makeCredentialStore();
    const tasks = [
      makeTask({ gid: "t1", completed: false }),
      makeTask({ gid: "t2", completed: true }),
      makeTask({ gid: "t3", completed: false }),
    ];

    const fetchImpl = vi.fn(async () => makeAsanaResponse(tasks));

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      now: () => new Date(`${TODAY}T12:00:00Z`),
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);
    expect(snapshot.incomplete_count).toBe(2);
  });

  it("computes overdue_count: incomplete tasks with due_on < today", async () => {
    const { store, credentialId } = await makeCredentialStore();
    const tasks = [
      makeTask({ gid: "t1", completed: false, due_on: "2026-04-30" }), // overdue
      makeTask({ gid: "t2", completed: false, due_on: "2026-05-10" }), // future
      makeTask({ gid: "t3", completed: false, due_on: null }),         // no due date
      makeTask({ gid: "t4", completed: true, due_on: "2026-04-29" }),  // completed, skip
      makeTask({ gid: "t5", completed: false, due_on: "2026-05-02" }), // today, not overdue
    ];

    const fetchImpl = vi.fn(async () => makeAsanaResponse(tasks));

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      now: () => new Date(`${TODAY}T12:00:00Z`),
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);
    expect(snapshot.overdue_count).toBe(1); // only t1
    expect(snapshot.incomplete_count).toBe(4); // t1, t2, t3, t5
  });

  it("snapshot includes project_gid and fetched_at ISO string", async () => {
    const { store, credentialId } = await makeCredentialStore();
    const fixedNow = new Date("2026-05-02T10:00:00.000Z");

    const fetchImpl = vi.fn(async () => makeAsanaResponse([makeTask()]));

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      now: () => fixedNow,
    });

    const snapshot = await client.fetchProjectSnapshot(PROJECT_GID);
    expect(snapshot.project_gid).toBe(PROJECT_GID);
    expect(snapshot.fetched_at).toBe(fixedNow.toISOString());
  });
});

// ---------------------------------------------------------------------------
// 8. PAT credential caching
// ---------------------------------------------------------------------------

describe("AsanaClient — credential caching", () => {
  it("resolves the PAT credential once, not on every page fetch", async () => {
    const { store, credentialId } = await makeCredentialStore();
    const readSpy = vi.spyOn(store, "read");

    // Two pages
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      call++;
      if (call === 1 && !urlStr.includes("page2")) {
        return makeAsanaResponse(
          [makeTask({ gid: "t1" })],
          "https://app.asana.com/api/1.0/projects/proj-1/tasks?offset=page2",
        );
      }
      return makeAsanaResponse([makeTask({ gid: "t2" })]);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
    });

    await client.fetchProjectSnapshot(PROJECT_GID);
    // Should have read credentials only once regardless of pagination
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 9. DEFAULT_OPT_FIELDS contains the PoC's six fields
// ---------------------------------------------------------------------------

describe("AsanaClient — DEFAULT_OPT_FIELDS", () => {
  it("contains the six fields from the PoC reference", () => {
    expect(DEFAULT_OPT_FIELDS).toContain("name");
    expect(DEFAULT_OPT_FIELDS).toContain("assignee.name");
    expect(DEFAULT_OPT_FIELDS).toContain("completed");
    expect(DEFAULT_OPT_FIELDS).toContain("due_on");
    expect(DEFAULT_OPT_FIELDS).toContain("modified_at");
    expect(DEFAULT_OPT_FIELDS).toContain("memberships.section.name");
    expect(DEFAULT_OPT_FIELDS).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// 10. patFromRecord — JSON-blob credential extraction (PR-Q8)
// ---------------------------------------------------------------------------

describe("AsanaClient — patFromRecord (PR-Q8)", () => {
  it("uses patFromRecord to extract the PAT from a JSON-blob plaintext (production composition shape)", async () => {
    const realPat = "1/abcdef-real-pat";
    const credentialBlob = JSON.stringify({
      personal_access_token: realPat,
      workspace_gid: "ws-123",
    });
    const store = new InMemoryCredentialStore({ logger: silentLogger() });
    const credentialId = await store.write({
      name: "asana-prod",
      schemaRef: "asana:auth",
      plaintext: Buffer.from(credentialBlob, "utf8"),
    });

    const capturedHeaders: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers !== undefined) capturedHeaders.push({ ...headers });
      return makeAsanaResponse([]);
    });

    const client = createAsanaClient({
      credentialStore: store,
      credentialId,
      fetchImpl,
      patFromRecord: (plaintext: Buffer): string => {
        const parsed = JSON.parse(plaintext.toString("utf8")) as {
          personal_access_token?: unknown;
        };
        if (typeof parsed.personal_access_token !== "string") {
          throw new Error("asana credential missing personal_access_token");
        }
        return parsed.personal_access_token;
      },
    });

    await client.fetchProjectSnapshot(PROJECT_GID);
    // Header carries the EXTRACTED PAT, not the JSON blob.
    expect(capturedHeaders[0]?.["Authorization"]).toBe(`Bearer ${realPat}`);
  });
});
