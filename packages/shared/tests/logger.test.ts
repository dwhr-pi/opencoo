import { describe, expect, it } from "vitest";

import {
  ConsoleLogger,
  loggerFromEnv,
  type LogContext,
  type LogLevel,
} from "../src/logger.js";

// Minimal mock of the subset of `NodeJS.WritableStream` the logger touches.
// The logger is deliberately stream-agnostic so tests can capture writes
// without spawning a real stdout. `write` returns true so the logger's
// backpressure check (if any) never short-circuits in tests.
class MockStream {
  public readonly writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

const FIXED_TS = new Date("2026-04-23T20:00:00.000Z");
const fixedNow = (): Date => FIXED_TS;

function newLogger(
  options: {
    level?: LogLevel;
    context?: LogContext;
    stream?: MockStream;
  } = {},
): { logger: ConsoleLogger; stream: MockStream } {
  const stream = options.stream ?? new MockStream();
  const ctorOptions = {
    stream,
    now: fixedNow,
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
  };
  const logger = new ConsoleLogger(ctorOptions);
  return { logger, stream };
}

describe("ConsoleLogger", () => {
  it("emits a single line of JSON per call with ts, level, msg", () => {
    const { logger, stream } = newLogger();
    logger.info("hello");
    expect(stream.writes).toHaveLength(1);
    const line = stream.writes[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["ts"]).toBe(FIXED_TS.toISOString());
    expect(parsed["level"]).toBe("info");
    expect(parsed["msg"]).toBe("hello");
  });

  it("merges context fields into the emitted object", () => {
    const { logger, stream } = newLogger({ context: { requestId: "r-1" } });
    logger.info("msg", { domainSlug: "wiki-exec" });
    const parsed = JSON.parse(stream.writes[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(parsed["requestId"]).toBe("r-1");
    expect(parsed["domainSlug"]).toBe("wiki-exec");
  });

  it("drops debug below default info threshold", () => {
    const { logger, stream } = newLogger();
    logger.debug("quiet");
    expect(stream.writes).toHaveLength(0);
  });

  it("drops info when level is 'warn'", () => {
    const { logger, stream } = newLogger({ level: "warn" });
    logger.info("not visible");
    expect(stream.writes).toHaveLength(0);
  });

  it("emits at level=error from level=error", () => {
    const { logger, stream } = newLogger({ level: "error" });
    logger.error("oops");
    expect(stream.writes).toHaveLength(1);
    const parsed = JSON.parse(stream.writes[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(parsed["level"]).toBe("error");
  });

  it("emits at level=warn when threshold=warn", () => {
    const { logger, stream } = newLogger({ level: "warn" });
    logger.warn("watch out");
    logger.error("bad");
    expect(stream.writes).toHaveLength(2);
  });

  it("never writes an unescaped newline inside the JSON body", () => {
    const { logger, stream } = newLogger();
    logger.info("line\nwith\nbreaks", { field: "with\nbreak" });
    const line = stream.writes[0] ?? "";
    // Exactly one terminating newline at the end; no interior newlines.
    expect(line.indexOf("\n")).toBe(line.length - 1);
    // Round-trip survives.
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["msg"]).toBe("line\nwith\nbreaks");
    expect(parsed["field"]).toBe("with\nbreak");
  });

  it("child(ctx) returns a logger with merged context", () => {
    const { logger, stream } = newLogger({ context: { requestId: "r-1" } });
    const child = logger.child({ phase: "classify" });
    child.info("step");
    const parsed = JSON.parse(stream.writes[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(parsed["requestId"]).toBe("r-1");
    expect(parsed["phase"]).toBe("classify");
  });

  it("child context shadows parent on same key", () => {
    const { logger, stream } = newLogger({ context: { requestId: "parent" } });
    const child = logger.child({ requestId: "child" });
    child.info("step");
    const parsed = JSON.parse(stream.writes[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(parsed["requestId"]).toBe("child");
  });

  it("child is independent of parent state (no shared mutation)", () => {
    const { logger, stream } = newLogger({ context: { a: 1 } });
    const child = logger.child({ b: 2 });
    logger.info("parent-msg");
    child.info("child-msg");
    const parent = JSON.parse(stream.writes[0] ?? "") as Record<
      string,
      unknown
    >;
    const kid = JSON.parse(stream.writes[1] ?? "") as Record<string, unknown>;
    expect(parent["a"]).toBe(1);
    expect(parent["b"]).toBeUndefined();
    expect(kid["a"]).toBe(1);
    expect(kid["b"]).toBe(2);
  });

  it("round-trip: every write is a well-formed single-line JSON object", () => {
    const { logger, stream } = newLogger();
    logger.info("one");
    logger.warn("two", { k: "v" });
    logger.error("three", { nested: { deep: true } });
    expect(stream.writes).toHaveLength(3);
    for (const line of stream.writes) {
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed["ts"]).toBe("string");
      expect(typeof parsed["level"]).toBe("string");
      expect(typeof parsed["msg"]).toBe("string");
    }
  });
});

describe("loggerFromEnv", () => {
  it("defaults to info when LOG_LEVEL is unset", () => {
    const stream = new MockStream();
    const logger = loggerFromEnv(
      {},
      { stream, now: fixedNow },
    );
    logger.debug("skipped");
    logger.info("seen");
    expect(stream.writes).toHaveLength(1);
  });

  it("respects LOG_LEVEL=warn", () => {
    const stream = new MockStream();
    const logger = loggerFromEnv(
      { LOG_LEVEL: "warn" },
      { stream, now: fixedNow },
    );
    logger.info("skipped");
    logger.warn("seen");
    expect(stream.writes).toHaveLength(1);
    const parsed = JSON.parse(stream.writes[0] ?? "") as Record<
      string,
      unknown
    >;
    expect(parsed["level"]).toBe("warn");
  });

  it("respects LOG_LEVEL=debug", () => {
    const stream = new MockStream();
    const logger = loggerFromEnv(
      { LOG_LEVEL: "debug" },
      { stream, now: fixedNow },
    );
    logger.debug("seen");
    expect(stream.writes).toHaveLength(1);
  });

  it("falls back to info when LOG_LEVEL is an unknown string", () => {
    const stream = new MockStream();
    const logger = loggerFromEnv(
      { LOG_LEVEL: "garbage" },
      { stream, now: fixedNow },
    );
    logger.debug("skipped");
    logger.info("seen");
    expect(stream.writes).toHaveLength(1);
  });

  it("falls back to info when LOG_LEVEL is empty string", () => {
    const stream = new MockStream();
    const logger = loggerFromEnv(
      { LOG_LEVEL: "" },
      { stream, now: fixedNow },
    );
    logger.debug("skipped");
    logger.info("seen");
    expect(stream.writes).toHaveLength(1);
  });
});
