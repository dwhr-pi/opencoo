/**
 * Drift-prevention test (PR-Q9 of phase-a appendix #9).
 *
 * The shared `SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS` registry hand-
 * authors a JSON Schema for asana that the engine's admin API
 * surfaces to the Management UI. The actual validation source of
 * truth is THIS package's `asanaBindingConfigSchema` (Zod) — the
 * adapter parses persisted config through it at scan/webhook time.
 *
 * Both must agree on which fields are required. This test asserts
 * the Zod required-set matches the JSON Schema's `required[]` so
 * a Zod-level edit cannot silently leak past UI validation.
 *
 * If you change the Zod schema and this test fails, update
 * `packages/shared/src/source-adapter/binding-config-schemas.ts`
 * to mirror the new required-set.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS } from "@opencoo/shared/source-adapter";

import { asanaBindingConfigSchema } from "../src/index.js";

/** Walk a Zod object schema and return the keys whose `parse({})`
 *  step would fail because the field has no default + is not
 *  optional. Mirrors how the JSON-Schema `required[]` list is
 *  meant to be consumed (UI required-marker + server validator). */
function zodRequiredKeys(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const required: string[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    // Zod treats a field as "required" when:
    //   - it is NOT a ZodOptional, and
    //   - it has NO `.default(...)` clause.
    // Zod 4 flattens `z.string().min(1).default(...)` into a
    // `ZodDefault` wrapper at runtime; the safest probe is a
    // structural parse against `undefined` (a synthetic empty
    // input forces every Required gate to fire).
    const probe = (field as z.ZodTypeAny).safeParse(undefined);
    if (!probe.success) {
      required.push(key);
    }
  }
  return required.sort();
}

describe("asana binding-config schema drift (PR-Q9)", () => {
  const zodSchema = asanaBindingConfigSchema as unknown as z.ZodObject<
    z.ZodRawShape
  >;
  const jsonSchema = SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS["asana"];

  it("Zod required-set matches the shared JSON-Schema required[]", () => {
    const zodRequired = zodRequiredKeys(zodSchema);
    const jsonRequired = [...jsonSchema.required].sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it("every JSON-Schema property name corresponds to a Zod schema field", () => {
    const zodKeys = new Set(Object.keys(zodSchema.shape));
    for (const k of Object.keys(jsonSchema.properties)) {
      expect(
        zodKeys.has(k),
        `JSON-Schema declares "${k}" but Zod schema has no such field`,
      ).toBe(true);
    }
  });

  // Reverse-direction drift: a Zod field MISSING from JSON-Schema is a
  // silent UI regression (the wizard never renders an input for it,
  // operator can't supply it, server may RE-write a default). Reviewer
  // triage on PR-Q9 (round-2): fail loudly.
  it("every Zod schema field appears in JSON-Schema properties", () => {
    const jsonKeys = new Set(Object.keys(jsonSchema.properties));
    for (const k of Object.keys(zodSchema.shape)) {
      expect(
        jsonKeys.has(k),
        `Zod schema declares "${k}" but JSON-Schema has no such property — wizard would silently skip it`,
      ).toBe(true);
    }
  });

  // Zod default → JSON-Schema default: a divergence here means the
  // wizard prefills a DIFFERENT value than the adapter actually
  // accepts, which manifests as "I clicked Create but the binding
  // came up disabled / wrong-mode."
  it("Zod default values match JSON-Schema defaults", () => {
    for (const [key, prop] of Object.entries(jsonSchema.properties)) {
      if (prop.default === undefined) continue;
      const zodField = zodSchema.shape[key];
      if (zodField === undefined) continue;
      // Probe the Zod field with `parse(undefined)` — `ZodDefault`
      // resolves the default; everything else throws (which we treat
      // as "no default to compare").
      const probe = (zodField as z.ZodTypeAny).safeParse(undefined);
      if (!probe.success) continue;
      expect(
        probe.data,
        `Zod default for "${key}" (${JSON.stringify(probe.data)}) does not match JSON-Schema default (${JSON.stringify(prop.default)})`,
      ).toEqual(prop.default);
    }
  });

  // Zod enum values → JSON-Schema `enum[]`: divergence here means the
  // wizard renders one set of options but the server rejects a
  // different set on POST. Both must be the SAME closed set.
  it("Zod enum values match JSON-Schema enum[] arrays", () => {
    for (const [key, prop] of Object.entries(jsonSchema.properties)) {
      if (prop.enum === undefined) continue;
      const zodField = zodSchema.shape[key];
      if (zodField === undefined) continue;
      // Walk into ZodDefault / ZodOptional wrappers to find the
      // underlying ZodEnum.
      type AnyDef = { def?: { type?: string; innerType?: AnyDef; entries?: Record<string, string> } };
      let inner: AnyDef = zodField as AnyDef;
      while (inner.def?.innerType !== undefined) {
        inner = inner.def.innerType;
      }
      const entries = inner.def?.entries;
      if (entries === undefined) continue;
      const zodValues = Object.values(entries).sort();
      const jsonValues = [...prop.enum].sort();
      expect(
        zodValues,
        `Zod enum values for "${key}" (${JSON.stringify(zodValues)}) do not match JSON-Schema enum (${JSON.stringify(jsonValues)})`,
      ).toEqual(jsonValues);
    }
  });

  // Zod string `.min(N)` → JSON-Schema `minLength: N`. Same rationale
  // as defaults — UI may accept a short value the server rejects.
  it("Zod string minLength matches JSON-Schema minLength", () => {
    for (const [key, prop] of Object.entries(jsonSchema.properties)) {
      if (prop.minLength === undefined) continue;
      const zodField = zodSchema.shape[key];
      if (zodField === undefined) continue;
      // We parse a short string of length minLength-1 and assert it
      // FAILS — that's the strongest test of the constraint regardless
      // of the Zod internal shape. (Skip if minLength=0.)
      if (prop.minLength <= 0) continue;
      const tooShort = "x".repeat(prop.minLength - 1);
      const probe = (zodField as z.ZodTypeAny).safeParse(tooShort);
      expect(
        probe.success,
        `Zod field "${key}" accepted a value shorter than JSON-Schema minLength=${prop.minLength}`,
      ).toBe(false);
    }
  });
});
