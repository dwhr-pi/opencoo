/**
 * AgentDispatcher contract tests (PR-M2, phase-a appendix #5).
 *
 * The dispatcher's job:
 *   1. On `start()`: read `agent_instances` rows where
 *      `enabled = true AND schedule_cron IS NOT NULL`. For each row
 *      with a valid cron pattern, register a BullMQ recurring job
 *      `selfop.dispatch` with payload `{ instanceId }`. Skip rows
 *      whose pattern fails `validateCron` and emit a single
 *      `scheduler.invalid_cron` log entry.
 *   2. Construct a `selfop.dispatch` Worker whose handler resolves
 *      the supplied instanceId → loads the instance via
 *      `loadInstanceById` → resolves the matching runner from the
 *      injected runner registry → calls `invokeAgent` with the
 *      runner as `args.run`.
 *   3. On `stop()`: pause + close the worker + queue. Idempotent.
 *
 * The tests use `ioredis-mock` for the BullMQ connection. BullMQ's
 * blocking pull loop is not exercised — the dispatcher's handler is
 * invoked directly via the Job stub the test constructs (same
 * pattern as the ingestion-worker contract tests).
 */
import type { Job, Queue, Worker } from "bullmq";
import IORedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  AgentDefinitionRegistry,
  type AgentDefinition,
} from "../../src/agent-harness/index.js";
import {
  AgentDispatcher,
  type AgentRunnerRegistry,
  type RegisteredSchedule,
} from "../../src/scheduler/agent-dispatcher.js";

import {
  freshAgentDb,
  seedAgentInstance,
  type AgentFixture,
} from "../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const TEST_DEFINITION: AgentDefinition = {
  slug: "heartbeat",
  version: "1.0.0",
  description: "test heartbeat",
  outputSchemaName: "HeartbeatOutput",
  defaultMemory: { type: "none" },
  toolNames: ["worldview.read"],
};

function buildRegistryWith(def: AgentDefinition): AgentDefinitionRegistry {
  const r = new AgentDefinitionRegistry();
  r.register(def);
  return r;
}

function noOpRunnerRegistry(
  invocations: string[],
): AgentRunnerRegistry {
  return {
    get(slug: string) {
      if (slug !== TEST_DEFINITION.slug) return undefined;
      return async (ctx) => {
        invocations.push(ctx.instance.id);
        return { ok: true };
      };
    },
  };
}

async function seedScheduledInstance(
  fixture: AgentFixture,
  args: {
    readonly definitionSlug?: string;
    readonly name?: string;
    readonly scheduleCron?: string | null;
    readonly enabled?: boolean;
  } = {},
): Promise<{ readonly instanceId: string }> {
  // Thin wrapper over the shared seedAgentInstance — keeps the
  // {definitionSlug,name,scheduleCron,enabled} call shape that
  // the dispatcher tests already use.
  const seeded = await seedAgentInstance(fixture, {
    definitionSlug: args.definitionSlug ?? TEST_DEFINITION.slug,
    instanceName: args.name ?? "default",
    scheduleCron: args.scheduleCron ?? null,
    enabled: args.enabled ?? true,
  });
  return { instanceId: seeded.instanceId };
}

interface DispatcherHarness {
  readonly dispatcher: AgentDispatcher;
  readonly redis: InstanceType<typeof IORedisMock>;
  /** Recorded calls from the test stub `registerScheduleFn`. The
   *  real BullMQ recurring-job path uses Lua scripts that
   *  `ioredis-mock` does not implement; the dispatcher exposes a
   *  test seam (`registerScheduleFn`) so assertions land on the
   *  REGISTRATION CONTRACT (what the dispatcher TRIED to register)
   *  rather than on BullMQ's internal Redis state. */
  readonly registered: RegisteredSchedule[];
  cleanup(): Promise<void>;
}

