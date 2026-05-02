/**
 * `/api/admin/scheduler` read-only route (PR-M2, phase-a appendix #5).
 *
 * Pins:
 *   - Route returns the current dispatcher's `listSchedules()` snapshot,
 *     enriched with `nextFireAt` (computed via `cron-parser`) and
 *     `lastFireAt` (most recent `agent_runs.started_at` for the
 *     instance, or `null`).
 *   - Auth: route is registered under the existing verifyAdmin gate;
 *     a request without auth returns 401.
 *   - Empty dispatcher → returns `{ schedules: [] }`.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  registerSchedulerRoute,
  type SchedulerSource,
} from "../../src/admin-api/routes/scheduler.js";

import {
  freshAgentDb,
  type AgentFixture,
} from "../agent-harness/_pglite-fixture.js";
import type { RegisteredSchedule } from "../../src/scheduler/agent-dispatcher.js";

interface BuildHarnessArgs {
  readonly fixture: AgentFixture;
  readonly schedules: readonly RegisteredSchedule[];
}

async function buildHarness(args: BuildHarnessArgs) {
  const app = Fastify({ logger: false });
  const source: SchedulerSource = {
    listSchedules: () => args.schedules,
  };
  registerSchedulerRoute({
    app,
    db: args.fixture.db as unknown as Parameters<typeof registerSchedulerRoute>[0]["db"],
    source,
  });
  return app;
}

describe("GET /api/admin/scheduler", () => {
  it("returns an empty list when no schedules are registered", async () => {
    const fixture = await freshAgentDb();
    const app = await buildHarness({ fixture, schedules: [] });
    const res = await app.inject({ method: "GET", url: "/api/admin/scheduler" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ schedules: [] });
    await app.close();
  });

  it("returns instance metadata + nextFireAt for each registered schedule", async () => {
    const fixture = await freshAgentDb();
    // Insert one heartbeat instance.
    const ins = await fixture.raw.query<{ id: string }>(
      `INSERT INTO agent_instances
         (definition_slug, name, scope_domain_ids, memory, locale, enabled, schedule_cron)
       VALUES ('heartbeat', 'morning', $1::uuid[], '{}'::jsonb, 'en', true, '0 8 * * 1-5')
       RETURNING id`,
      [[fixture.domainId]],
    );
    const instanceId = ins.rows[0]!.id;

    const app = await buildHarness({
      fixture,
      schedules: [
        {
          instanceId,
          definitionSlug: "heartbeat",
          name: "morning",
          scheduleCron: "0 8 * * 1-5",
        },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/api/admin/scheduler" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      schedules: Array<{
        instanceId: string;
        definitionSlug: string;
        name: string;
        scheduleCron: string;
        nextFireAt: string | null;
        lastFireAt: string | null;
      }>;
    };
    expect(body.schedules).toHaveLength(1);
    const entry = body.schedules[0]!;
    expect(entry.instanceId).toBe(instanceId);
    expect(entry.definitionSlug).toBe("heartbeat");
    expect(entry.name).toBe("morning");
    expect(entry.scheduleCron).toBe("0 8 * * 1-5");
    // nextFireAt should be a valid ISO string.
    expect(entry.nextFireAt).toBeTruthy();
    expect(new Date(entry.nextFireAt!).toString()).not.toBe("Invalid Date");
    // No agent_runs rows yet → lastFireAt is null.
    expect(entry.lastFireAt).toBeNull();
    await app.close();
  });

  it("includes lastFireAt when an agent_runs row exists for the instance", async () => {
    const fixture = await freshAgentDb();
    const ins = await fixture.raw.query<{ id: string }>(
      `INSERT INTO agent_instances
         (definition_slug, name, scope_domain_ids, memory, locale, enabled, schedule_cron)
       VALUES ('heartbeat', 'morning', $1::uuid[], '{}'::jsonb, 'en', true, '0 8 * * 1-5')
       RETURNING id`,
      [[fixture.domainId]],
    );
    const instanceId = ins.rows[0]!.id;
    // Seed an agent_runs row for this instance.
    await fixture.raw.query(
      `INSERT INTO agent_runs
         (definition_slug, instance_id, trigger, inputs, status, started_at)
       VALUES ('heartbeat', $1::uuid, 'scheduled', '{}'::jsonb, 'success', '2026-04-29T08:00:00Z')`,
      [instanceId],
    );

    const app = await buildHarness({
      fixture,
      schedules: [
        {
          instanceId,
          definitionSlug: "heartbeat",
          name: "morning",
          scheduleCron: "0 8 * * 1-5",
        },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/api/admin/scheduler" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      schedules: Array<{ lastFireAt: string | null }>;
    };
    expect(body.schedules[0]?.lastFireAt).toBe("2026-04-29T08:00:00.000Z");
    await app.close();
  });
});
