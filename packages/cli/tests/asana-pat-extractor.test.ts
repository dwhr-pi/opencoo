/**
 * `extractAsanaPatFromAuthBlob` tests (PR-Q8 / phase-a appendix #9).
 *
 * Production composition stores the asana credential as the JSON
 * blob `{"personal_access_token":"…","workspace_gid":"…"}` (the
 * `auth` half of the binding's credentialSchema). The
 * `makeAsanaClient` factory closure in `production-composition.ts`
 * threads `extractAsanaPatFromAuthBlob` into `createAsanaClient`'s
 * `patFromRecord` slot so the client's bearer header carries the
 * extracted PAT, not the raw blob.
 */
import { describe, expect, it } from "vitest";

import { extractAsanaPatFromAuthBlob } from "../src/provision/production-composition.js";

describe("extractAsanaPatFromAuthBlob", () => {
  it("extracts personal_access_token from the production credential JSON", () => {
    const blob = JSON.stringify({
      personal_access_token: "1/asana-real-pat",
      workspace_gid: "ws-12345",
    });
    expect(extractAsanaPatFromAuthBlob(Buffer.from(blob, "utf8"))).toBe(
      "1/asana-real-pat",
    );
  });

  it("ignores extra fields on the credential JSON", () => {
    const blob = JSON.stringify({
      personal_access_token: "1/another",
      workspace_gid: "ws-1",
      // future fields the schema may add
      future_optional: "ok",
    });
    expect(extractAsanaPatFromAuthBlob(Buffer.from(blob, "utf8"))).toBe(
      "1/another",
    );
  });

  it("throws when plaintext is not valid JSON", () => {
    expect(() => extractAsanaPatFromAuthBlob(Buffer.from("not-json", "utf8"))).toThrow(
      /source-asana: credential plaintext is not valid JSON/,
    );
  });

  it("throws when plaintext is JSON but not an object", () => {
    expect(() =>
      extractAsanaPatFromAuthBlob(Buffer.from(JSON.stringify("string"), "utf8")),
    ).toThrow(/JSON object with `personal_access_token`/);
    expect(() =>
      extractAsanaPatFromAuthBlob(Buffer.from(JSON.stringify(null), "utf8")),
    ).toThrow(/JSON object with `personal_access_token`/);
  });

  it("throws when personal_access_token is missing", () => {
    const blob = JSON.stringify({ workspace_gid: "ws-1" });
    expect(() => extractAsanaPatFromAuthBlob(Buffer.from(blob, "utf8"))).toThrow(
      /missing `personal_access_token`/,
    );
  });

  it("throws when personal_access_token is empty", () => {
    const blob = JSON.stringify({
      personal_access_token: "",
      workspace_gid: "ws-1",
    });
    expect(() => extractAsanaPatFromAuthBlob(Buffer.from(blob, "utf8"))).toThrow(
      /missing `personal_access_token`/,
    );
  });

  it("throws when personal_access_token is not a string", () => {
    const blob = JSON.stringify({
      personal_access_token: 12345,
      workspace_gid: "ws-1",
    });
    expect(() => extractAsanaPatFromAuthBlob(Buffer.from(blob, "utf8"))).toThrow(
      /missing `personal_access_token`/,
    );
  });
});
