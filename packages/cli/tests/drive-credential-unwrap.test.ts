/**
 * `extractDriveServiceAccountJson` — PR-Y2 hotfix regression
 * (phase-a follow-up).
 *
 * Pre-fix: Z1's `makeDrive` factory passed the entire credential
 * wrapper bytes into `parseServiceAccountJson`, which then
 * correctly reported "missing required field 'client_email'"
 * because the wrapper shape is `{ service_account_json,
 * root_folder_id }` and the SA JSON's `client_email` lives
 * INSIDE the `service_account_json` string. Observed live on
 * the partner cutover of 0.1.0-a.3 — every Drive seed attempt
 * failed with the same error.
 *
 * This test pins the unwrap path so a future change that
 * reverts back to passing the wrapper bytes is caught at CI.
 */
import { describe, expect, it } from "vitest";

import { extractDriveServiceAccountJson } from "../src/provision/production-composition.js";

const SAMPLE_SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "example-project",
  private_key_id: "abc",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nfake-bytes\n-----END PRIVATE KEY-----\n",
  client_email: "n8n-604@example-project.iam.gserviceaccount.com",
  client_id: "100000000000000000000",
});

describe("extractDriveServiceAccountJson", () => {
  it("returns the inner service_account_json string from the credential wrapper", () => {
    const wrapper = JSON.stringify({
      service_account_json: SAMPLE_SA_JSON,
      root_folder_id: "1XYZ-fake-folder-id",
    });
    const out = extractDriveServiceAccountJson(Buffer.from(wrapper, "utf8"));
    expect(out).toBe(SAMPLE_SA_JSON);
    const parsed = JSON.parse(out) as { client_email: string };
    expect(parsed.client_email).toBe(
      "n8n-604@example-project.iam.gserviceaccount.com",
    );
  });

  it("throws a clear error if the wrapper is not valid JSON", () => {
    expect(() =>
      extractDriveServiceAccountJson(Buffer.from("{not json", "utf8")),
    ).toThrow(/drive: credential blob is not valid JSON/);
  });

  it("throws if the wrapper is not an object", () => {
    expect(() =>
      extractDriveServiceAccountJson(Buffer.from('"a-string"', "utf8")),
    ).toThrow(/drive: credential blob must be an object/);
    expect(() =>
      extractDriveServiceAccountJson(Buffer.from("[]", "utf8")),
    ).toThrow(/drive: credential blob must be an object/);
    expect(() =>
      extractDriveServiceAccountJson(Buffer.from("null", "utf8")),
    ).toThrow(/drive: credential blob must be an object/);
  });

  it("throws if service_account_json field is missing", () => {
    const wrapper = JSON.stringify({ root_folder_id: "1XYZ-only" });
    expect(() =>
      extractDriveServiceAccountJson(Buffer.from(wrapper, "utf8")),
    ).toThrow(/missing required field 'service_account_json'/);
  });

  it("throws if service_account_json field is empty string", () => {
    const wrapper = JSON.stringify({
      service_account_json: "",
      root_folder_id: "1XYZ",
    });
    expect(() =>
      extractDriveServiceAccountJson(Buffer.from(wrapper, "utf8")),
    ).toThrow(/missing required field 'service_account_json'/);
  });

  it("throws if service_account_json field is not a string", () => {
    const wrapper = JSON.stringify({
      service_account_json: { nested: "object" },
      root_folder_id: "1XYZ",
    });
    expect(() =>
      extractDriveServiceAccountJson(Buffer.from(wrapper, "utf8")),
    ).toThrow(/missing required field 'service_account_json'/);
  });
});
