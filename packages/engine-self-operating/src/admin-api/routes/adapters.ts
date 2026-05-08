/**
 * `GET /api/admin/adapters` — adapter descriptor list (phase-a
 * appendix #2; PR-Q9 adds `bindingConfigSchema`).
 *
 * The Management UI's "+ New binding" modal picker calls this
 * to populate the adapter dropdown. Returning the same
 * descriptors the binding-create route uses for validation
 * keeps server + UI in lockstep — adding a fifth adapter is
 * one registry edit, no UI patch.
 *
 * Response shape:
 *   {
 *     adapters: [
 *       {
 *         slug: 'drive' | 'asana' | 'n8n' | 'fireflies' | …,
 *         mode: 'polling' | 'webhook',
 *         credentialSchema: { type: 'object', properties: {...} },
 *         bindingConfigSchema: { type: 'object', properties: {...},
 *                                required: [...] },
 *       },
 *       ...
 *     ]
 *   }
 *
 * `bindingConfigSchema` powers the third wizard step ("operational
 * settings"): without it, the modal posted an empty `config: {}`
 * and Asana bindings 500'd at `factory_threw` on the first
 * webhook delivery (the adapter's Zod schema requires `projectGid`).
 * Surfacing the schema here lets the form prompt for it up-front
 * and the route validate it BEFORE the INSERT.
 *
 * Read-only — no audit-log row written; the admin-API plugin's
 * `verifyAdmin` preHandler enforces the auth gate.
 */
import type { FastifyInstance } from "fastify";

import {
  SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS,
  SOURCE_ADAPTER_CREDENTIAL_SCHEMAS,
  type BindingConfigSchema,
  type SourceAdapterCredentialDescriptor,
  type SourceAdapterSlug,
} from "@opencoo/shared/source-adapter";

export interface AdapterListEntry {
  readonly slug: SourceAdapterSlug;
  readonly mode: SourceAdapterCredentialDescriptor["mode"];
  readonly credentialSchema: SourceAdapterCredentialDescriptor["credentialSchema"];
  readonly bindingConfigSchema: BindingConfigSchema;
}

export interface RegisterAdaptersRouteArgs {
  readonly app: FastifyInstance;
  /** @internal Test seam — defaults to the production registry. */
  readonly registry?: Readonly<
    Record<SourceAdapterSlug, SourceAdapterCredentialDescriptor>
  >;
  /** @internal Test seam — defaults to the production binding-config registry. */
  readonly bindingConfigRegistry?: Readonly<
    Record<SourceAdapterSlug, BindingConfigSchema>
  >;
}

export function registerAdaptersRoute(args: RegisterAdaptersRouteArgs): void {
  const registry = args.registry ?? SOURCE_ADAPTER_CREDENTIAL_SCHEMAS;
  const bindingConfigRegistry =
    args.bindingConfigRegistry ?? SOURCE_ADAPTER_BINDING_CONFIG_SCHEMAS;
  args.app.get("/api/admin/adapters", async () => {
    const adapters: AdapterListEntry[] = (Object.keys(registry) as SourceAdapterSlug[])
      .sort()
      .map((slug) => ({
        slug,
        mode: registry[slug].mode,
        credentialSchema: registry[slug].credentialSchema,
        bindingConfigSchema: bindingConfigRegistry[slug],
      }));
    return { adapters };
  });
}
