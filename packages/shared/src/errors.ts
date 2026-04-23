// Three-class error taxonomy per CONVENTIONS §2.4 / architecture §6.5.
// Retry logic keys on `errorClass`:
//   - `validation`     → immediate DLQ, no retry
//   - `upstream-quota` → exponential backoff
//   - `transient`      → linear backoff with max attempts

export type ErrorClass = "transient" | "upstream-quota" | "validation";

export interface OpencooErrorOptions {
  readonly cause?: unknown;
}

// `ErrorOptions` is part of ES2022's Error spec and lets downstream
// errors chain through `.cause`. Under `exactOptionalPropertyTypes`,
// `super(msg, { cause: undefined })` is a type error — we have to
// route through a ternary that omits the options object entirely.
function toNativeErrorOptions(
  options?: OpencooErrorOptions,
): ErrorOptions | undefined {
  if (options === undefined) return undefined;
  if (options.cause === undefined) return undefined;
  return { cause: options.cause };
}

export class OpencooError extends Error {
  readonly errorClass: ErrorClass;

  constructor(
    message: string,
    errorClass: ErrorClass,
    options?: OpencooErrorOptions,
  ) {
    super(message, toNativeErrorOptions(options));
    this.errorClass = errorClass;
    this.name = "OpencooError";
  }
}

export class ValidationError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "ValidationError";
  }
}

export class TransientError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "transient", options);
    this.name = "TransientError";
  }
}

export class UpstreamQuotaError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "upstream-quota", options);
    this.name = "UpstreamQuotaError";
  }
}

export function isOpencooError(value: unknown): value is OpencooError {
  return value instanceof OpencooError;
}
