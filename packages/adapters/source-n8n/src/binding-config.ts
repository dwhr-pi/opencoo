/**
 * Binding-config schema for the n8n SourceAdapter
 * (PR 26 / plan #122).
 *
 * The adapter polls n8n's REST API for tagged workflows and emits
 * each as a `content_kind: 'n8n-workflow'` document. The
 * Compilation Worker dispatches catalog-content to the
 * deterministic `compileCatalogWorkflow` template — no LLM, no
 * classifier (architecture §6.3.1, plan #122 decision 5).
 *
 * The `tagFilter` is the binding's whitelist; the adapter passes
 * it to the listing API AND filters results in code as
 * defense-in-depth (the API may return a workflow that no
 * longer carries the tag if its tags were edited mid-scan).
 *
 * `contentKind` is locked to `'n8n-workflow'` for v0.1 — n8n
 * bindings exist exclusively for the catalog path. The shared
 * enum in `@opencoo/shared/db` is the single source of truth.
 */
import { z } from "zod";

import { CONTENT_KINDS } from "@opencoo/shared/db";

/** Default tag filter — matches the design-partner PoC's
 *  `?tag=catalog` listing query. Operators extending the catalog
 *  to additional tag-classes add them here. */
export const N8N_DEFAULT_TAG_FILTER: readonly string[] = ["catalog"] as const;

export const n8nBindingConfigSchema = z
  .object({
    /** Base URL of the n8n instance — `https://n8n.example.com`. */
    baseUrl: z.string().min(1),
    /** Tag whitelist. The adapter queries the API with these tags
     *  AND post-filters results (defense-in-depth). At least one
     *  tag is required. */
    tagFilter: z.array(z.string().min(1)).min(1).default([
      ...N8N_DEFAULT_TAG_FILTER,
    ]),
    /**
     * Locked to `'n8n-workflow'` for v0.1. The shared enum
     * `@opencoo/shared/db` is the source of truth for the
     * literal; we accept any value from the enum at parse time
     * for forward-compatibility with phase-b's `'skill-bundle'`
     * (which would land in a separate adapter, not this one).
     */
    contentKind: z.enum(CONTENT_KINDS).default("n8n-workflow"),
  })
  .strict();

export type N8nBindingConfig = z.infer<typeof n8nBindingConfigSchema>;
