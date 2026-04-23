// Minimal JSON-per-line logger for opencoo engine code. Writes one
// JSON object per call to a stream (default: process.stdout), so the
// log is always safe to split on `\n` downstream — `JSON.stringify`
// escapes interior newlines.
//
// Level filtering is threshold-based; `child()` layers a merged
// context onto a new logger without sharing mutable state with the
// parent. Test seams: `stream` captures writes, `now` pins the
// timestamp. `loggerFromEnv` reads the `LOG_LEVEL` env var and falls
// back to `info` on anything unrecognized.
//
// NOTE: this logger does NOT filter raw prompts/responses at runtime.
// THREAT-MODEL §2 invariant 11 is a code-review gate. Prompts go
// through `llm_usage_debug` (PR 07), not `logger.info`.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

const LEVEL_ORDER: ReadonlyMap<LogLevel, number> = new Map([
  ["debug", 0],
  ["info", 1],
  ["warn", 2],
  ["error", 3],
]);

const ALLOWED_LEVELS: ReadonlySet<string> = new Set(LEVEL_ORDER.keys());

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && ALLOWED_LEVELS.has(value);
}

export interface LoggerWriteStream {
  write(chunk: string): boolean;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly context?: LogContext;
  readonly stream?: LoggerWriteStream;
  readonly now?: () => Date;
}

const DEFAULT_LEVEL: LogLevel = "info";

export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly context: LogContext;
  private readonly stream: LoggerWriteStream;
  private readonly now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? DEFAULT_LEVEL;
    this.context = options.context ?? {};
    this.stream = options.stream ?? process.stdout;
    this.now = options.now ?? ((): Date => new Date());
  }

  debug(msg: string, ctx?: LogContext): void {
    this.emit("debug", msg, ctx);
  }

  info(msg: string, ctx?: LogContext): void {
    this.emit("info", msg, ctx);
  }

  warn(msg: string, ctx?: LogContext): void {
    this.emit("warn", msg, ctx);
  }

  error(msg: string, ctx?: LogContext): void {
    this.emit("error", msg, ctx);
  }

  child(ctx: LogContext): Logger {
    return new ConsoleLogger({
      level: this.level,
      context: { ...this.context, ...ctx },
      stream: this.stream,
      now: this.now,
    });
  }

  private emit(level: LogLevel, msg: string, ctx?: LogContext): void {
    const threshold = LEVEL_ORDER.get(this.level) ?? 0;
    const lineLevel = LEVEL_ORDER.get(level) ?? 0;
    if (lineLevel < threshold) return;

    const payload: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
      msg,
      ...this.context,
      ...(ctx ?? {}),
    };
    this.stream.write(JSON.stringify(payload) + "\n");
  }
}

export function loggerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { stream?: LoggerWriteStream; now?: () => Date } = {},
): Logger {
  const raw = env["LOG_LEVEL"];
  const level: LogLevel = isLogLevel(raw) ? raw : DEFAULT_LEVEL;
  return new ConsoleLogger({
    level,
    ...(overrides.stream !== undefined ? { stream: overrides.stream } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}
