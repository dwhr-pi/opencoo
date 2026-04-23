import { describe, expect, it } from "vitest";

import {
  isOpencooError,
  OpencooError,
  TransientError,
  UpstreamQuotaError,
  ValidationError,
} from "../src/errors.js";

describe("OpencooError base", () => {
  it("stores errorClass, message, and name", () => {
    const e = new OpencooError("boom", "validation");
    expect(e.message).toBe("boom");
    expect(e.errorClass).toBe("validation");
    expect(e.name).toBe("OpencooError");
  });

  it("propagates Error.cause when provided", () => {
    const cause = new Error("root cause");
    const e = new OpencooError("boom", "transient", { cause });
    expect(e.cause).toBe(cause);
  });

  it("has undefined cause when no options passed", () => {
    const e = new OpencooError("boom", "transient");
    expect(e.cause).toBeUndefined();
  });

  it("has undefined cause when options with no cause passed", () => {
    const e = new OpencooError("boom", "transient", {});
    expect(e.cause).toBeUndefined();
  });

  it("is an Error subclass", () => {
    expect(new OpencooError("x", "validation")).toBeInstanceOf(Error);
  });
});

describe("ValidationError", () => {
  it("sets errorClass to 'validation' and name to 'ValidationError'", () => {
    const e = new ValidationError("missing field");
    expect(e.errorClass).toBe("validation");
    expect(e.name).toBe("ValidationError");
    expect(e.message).toBe("missing field");
  });

  it("is instanceof OpencooError", () => {
    expect(new ValidationError("x")).toBeInstanceOf(OpencooError);
  });

  it("propagates cause via options", () => {
    const zodLike = new Error("zod fail");
    const e = new ValidationError("bad input", { cause: zodLike });
    expect(e.cause).toBe(zodLike);
  });
});

describe("TransientError", () => {
  it("sets errorClass to 'transient' and name to 'TransientError'", () => {
    const e = new TransientError("connection reset");
    expect(e.errorClass).toBe("transient");
    expect(e.name).toBe("TransientError");
  });

  it("is instanceof OpencooError", () => {
    expect(new TransientError("x")).toBeInstanceOf(OpencooError);
  });

  it("propagates cause", () => {
    const net = new Error("ECONNRESET");
    const e = new TransientError("retry me", { cause: net });
    expect(e.cause).toBe(net);
  });
});

describe("UpstreamQuotaError", () => {
  it("sets errorClass to 'upstream-quota' and name to 'UpstreamQuotaError'", () => {
    const e = new UpstreamQuotaError("429 rate-limited");
    expect(e.errorClass).toBe("upstream-quota");
    expect(e.name).toBe("UpstreamQuotaError");
  });

  it("is instanceof OpencooError", () => {
    expect(new UpstreamQuotaError("x")).toBeInstanceOf(OpencooError);
  });
});

describe("isOpencooError type guard", () => {
  it("returns false for plain Error", () => {
    expect(isOpencooError(new Error("x"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isOpencooError("string")).toBe(false);
    expect(isOpencooError(null)).toBe(false);
    expect(isOpencooError(undefined)).toBe(false);
    expect(isOpencooError({ message: "x" })).toBe(false);
  });

  it("returns true for OpencooError directly", () => {
    expect(isOpencooError(new OpencooError("x", "validation"))).toBe(true);
  });

  it("returns true for each subclass", () => {
    expect(isOpencooError(new ValidationError("x"))).toBe(true);
    expect(isOpencooError(new TransientError("x"))).toBe(true);
    expect(isOpencooError(new UpstreamQuotaError("x"))).toBe(true);
  });
});
