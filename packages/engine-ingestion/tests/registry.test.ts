/**
 * Pipeline registry — concrete pipelines register at boot via
 * `register(definition)`. The registry enforces:
 *   - unique names (duplicate registration throws loudly)
 *   - case-insensitive lookup is not supported (deliberate; pipeline
 *     names are slugs, not labels)
 *   - listing returns a stable order (insertion order)
 *
 * Used by start() to wire each pipeline to its BullMQ queue.
 */
import { describe, it, expect } from "vitest";

import { PipelineRegistry } from "../src/registry.js";
import type { PipelineDefinition } from "../src/types.js";

const stub: PipelineDefinition = {
  name: "scanner",
  async run(ctx) {
    void ctx;
    return undefined;
  },
};

describe("PipelineRegistry", () => {
  it("starts empty", () => {
    const r = new PipelineRegistry();
    expect(r.list()).toEqual([]);
  });

  it("register + get + list round-trips a single definition", () => {
    const r = new PipelineRegistry();
    r.register(stub);
    expect(r.get("scanner")?.name).toBe("scanner");
    expect(r.list().map((d) => d.name)).toEqual(["scanner"]);
  });

  it("preserves insertion order across multiple registrations", () => {
    const r = new PipelineRegistry();
    r.register({ ...stub, name: "scanner" });
    r.register({ ...stub, name: "compiler" });
    r.register({ ...stub, name: "lint" });
    expect(r.list().map((d) => d.name)).toEqual([
      "scanner",
      "compiler",
      "lint",
    ]);
  });

  it("rejects duplicate names with a clear error", () => {
    const r = new PipelineRegistry();
    r.register(stub);
    expect(() => r.register(stub)).toThrow(/duplicate pipeline name/i);
  });

  it("get() returns undefined for unknown name (no throw)", () => {
    const r = new PipelineRegistry();
    expect(r.get("nope")).toBeUndefined();
  });

  it("size() returns the count", () => {
    const r = new PipelineRegistry();
    expect(r.size()).toBe(0);
    r.register(stub);
    expect(r.size()).toBe(1);
  });
});