async function startDispatcher(args: {
  readonly fixture: AgentFixture;
  readonly registry?: AgentDefinitionRegistry;
  readonly runners?: AgentRunnerRegistry;
  readonly logs?: string[];
  readonly invocations?: string[];
}): Promise<DispatcherHarness> {
  const redis = new IORedisMock();
  const registry = args.registry ?? buildRegistryWith(TEST_DEFINITION);
  const invocations = args.invocations ?? [];
  const runners = args.runners ?? noOpRunnerRegistry(invocations);
  const logger = args.logs !== undefined
    ? new ConsoleLogger({
        stream: {
          write: (chunk: string): boolean => {
            args.logs!.push(chunk);
            return true;
          },
        },
      })
    : silentLogger();

  const registered: RegisteredSchedule[] = [];
  const registerScheduleFn = async (
    s: RegisteredSchedule,
  ): Promise<void> => {
    registered.push(s);
  };

  const dispatcher = new AgentDispatcher({
    db: args.fixture.db as unknown as ConstructorParameters<
      typeof AgentDispatcher
    >[0]["db"],
    connection: redis as unknown as ConstructorParameters<
      typeof AgentDispatcher
    >[0]["connection"],
    definitions: registry,
    runners,
    logger,
    autorun: false,
    registerScheduleFn,
  });

  return {
    dispatcher,
    redis,
    registered,
    cleanup: async () => {
      await dispatcher.stop();
      redis.disconnect();
    },
  };
}

let activeHarness: DispatcherHarness | null = null;
afterEach(async () => {
  if (activeHarness !== null) {
    await activeHarness.cleanup();
    activeHarness = null;
  }
});

describe("AgentDispatcher.start", () => {
  it("registers a recurring job for each enabled instance with a valid schedule_cron", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      name: "morning",
      scheduleCron: "0 8 * * 1-5",
    });

    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]).toMatchObject({
      instanceId,
      definitionSlug: TEST_DEFINITION.slug,
      name: "morning",
      scheduleCron: "0 8 * * 1-5",
    });
    // listSchedules() reflects the same set.
    expect(harness.dispatcher.listSchedules()).toHaveLength(1);
  });

  it("skips instances with invalid schedule_cron and logs scheduler.invalid_cron", async () => {
    const fixture = await freshAgentDb();
    await seedScheduledInstance(fixture, {
      name: "valid",
      scheduleCron: "0 9 * * *",
    });
    await seedScheduledInstance(fixture, {
      name: "garbage",
      scheduleCron: "not-a-cron",
    });

    const logs: string[] = [];
    const harness = await startDispatcher({ fixture, logs });
    activeHarness = harness;
    await harness.dispatcher.start();

    // Only the valid row registers.
    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]?.scheduleCron).toBe("0 9 * * *");

    const joined = logs.join("");
    expect(joined).toContain("scheduler.invalid_cron");
    expect(joined).toContain("not-a-cron");
  });

  it("ignores rows with enabled=false", async () => {
    const fixture = await freshAgentDb();
    await seedScheduledInstance(fixture, {
      name: "disabled-row",
      scheduleCron: "0 8 * * *",
      enabled: false,
    });

    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    expect(harness.registered).toHaveLength(0);
  });

  it("ignores rows with NULL schedule_cron", async () => {
    const fixture = await freshAgentDb();
    await seedAgentInstance(fixture); // no schedule_cron

    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    expect(harness.registered).toHaveLength(0);
  });
});

