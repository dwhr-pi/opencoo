/**
 * AdapterRegistry — engine-ingestion looks up the source adapter
 * for an incoming binding by `adapter_slug`. v0.1 ships an
 * in-memory registry; the SourceAdapter port itself lands in PR
 * 23+. The receiver only needs `get(slug) → adapter | undefined`
 * shape today.
 */
import { describe, it, expect } from "vitest";

import {
  InMemoryAdapterRegistry,
  AdapterNotFoundError,
  type SourceAdapterStub,
} from "../../src/intake/adapter-registry.js";

const stub: SourceAdapterStub = { slug: "drive" };

describe("InMemoryAdapterRegistry", () => {
  it("starts empty", () => {
    const r = new InMemoryAdapterRegistry();
    expect(r.list()).toEqual([]);
  });

  it("register + get round-trips an adapter by its slug", () => {
    const r = new InMemoryAdapterRegistry();
    r.register(stub);
    expect(r.get("drive")?.slug).toBe("drive");
  });

  it("get(unknown) returns undefined (no throw)", () => {
    const r = new InMemoryAdapterRegistry();
    expect(r.get("nope")).toBeUndefined();
  });

  it("require() throws AdapterNotFoundError for unknown slug", () => {
    const r = new InMemoryAdapterRegistry();
    expect(() => r.require("nope")).toThrow(AdapterNotFoundError);
  });

  it("require() returns the adapter for known slug", () => {
    const r = new InMemoryAdapterRegistry();
    r.register(stub);
    expect(r.require("drive").slug).toBe("drive");
  });

  it("rejects duplicate registration with a clear error", () => {
    const r = new InMemoryAdapterRegistry();
    r.register(stub);
    expect(() => r.register(stub)).toThrow(/duplicate/i);
  });

  it("preserves insertion order in list()", () => {
    const r = new InMemoryAdapterRegistry();
    r.register({ slug: "drive" });
    r.register({ slug: "asana" });
    r.register({ slug: "fireflies" });
    expect(r.list().map((a) => a.slug)).toEqual(["drive", "asana", "fireflies"]);
  });

  it("AdapterNotFoundError carries the missing slug + errorClass:'validation'", () => {
    const err = new AdapterNotFoundError("missing-slug");
    expect(err.errorClass).toBe("validation");
    expect(err.slug).toBe("missing-slug");
    expect(err.name).toBe("AdapterNotFoundError");
    expect(err.message).toContain("missing-slug");
  });
});
