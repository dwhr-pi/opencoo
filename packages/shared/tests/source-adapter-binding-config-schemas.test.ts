/**
 * Source-adapter binding-config schema registry test (PR-Q9 of
 * phase-a appendix #9).
 *
 * The Management UI's "+ New binding" wizard needs a JSON-Schema-
 * shaped descriptor for each adapter's operational settings, so
 * the third step ("config") can render dynamically. The descriptors
 * live next to the credential schemas and the same `engine-self-
 * operating` route validates submitted config against them BEFORE
 * the binding row INSERT.
 *
 * Drift prevention: the JSON Schemas here are hand-authored
 * mirrors of each adapter's Zod `<adapter>BindingConfigSchema`.
 * The drift-prevention coverage lives in each adapter package's
 * test suite (asserting the Zod schema's required-set matches the
 * JSON Schema's required-set). This file pins the registry's
 * structural shape: every wired adapter has an entry, every entry
 * is a valid `BindingConfigSchema`, and asana's `projectGid`
 * (the field that motivated PR-Q9) is required.
 */
import { describe, expect, it } from "vitest";

import {
  SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS,
  getSourceAdapterBindingConfigSchema,
  type BindingConfigSchema,
} from "../src/source-adapter/binding-config-schemas.js";
import type { SourceAdapterSlug } from "../src/source-adapter/credential-schemas.js";

describe("SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS", () => {
  const ALL_SLUGS = [
    "drive",
    "asana",
    "n8n",
    "fireflies",
    "webhook",
  ] as const satisfies readonly SourceAdapterSlug[];

  it("declares a binding-config entry for every wired SourceAdapter", () => {
    for (const slug of ALL_SLUGS) {
      const s = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS[slug];
      expect(s, `missing binding-config schema for slug=${slug}`).toBeDefined();
      expect(s.type).toBe("object");
      expect(s.properties).toBeDefined();
      expect(Array.isArray(s.required)).toBe(true);
    }
  });

  it("getSourceAdapterBindingConfigSchema returns the registered schema", () => {
    for (const slug of ALL_SLUGS) {
      expect(getSourceAdapterBindingConfigSchema(slug)).toBe(
        SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS[slug],
      );
    }
  });

  it("getSourceAdapterBindingConfigSchema returns undefined for an unknown slug", () => {
    expect(getSourceAdapterBindingConfigSchema("nonexistent")).toBeUndefined();
  });

  it("asana requires `projectGid` (the field that motivated PR-Q9)", () => {
    const asana = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["asana"];
    expect(asana.required).toContain("projectGid");
    expect(asana.properties["projectGid"]).toBeDefined();
    expect(asana.properties["projectGid"]?.type).toBe("string");
  });

  it("asana surfaces `reviewMode` with default 'auto' so the UI can prefill", () => {
    const asana = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["asana"];
    expect(asana.properties["reviewMode"]?.default).toBe("auto");
    expect(asana.properties["reviewMode"]?.enum).toEqual(["auto", "review"]);
  });

  it("asana marks `webhookSecretCredentialId` as hidden (back-filled by handshake)", () => {
    const asana = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["asana"];
    expect(asana.properties["webhookSecretCredentialId"]?.hidden).toBe(true);
  });

  it("drive requires `folderId`", () => {
    const drive = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["drive"];
    expect(drive.required).toContain("folderId");
  });

  it("n8n requires `baseUrl`", () => {
    const n8n = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["n8n"];
    expect(n8n.required).toContain("baseUrl");
  });

  it("fireflies has no required config fields (transcripts ingest fully via defaults)", () => {
    const fireflies = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["fireflies"];
    expect(fireflies.required).toEqual([]);
  });

  it("webhook requires both `pathSegment` and `eventIdField`", () => {
    const webhook = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["webhook"];
    expect(webhook.required).toContain("pathSegment");
    expect(webhook.required).toContain("eventIdField");
  });

  it("every required field has a corresponding `properties` entry", () => {
    for (const slug of ALL_SLUGS) {
      const s: BindingConfigSchema =
        SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS[slug];
      for (const r of s.required) {
        expect(
          s.properties[r],
          `slug=${slug} required=${r} has no properties entry`,
        ).toBeDefined();
      }
    }
  });

  it("array fields declare `items: { type: 'string' }` (v0.1 only supports array-of-string)", () => {
    for (const slug of ALL_SLUGS) {
      const s = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS[slug];
      for (const [key, field] of Object.entries(s.properties)) {
        if (field.type === "array") {
          expect(
            field.items?.type,
            `slug=${slug} key=${key} array field missing items.type`,
          ).toBe("string");
        }
      }
    }
  });

  it("enum-typed fields declare a non-empty enum array", () => {
    for (const slug of ALL_SLUGS) {
      const s = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS[slug];
      for (const [key, field] of Object.entries(s.properties)) {
        if (field.enum !== undefined) {
          expect(
            field.enum.length,
            `slug=${slug} key=${key} enum is empty`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });
});