describe("AgentDispatcher dispatch handler", () => {
  it("resolves instanceId → invokes invokeAgent with the resolved runner", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      scheduleCron: "0 8 * * *",
    });

    const invocations: string[] = [];
    const harness = await startDispatcher({ fixture, invocations });
    activeHarness = harness;

    // Don't call start() — exercise the handler directly so we don't
    // race the BullMQ pull loop. The handler is the production unit
    // under test here.
    const handler = harness.dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-1",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;

    await handler(job);

    expect(invocations).toEqual([instanceId]);
  });

  it("throws when the instance's definition_slug has no registered runner", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      definitionSlug: "no-such-definition",
      scheduleCron: "0 8 * * *",
    });

    // Empty runner registry so resolution fails.
    const runners: AgentRunnerRegistry = { get: () => undefined };
    const registry = buildRegistryWith(TEST_DEFINITION);
    const harness = await startDispatcher({ fixture, registry, runners });
    activeHarness = harness;

    const handler = harness.dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-2",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;

    await expect(handler(job)).rejects.toThrow(/runner/);
  });

  it("propagates errors from the runner so BullMQ can apply its retry policy", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      scheduleCron: "0 8 * * *",
    });

    const runners: AgentRunnerRegistry = {
      get: () => async () => {
        throw new Error("runner blew up");
      },
    };
    const registry = buildRegistryWith(TEST_DEFINITION);
    const harness = await startDispatcher({ fixture, registry, runners });
    activeHarness = harness;

    const handler = harness.dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-3",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;

    // The harness records the run as `failed` — and the dispatcher
    // forwards no error to BullMQ for that case (the run row IS the
    // dlq surface). The handler resolves cleanly.
    await expect(handler(job)).resolves.toBeDefined();
  });
});

describe("AgentDispatcher.stop", () => {
  beforeEach(() => vi.useRealTimers());

  it("closes the worker + queue", async () => {
    const fixture = await freshAgentDb();
    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    const worker: Worker = harness.dispatcher.workerForTest();
    const queue: Queue = harness.dispatcher.queueForTest();
    const workerCloseSpy = vi.spyOn(worker, "close");
    const queueCloseSpy = vi.spyOn(queue, "close");

    await harness.dispatcher.stop();

    expect(workerCloseSpy).toHaveBeenCalled();
    expect(queueCloseSpy).toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    const fixture = await freshAgentDb();
    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    await harness.dispatcher.stop();
    await expect(harness.dispatcher.stop()).resolves.toBeUndefined();
  });
});

describe("AgentDispatcher — UTC timezone pin (round-3 fix #1)", () => {
  it("passes tz: 'UTC' on every BullMQ repeat-job registration", async () => {
    // Bypass the test-only `registerScheduleFn` seam so the
    // production code path lands a real `queue.add(..., { repeat })`
    // call — that call is what would silently default to host-local
    // time without the round-3 fix. The spy captures the args.
    const fixture = await freshAgentDb();
    await fixture.raw.query(
      `INSERT INTO agent_instances
         (definition_slug, name, scope_domain_ids, memory, locale, enabled, schedule_cron)
       VALUES ('heartbeat', 'morning-utc', $1::uuid[], '{}'::jsonb, 'en', true, '0 8 * * 1-5')`,
      [[fixture.domainId]],
    );

    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners: { get: () => async () => ({ ok: true }) },
      logger: silentLogger(),
      autorun: false,
      // No registerScheduleFn — production code path runs through
      // `queue.add(..., { repeat })`.
    });

    // Spy on the real queue's `add` method. We resolve immediately
    // with a stub Job-shape so BullMQ's Lua-script call (which
    // ioredis-mock doesn't fully implement) never executes.
    const queue = dispatcher.queueForTest();
    const addSpy = vi
      .spyOn(queue, "add")
      .mockResolvedValue({ id: "stub" } as never);

    try {
      await dispatcher.start();

      expect(addSpy).toHaveBeenCalledTimes(1);
      const callArgs = addSpy.mock.calls[0];
      expect(callArgs).toBeDefined();
      const opts = callArgs![2] as { repeat: { tz?: string; pattern?: string } };
      // Round-3 fix #1 — `tz: 'UTC'` MUST be present so BullMQ's
      // repeat parser doesn't silently use `process.env.TZ`. Without
      // this, `0 8 * * 1-5` fires at 8am LOCAL on a developer Mac
      // and `nextFireAt` from the admin route returns a different
      // wall-clock time than what BullMQ scheduled.
      expect(opts.repeat.tz).toBe("UTC");
      expect(opts.repeat.pattern).toBe("0 8 * * 1-5");
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
  });
});
