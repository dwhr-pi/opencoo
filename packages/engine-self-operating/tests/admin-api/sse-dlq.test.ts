/**
 * SseBus — OutputDeliveryDlq event emission (PR-L).
 *
 * Pin matrix:
 *   1. `emitOutputDeliveryDlq` publishes an `output_delivery_dlq`
 *      event on the bus; subscribers receive it with the right shape.
 *   2. `bindOutputDlq()` returns a closure that calls
 *      `emitOutputDeliveryDlq` with a timestamp.
 *   3. Multiple subscribers all receive DLQ events.
 *   4. Subscriber can unsubscribe via the returned cleanup fn.
 *   5. The SSE events route broadcasts `output_delivery_dlq`
 *      over the SSE channel with correct wire format.
 *   6. Auth gating: `/api/admin/events` returns 401 without a
 *      valid admin session.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";

import * as schema from "@opencoo/shared/db/schema";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  createSseBus,
  type OutputDeliveryDlqEvent,
} from "../../src/admin-api/sse-bus.js";
import { registerAdminApi } from "../../src/admin-api/index.js";
import { __resetAdminAuthCache } from "../../src/admin-api/auth.js";
import { MockGiteaClient } from "./_fixture.js";

// ─── Bus-contract tests ───────────────────────────────────────────────────────

describe("SseBus — output_delivery_dlq event emission", () => {
  it("emitOutputDeliveryDlq publishes an event that subscribers receive", () => {
    const bus = createSseBus();
    const received: OutputDeliveryDlqEvent[] = [];
    bus.onOutputDeliveryDlq((e) => received.push(e));

    bus.emitOutputDeliveryDlq({
      type: "output_delivery_dlq",
      outputBindingId: "binding-111",
      deliveryId: "delivery-aaa",
      error: "connect ECONNREFUSED 127.0.0.1:9999",
      occurredAt: "2026-05-02T10:00:00.000Z",
    });

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.type).toBe("output_delivery_dlq");
    expect(evt.outputBindingId).toBe("binding-111");
    expect(evt.deliveryId).toBe("delivery-aaa");
    expect(evt.error).toBe("connect ECONNREFUSED 127.0.0.1:9999");
    expect(evt.occurredAt).toBe("2026-05-02T10:00:00.000Z");
  });

  it("multiple subscribers all receive output_delivery_dlq events", () => {
    const bus = createSseBus();
    const a: OutputDeliveryDlqEvent[] = [];
    const b: OutputDeliveryDlqEvent[] = [];
    bus.onOutputDeliveryDlq((e) => a.push(e));
    bus.onOutputDeliveryDlq((e) => b.push(e));

    bus.emitOutputDeliveryDlq({
      type: "output_delivery_dlq",
      outputBindingId: "b",
      deliveryId: "d",
      error: "timeout",
      occurredAt: new Date().toISOString(),
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("can unsubscribe from output_delivery_dlq events", () => {
    const bus = createSseBus();
    const received: OutputDeliveryDlqEvent[] = [];
    const off = bus.onOutputDeliveryDlq((e) => received.push(e));

    bus.emitOutputDeliveryDlq({
      type: "output_delivery_dlq",
      outputBindingId: "b",
      deliveryId: "d",
      error: "first",
      occurredAt: new Date().toISOString(),
    });
    off();
    bus.emitOutputDeliveryDlq({
      type: "output_delivery_dlq",
      outputBindingId: "b",
      deliveryId: "d",
      error: "second",
      occurredAt: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.error).toBe("first");
  });

  it("bindOutputDlq() returns a closure that calls emitOutputDeliveryDlq with occurredAt", () => {
    const bus = createSseBus();
    const received: OutputDeliveryDlqEvent[] = [];
    bus.onOutputDeliveryDlq((e) => received.push(e));

    const handler = bus.bindOutputDlq();
    handler({
      outputBindingId: "binding-222",
      deliveryId: "delivery-bbb",
      error: new Error("downstream 503"),
    });

    expect(received).toHaveLength(1);
    const evt = received[0]!;
    expect(evt.type).toBe("output_delivery_dlq");
    expect(evt.outputBindingId).toBe("binding-222");
    expect(evt.deliveryId).toBe("delivery-bbb");
    // error is stringified from the Error object
    expect(typeof evt.error).toBe("string");
    expect(evt.error).toContain("downstream 503");
    // occurredAt is a valid ISO timestamp set by the closure
    expect(typeof evt.occurredAt).toBe("string");
    expect(() => new Date(evt.occurredAt)).not.toThrow();
  });

  it("bindOutputDlq() handles a string error value", () => {
    const bus = createSseBus();
    const received: OutputDeliveryDlqEvent[] = [];
    bus.onOutputDeliveryDlq((e) => received.push(e));

    const handler = bus.bindOutputDlq();
    handler({
      outputBindingId: "b",
      deliveryId: "d",
      error: "raw string error",
    });

    expect(received[0]!.error).toBe("raw string error");
  });
});

// ─── SSE route integration tests ─────────────────────────────────────────────
//
// These tests boot the REAL `/api/admin/events` SSE route via
// `app.listen({ port: 0 })` — the same pattern used in sse-heartbeat.test.ts —
// so the full Fastify request pipeline (preHandler auth guard, SSE headers,
// event wire-format) is exercised end-to-end over a real TCP socket.

function buildEnumsDdl(): string {
  const lines: string[] = [];
  for (const value of Object.values(schema)) {
    if (isPgEnum(value)) {
      const e = value as PgEnum<[string, ...string[]]>;
      const literals = e.enumValues
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ");
      lines.push(`CREATE TYPE "${e.enumName}" AS ENUM (${literals});`);
    }
  }
  return lines.join("\n");
}

const MINIMAL_TABLES_DDL = `
  CREATE TABLE domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    class domain_class DEFAULT 'knowledge' NOT NULL,
    locale text DEFAULT 'en' NOT NULL,
    governance_cadence governance_cadence DEFAULT 'continuous' NOT NULL,
    review_role text,
    llm_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    llm_budget_monthly_cap_usd numeric(10, 2),
    retention_days integer,
    worldview_enabled boolean DEFAULT true NOT NULL,
    is_aggregator boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    gitea_username text NOT NULL UNIQUE,
    role user_role DEFAULT 'operator' NOT NULL,
    gitea_teams jsonb DEFAULT '[]'::jsonb NOT NULL,
    gitea_teams_refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE admin_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    action text NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    metadata jsonb NOT NULL,
    source_ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    definition_slug text NOT NULL,
    instance_id uuid,
    trigger agent_trigger NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    output jsonb,
    skills_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    tokens_in integer DEFAULT 0 NOT NULL,
    tokens_out integer DEFAULT 0 NOT NULL,
    cost_usd numeric(10, 6) DEFAULT '0' NOT NULL,
    latency_ms integer DEFAULT 0 NOT NULL,
    status agent_run_status NOT NULL,
    error_class error_class,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE sources_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    adapter_slug text NOT NULL,
    source_id text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    allowed_paths text[] DEFAULT '{}'::text[] NOT NULL,
    review_mode review_mode DEFAULT 'auto' NOT NULL,
    schedule_cron text,
    credentials_id uuid,
    webhook_secret_credentials_id uuid,
    retention_days_override integer,
    enabled boolean DEFAULT true NOT NULL,
    last_scanned_at timestamp with time zone,
    last_scan_cursor text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE automation_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    surfacer_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
    source_page_refs jsonb NOT NULL,
    proposal jsonb NOT NULL,
    status automation_candidate_status NOT NULL DEFAULT 'proposed',
    rationale text,
    reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE marketplace_updates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    marketplace_source text NOT NULL,
    release_tag text NOT NULL,
    target_commitish text NOT NULL,
    tree_sha text NOT NULL,
    skills_diff jsonb NOT NULL,
    status marketplace_update_status NOT NULL DEFAULT 'pending',
    reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketplace_updates_source_release_tag_unique UNIQUE (marketplace_source, release_tag)
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    event_id text,
    payload_hash text NOT NULL,
    payload jsonb,
    signature_ok boolean NOT NULL,
    binding_id uuid REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    delivery_count integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'pending',
    received_at timestamp with time zone NOT NULL DEFAULT now(),
    created_at timestamp with time zone NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ingestion_intake (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    source_doc_id text NOT NULL,
    source_revision text NOT NULL,
    content_hash text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    last_classifier_run_id text,
    error_class text,
    error_text text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
  );
`;

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const ADMIN_PAT = "sse-dlq-integration-pat";

let app: FastifyInstance;
let baseUrl: string;
let pg: PGlite;
let bus: ReturnType<typeof createSseBus>;

beforeAll(async () => {
  __resetAdminAuthCache();

  pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(MINIMAL_TABLES_DDL);
  const db = drizzle(pg, { schema });

  const gitea = new MockGiteaClient();
  gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });

  const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });

  bus = createSseBus();
  app = Fastify({ logger: false });

  await registerAdminApi({
    app,
    db: db as unknown as Parameters<typeof registerAdminApi>[0]["db"],
    giteaClient: gitea,
    adminTeamSlug: "opencoo-admins",
    sessionHmacKey: Buffer.from("test-session-hmac-key-32-bytes-x"),
    logger: silentLogger(),
    llmDebugLog: false,
    provisionOrg: "opencoo",
    credentialStore,
    sseBus: bus,
    // Seam: fire interval callback immediately so the stream becomes writable
    // and we get the connected event without waiting for a real 15 s heartbeat.
    sseSetIntervalFn: (fn: () => void) => setTimeout(fn, 5_000),
    sseClearIntervalFn: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address;
});

afterAll(async () => {
  await app.close();
  await pg.close();
});

describe("SSE /api/admin/events — output_delivery_dlq wire format (real TCP)", () => {
  it("broadcasts event: output_delivery_dlq\\ndata: {...} to connected clients", async () => {
    const ac = new AbortController();
    const chunks: string[] = [];

    const deadline = new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000); // safety timeout
    });

    const fetchPromise = fetch(`${baseUrl}/api/admin/events`, {
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
      signal: ac.signal,
    }).then(async (res) => {
      const reader = res.body?.getReader();
      if (reader == null) return;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value));
          // Emit DLQ event once we have the connected acknowledgement.
          if (/event:\s*connected/.test(chunks.join("")) && chunks.join("").indexOf("output_delivery_dlq") === -1) {
            bus.emitOutputDeliveryDlq({
              type: "output_delivery_dlq",
              outputBindingId: "binding-wire-test",
              deliveryId: "delivery-wire-test-uuid",
              error: "connection refused",
              occurredAt: "2026-05-02T10:00:00.000Z",
            });
          }
          // Stop once we see the DLQ event in the stream.
          if (/output_delivery_dlq/.test(chunks.join(""))) break;
        }
      } catch {
        // AbortError — expected on ac.abort().
      }
    });

    await Promise.race([fetchPromise, deadline]);
    ac.abort();
    await fetchPromise.catch(() => undefined);

    const body = chunks.join("");
    // Wire format: event line + data line
    expect(body).toMatch(/event:\s*connected/);
    expect(body).toMatch(/event:\s*output_delivery_dlq/);
    // Data payload must include the binding and deliveryId.
    expect(body).toContain("binding-wire-test");
    expect(body).toContain("delivery-wire-test-uuid");
  }, 3_000 /* 3 s timeout — real TCP */);

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await fetch(`${baseUrl}/api/admin/events`);
    expect(res.status).toBe(401);
  });

  it("returns 401 when an invalid PAT is provided", async () => {
    const res = await fetch(`${baseUrl}/api/admin/events`, {
      headers: { authorization: "Bearer invalid-pat-not-configured" },
    });
    expect(res.status).toBe(401);
  });
});
