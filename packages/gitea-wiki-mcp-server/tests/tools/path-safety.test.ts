import { describe, it, expect } from "vitest";
import { safeResolve, PathSafetyError } from "../../src/services/path-safety.js";

const ROOT = "/tmp/test-repo";

describe("safeResolve", () => {
  it("accepts clean repo-relative paths", () => {
    expect(safeResolve(ROOT, "index.md")).toBe("/tmp/test-repo/index.md");
    expect(safeResolve(ROOT, "strategy/fundamentals.md")).toBe(
      "/tmp/test-repo/strategy/fundamentals.md",
    );
    expect(safeResolve(ROOT, "./index.md")).toBe("/tmp/test-repo/index.md");
  });

  it("rejects absolute paths", () => {
    expect(() => safeResolve(ROOT, "/etc/passwd")).toThrow(PathSafetyError);
  });

  it("rejects path traversal", () => {
    expect(() => safeResolve(ROOT, "../escape")).toThrow(PathSafetyError);
    expect(() => safeResolve(ROOT, "strategy/../../escape")).toThrow(PathSafetyError);
    expect(() => safeResolve(ROOT, "../../../etc/passwd")).toThrow(PathSafetyError);
  });

  it("rejects null bytes", () => {
    expect(() => safeResolve(ROOT, "strategy/fund\0mentals.md")).toThrow(
      PathSafetyError,
    );
  });

  it("rejects empty and oversized paths", () => {
    expect(() => safeResolve(ROOT, "")).toThrow(PathSafetyError);
    expect(() => safeResolve(ROOT, "a".repeat(501))).toThrow(PathSafetyError);
  });
});
