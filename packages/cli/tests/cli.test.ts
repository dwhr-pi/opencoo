/**
 * @opencoo/cli tests (PR 30 / plan #135).
 *
 * Per-command parse smoke + load-bearing security invariants:
 *   - `source forget` non-interactive without --dry-run → exit 1
 *   - `setup` writes .env at mode 0600
 *   - `doctor` redaction: secret VALUES never appear in stdout
 *   - `doctor` exits 1 on any error-level check, 0 on warn-only
 *   - `source forget` writes `erasure_log` rows + disables binding
 *   - `recompile` requires either selector OR --all-in-domain
 */
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExitSentinel,
  __resetProcessExit,
  __setProcessExit,
} from "../src/lib/exit.js";
import { runSetup } from "../src/commands/setup.js";
import { runDoctor } from "../src/commands/doctor.js";
import {
  formatSecret,
  inspectSecret,
} from "../src/lib/credential-redact.js";
import { runServe, type ServeArgs } from "../src/commands/serve.js";
import { runSourceForget } from "../src/commands/source-forget.js";
import { runRecompile } from "../src/commands/recompile.js";
import { parseAndDispatch } from "../src/parse.js";

class CapturingStream {
  buffer = "";
  write = (s: string): boolean => {
    this.buffer += s;
    return true;
  };
}

interface ExitCapture {
  code: number | null;
}

function captureExit(): ExitCapture {
  const cap: ExitCapture = { code: null };
  __setProcessExit(((code: number) => {
    cap.code = code;
    // Throw the public ExitSentinel so the runtime helpers'
    // catch blocks (which check `isExitSentinel(err)`) re-raise
    // the sentinel rather than treating it as a runtime error.
    throw new ExitSentinel(code);
  }) as never);
  return cap;
}

afterEach(() => {
  __resetProcessExit();
});

// ---------------------------------------------------------------------------
// credential-redact helpers
// ---------------------------------------------------------------------------

describe("credential-redact (load-bearing)", () => {
  it("inspectSecret reports `unset` when neither X nor X_FILE is set", () => {
    const r = inspectSecret({}, "FOO");
    expect(r.source).toBe("unset");
    expect(r.bytes).toBe(0);
  });

  it("inspectSecret reports `env` + bytes-only when X is set", () => {
    const r = inspectSecret({ FOO: "abcdef" }, "FOO");
    expect(r.source).toBe("env");
    expect(r.bytes).toBe(6);
    // The value itself is NOT exposed by the structured output.
    expect((r as unknown as { value?: unknown }).value).toBeUndefined();
  });

  it("formatSecret NEVER includes the secret VALUE", () => {
    const SECRET_VALUE = "super-secret-do-not-leak";
    const r = inspectSecret({ FOO: SECRET_VALUE }, "FOO");
    const formatted = formatSecret(r);
    expect(formatted).not.toContain(SECRET_VALUE);
    expect(formatted).toContain("FOO");
    expect(formatted).toContain(`${SECRET_VALUE.length} bytes`);
  });
});

// ---------------------------------------------------------------------------
// `setup` — writes .env at mode 0600
// ---------------------------------------------------------------------------

