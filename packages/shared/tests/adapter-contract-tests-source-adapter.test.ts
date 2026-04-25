/**
 * Type-pin test for the sourceAdapterContract signature
 * (PR 23 / plan #111). Downstream adapters (PR 23 source-drive,
 * PR 24 Asana, PR 27 Fireflies) all import this same generator;
 * this test pins its shape so a future refactor of the
 * suite's API breaks the contract test FIRST, not the
 * downstream adapter test.
 *
 * Two pins:
 *   1. `sourceAdapterContract` is a single named function
 *      taking `SourceAdapterFixtureOptions`.
 *   2. `SourceAdapterFixtureOptions` requires
 *      {backendName, mode, makeAdapter} — adding a required
 *      field breaks the build of every downstream adapter
 *      test, which is what we want for a load-bearing port
 *      surface.
 */
import { describe, expect, it } from "vitest";

import {
  sourceAdapterContract,
  type SourceAdapterFixtureOptions,
} from "../src/adapter-contract-tests/source-adapter.js";

describe("sourceAdapterContract — generator signature pin", () => {
  it("is a function", () => {
    expect(typeof sourceAdapterContract).toBe("function");
  });

  it("takes one (options) argument", () => {
    expect(sourceAdapterContract.length).toBe(1);
  });

  it("type assignability: SourceAdapterFixtureOptions has backendName + mode + makeAdapter (compile-time pin)", () => {
    // If a future refactor renames or removes any of these
    // fields, this assignment fails to compile — the build
    // breaks downstream-of-shared, which is the desired
    // behavior for a load-bearing port surface.
    const _shape: SourceAdapterFixtureOptions = {
      backendName: "test",
      mode: "polling",
      makeAdapter: async () => ({
        adapter: { slug: "test", scan: async () => ({ documents: [], nextCursor: null }) },
        simulate: {
          addDoc: () => undefined,
          bumpRevision: () => undefined,
          removeDoc: () => undefined,
        },
        seed: () => undefined,
        cleanup: async () => undefined,
      }),
    };
    expect(_shape.backendName).toBe("test");
    expect(_shape.mode).toBe("polling");
  });

  it("mode is the closed union {polling | webhook}", () => {
    const polling: SourceAdapterFixtureOptions["mode"] = "polling";
    const webhook: SourceAdapterFixtureOptions["mode"] = "webhook";
    expect(polling).toBe("polling");
    expect(webhook).toBe("webhook");
    // @ts-expect-error — 'http' is not in the closed mode union
    const invalid: SourceAdapterFixtureOptions["mode"] = "http";
    expect(invalid).toBe("http"); // value is set but TS errored above
  });
});