describe("runSetup", () => {
  it("non-interactive --yes writes .env at mode 0600 with the env values", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const writes: Array<{ path: string; data: string; mode: number }> = [];
    const exit = captureExit();
    try {
      await runSetup({
        cwd: "/tmp/test-cwd",
        env: {
          DATABASE_URL: "postgres://x",
          REDIS_URL: "redis://y",
          GITEA_URL: "https://gitea.test",
          ADMIN_TEAM_SLUG: "opencoo-admins",
          GITEA_BASE_URL: "https://gitea.test",
        },
        nonInteractive: true,
        stdout,
        stderr,
        existsSync: () => false,
        writeFile: (p, data, mode) => writes.push({ path: p, data, mode }),
        randomBytes: (n) => Buffer.alloc(n, 0xab),
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/tmp/test-cwd/.env");
    expect(writes[0]?.mode).toBe(0o600);
    expect(writes[0]?.data).toContain("DATABASE_URL=postgres://x");
    expect(writes[0]?.data).toContain("REDIS_URL=redis://y");
    expect(writes[0]?.data).toContain("ADMIN_TEAM_SLUG=opencoo-admins");
    // Generated keys present.
    expect(writes[0]?.data).toContain("ENCRYPTION_KEY=");
    expect(writes[0]?.data).toContain("SESSION_HMAC_KEY=");
  });

  it("non-interactive --yes errors when a required var is missing in env", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runSetup({
        cwd: "/tmp/test-cwd",
        env: {}, // no required vars
        nonInteractive: true,
        stdout,
        stderr,
        existsSync: () => false,
        writeFile: () => undefined,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("missing");
  });

  it("interactive (default) refuses to overwrite an existing .env", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runSetup({
        cwd: "/tmp/test-cwd",
        env: {},
        nonInteractive: false,
        stdout,
        stderr,
        existsSync: () => true, // pretend .env already there
        writeFile: () => undefined,
        promptsFn: vi.fn() as unknown as Parameters<typeof runSetup>[0]["promptsFn"],
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// `doctor` — never prints secret values; exits 1 on errors
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  it("prints redacted secret summaries — VALUES NEVER LEAK", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    const SECRET = "ENC-KEY-do-not-leak-1234";
    try {
      await runDoctor({
        env: {
          DATABASE_URL: "postgres://localhost",
          ENCRYPTION_KEY: SECRET,
          REDIS_URL: "redis://localhost",
          GITEA_URL: "https://gitea.test",
          ADMIN_TEAM_SLUG: "admins",
          SESSION_HMAC_KEY: "hmac-secret",
          GITEA_BASE_URL: "https://gitea.test",
        },
        json: false,
        stdout,
        stderr,
        // Stub the DB checks so they fail-cleanly without a
        // real connection.
        poolFactory: () =>
          ({
            query: async (): Promise<unknown> => {
              throw new Error("test pool unreachable");
            },
            end: async (): Promise<void> => undefined,
          }) as unknown as Parameters<typeof runDoctor>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    // Combined stdout+stderr must not echo the secret value.
    const combined = stdout.buffer + stderr.buffer;
    expect(combined).not.toContain(SECRET);
    expect(combined).not.toContain("hmac-secret");
    // But the secret NAMES must surface — operator needs to
    // see what's set.
    expect(combined).toContain("ENCRYPTION_KEY");
    expect(combined).toContain("SESSION_HMAC_KEY");
    // DB-unreachable → error → exit 1.
    expect(exit.code).toBe(1);
  });

  it("--json emits a structured DoctorReport", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runDoctor({
        env: {
          DATABASE_URL: "postgres://localhost",
          ENCRYPTION_KEY: "x",
          REDIS_URL: "redis://localhost",
          GITEA_URL: "https://gitea.test",
          ADMIN_TEAM_SLUG: "admins",
          SESSION_HMAC_KEY: "hmac",
          GITEA_BASE_URL: "https://gitea.test",
        },
        json: true,
        stdout,
        stderr,
        // Both `SELECT 1 AS ok` and `SELECT COUNT(*) FROM drizzle.__drizzle_migrations`
        // route through this stub — return the union shape so
        // both checks see what they expect.
        poolFactory: () =>
          ({
            query: async () => ({ rows: [{ ok: 1, count: "6" }] }),
            end: async () => undefined,
          }) as unknown as Parameters<typeof runDoctor>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    const parsed = JSON.parse(stdout.buffer) as { checks: unknown[]; internetFacing: string[] };
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.internetFacing).toContain("/api/admin/_csrf");
    expect(parsed.internetFacing).toContain("/health");
    expect(exit.code).toBe(0);
  });

  it("warns (not errors) when no admin PAT is provided for the team-check", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runDoctor({
        env: {
          DATABASE_URL: "postgres://localhost",
          ENCRYPTION_KEY: "x",
          REDIS_URL: "redis://localhost",
          GITEA_URL: "https://gitea.test",
          ADMIN_TEAM_SLUG: "admins",
          SESSION_HMAC_KEY: "hmac",
          GITEA_BASE_URL: "https://gitea.test",
        },
        json: false,
        stdout,
        stderr,
        poolFactory: () =>
          ({
            query: async () => ({ rows: [{ ok: 1, count: "6" }] }),
            end: async () => undefined,
          }) as unknown as Parameters<typeof runDoctor>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    // Warn-only → exit 0.
    expect(exit.code).toBe(0);
    expect(stderr.buffer).toContain("gitea_team");
    expect(stderr.buffer).toContain("skipped");
  });
});

// ---------------------------------------------------------------------------
// `source forget` — non-interactive without --dry-run → exit 1 (TTY guard)
// ---------------------------------------------------------------------------

describe("runSourceForget — TTY guard (load-bearing)", () => {
  it("non-interactive (no TTY, no --dry-run) → exit 1", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runSourceForget({
        env: {},
        bindingId: "00000000-0000-0000-0000-000000000000",
        executor: "alice",
        dryRun: false,
        stdout,
        stderr,
        tty: { isInteractive: false },
        // The pool factory is never reached because the TTY
        // check exits FIRST. Provide a stub so the test
        // doesn't accidentally hit a real DB.
        poolFactory: () => {
          throw new Error("pool should not be opened on TTY-guard exit");
        },
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("non-interactive");
    expect(stderr.buffer).toContain("--dry-run");
  });

  it("non-interactive WITH --dry-run is allowed (lookup only, no destructive writes)", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    const queries: Array<{ sql: string }> = [];
    try {
      await runSourceForget({
        env: {},
        bindingId: "00000000-0000-0000-0000-000000000000",
        executor: "alice",
        dryRun: true,
        stdout,
        stderr,
        tty: { isInteractive: false },
        poolFactory: () =>
          ({
            connect: async () =>
              ({
                query: async (sql: string) => {
                  queries.push({ sql: sql.split("\n")[0] ?? "" });
                  if (sql.includes("FROM sources_bindings")) {
                    return {
                      rows: [
                        {
                          id: "00000000-0000-0000-0000-000000000000",
                          adapter_slug: "drive",
                          domain_slug: "exec",
                        },
                      ],
                    };
                  }
                  if (sql.includes("FROM ingestion_intake")) {
                    return { rows: [{ count: "5" }] };
                  }
                  if (sql.includes("FROM webhook_events")) {
                    return { rows: [{ count: "0" }] };
                  }
                  return { rows: [] };
                },
                release: () => undefined,
              }),
            end: async () => undefined,
          }) as unknown as Parameters<typeof runSourceForget>[0] extends infer P
            ? P extends { poolFactory?: infer F }
              ? F extends (...a: unknown[]) => infer R
                ? R
                : never
              : never
            : never,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(0);
    expect(stdout.buffer).toContain("--dry-run");
    expect(stdout.buffer).toContain("5 rows to purge");
    // Critically — no DELETE / UPDATE was issued.
    const destructiveQueries = queries.filter(
      (q) =>
        q.sql.startsWith("DELETE") ||
        q.sql.startsWith("UPDATE") ||
        q.sql.startsWith("INSERT INTO erasure_log"),
    );
    expect(destructiveQueries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `recompile` — selector validation
// ---------------------------------------------------------------------------

describe("runRecompile", () => {
  it("requires either <selector> or --all-in-domain", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runRecompile({
        env: {},
        selector: null,
        allInDomain: null,
        executor: "alice",
        stdout,
        stderr,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("either");
  });

  it("rejects mutually-exclusive selector + --all-in-domain", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const exit = captureExit();
    try {
      await runRecompile({
        env: {},
        selector: "exec:processes/onboarding.md",
        allInDomain: "exec",
        executor: "alice",
        stdout,
        stderr,
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(1);
    expect(stderr.buffer).toContain("mutually exclusive");
  });
});

// ---------------------------------------------------------------------------
// commander parse layer
// ---------------------------------------------------------------------------

describe("parseAndDispatch", () => {
  it("dispatches `migrate` to the migrate runner", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const migrate = vi.fn(async () => undefined);
    await parseAndDispatch({
      argv: ["migrate"],
      env: {},
      cwd: "/tmp",
      version: "0.0.0-test",
      stdout,
      stderr,
      runners: { migrate },
    });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate.mock.calls[0]?.[0].skipMigrate).toBe(false);
  });

  it("--skip-migrate threads the flag through", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const migrate = vi.fn(async () => undefined);
    await parseAndDispatch({
      argv: ["migrate", "--skip-migrate"],
      env: {},
      cwd: "/tmp",
      version: "0.0.0-test",
      stdout,
      stderr,
      runners: { migrate },
    });
    expect(migrate.mock.calls[0]?.[0].skipMigrate).toBe(true);
  });

  it("`source forget` requires --executor", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const sourceForget = vi.fn(async () => undefined);
    await expect(
      parseAndDispatch({
        argv: ["source", "forget", "abc"],
        env: {},
        cwd: "/tmp",
        version: "0.0.0-test",
        stdout,
        stderr,
        runners: { sourceForget },
      }),
    ).rejects.toThrow();
    expect(sourceForget).not.toHaveBeenCalled();
  });

  it("`doctor --json` threads json=true through", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const doctor = vi.fn(async () => undefined);
    await parseAndDispatch({
      argv: ["doctor", "--json"],
      env: {},
      cwd: "/tmp",
      version: "0.0.0-test",
      stdout,
      stderr,
      runners: { doctor },
    });
    expect(doctor.mock.calls[0]?.[0].json).toBe(true);
  });

  it("bare `opencoo` (no subcommand) dispatches to runServe", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const serve = vi.fn(async () => undefined);
    await parseAndDispatch({
      argv: [],
      env: { DATABASE_URL: "postgres://x" },
      cwd: "/tmp",
      version: "0.0.0-test",
      stdout,
      stderr,
      runners: { serve },
    });
    expect(serve).toHaveBeenCalledTimes(1);
    expect(serve.mock.calls[0]?.[0].env).toEqual({
      DATABASE_URL: "postgres://x",
    });
  });
});

// ---------------------------------------------------------------------------
// runServe — bare `opencoo` boot verb (PR phase-a-appendix / plan radiant-diffie)
// ---------------------------------------------------------------------------

/** Minimal test-double for the `StartedEngine` shape `runServe`
 *  consumes. Captures `close()` invocations so the test can
 *  assert the signal handler wired correctly. */
interface FakeEngine {
  readonly close: ReturnType<typeof vi.fn>;
}

function makeFakeEngine(): FakeEngine {
  return { close: vi.fn(async () => undefined) };
}

/** Helper — drains the microtask queue so any pending listener
 *  registrations (the `.on("SIGTERM", ...)` calls inside
 *  runServe) settle before the test emits the signal. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runServe", () => {
  it("wires SIGTERM to engine.close + exitOk(0)", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const engine = makeFakeEngine();
    const startFactory = vi.fn(
      async () => engine as unknown as Awaited<ReturnType<ServeArgs["startFactory"]>>,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const env = {
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://y",
      GITEA_URL: "https://gitea.test",
      ENCRYPTION_KEY: "0".repeat(64),
      PORT: "8080",
    };

    const serve = runServe({
      env,
      stdout,
      stderr,
      startFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    // Let runServe finish awaiting startFactory + register listeners.
    await flushMicrotasks();
    await flushMicrotasks();

    expect(startFactory).toHaveBeenCalledTimes(1);
    expect(startFactory.mock.calls[0]?.[0]?.env).toBe(env);

    // Emit SIGTERM — runServe must call engine.close() then exit(0).
    signalSource.emit("SIGTERM");
    await serve;

    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent on repeated SIGTERM (no double-close)", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const engine = makeFakeEngine();
    const startFactory = vi.fn(
      async () => engine as unknown as Awaited<ReturnType<ServeArgs["startFactory"]>>,
    );
    const exit = vi.fn();
    const signalSource = new EventEmitter();

    const serve = runServe({
      env: { DATABASE_URL: "postgres://x" },
      stdout,
      stderr,
      startFactory,
      signalSource,
      exit: exit as unknown as ServeArgs["exit"],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    // Two SIGTERMs back-to-back — runServe must dispatch shutdown
    // exactly once. (engine.close() being internally memoised in
    // engine-scaffold is not enough: removing-then-adding the
    // listener in shutdown is racy if both signal handlers fire
    // before the removeListener calls run.)
    signalSource.emit("SIGTERM");
    signalSource.emit("SIGTERM");
    await serve;

    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("surfaces start failures via exitRuntimeError(2) + stderr", async () => {
    const stdout = new CapturingStream();
    const stderr = new CapturingStream();
    const startFactory = vi.fn(async () => {
      throw new Error("DATABASE_URL invalid");
    });
    const exit = captureExit();
    const signalSource = new EventEmitter();

    try {
      await runServe({
        env: { DATABASE_URL: "bogus" },
        stdout,
        stderr,
        startFactory: startFactory as unknown as ServeArgs["startFactory"],
        signalSource,
        // No `exit` test seam — use the captureExit /
        // __setProcessExit path so we hit the production
        // exit-code routing (exitRuntimeError → ExitSentinel(2)).
      });
    } catch (e) {
      if (!(e instanceof ExitSentinel)) throw e;
    }
    expect(exit.code).toBe(2);
    expect(stderr.buffer).toContain("DATABASE_URL invalid");
  });
});
