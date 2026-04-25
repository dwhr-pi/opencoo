# @opencoo/source-n8n

`SourceAdapter` for n8n. Polls the n8n REST API for tagged workflows
and emits each as a `content_kind: 'n8n-workflow'` document. The
engine-ingestion compilation-worker dispatches these to the
deterministic `compileCatalogWorkflow` template — no LLM, no
classifier — and embeds the workflow JSON inside a single
` ```n8n-workflow ` fenced block. Lossless round-trip is the
load-bearing assertion: `originalJson → SourceEvent → Compiler →
fenced-block body → re-parsed JSON` deep-equals the original
(modulo top-level `updatedAt`).

## Status

- v0.1 (PR 26 / plan #122). Use-case-tier tests only — no Docker, no
  network, no real n8n. Production wiring (fetch-based REST client)
  lands in PR 30.
- 3 representative fixture workflows ship with the package
  (`tests/fixtures/{simple-linear, branched-with-if, loop-with-splitinbatches}.json`)
  for the round-trip assertion.

## Public surface

```ts
import {
  N8N_ADAPTER_SLUG,
  N8N_DEFAULT_TAG_FILTER,
  createN8nSourceAdapter,
  n8nBindingConfigSchema,
} from "@opencoo/source-n8n";
```

- `createN8nSourceAdapter({credentialStore, credentialId, config,
   makeApi})` — adapter factory. The token is resolved from the
  `CredentialStore` on **every** scan (rotation pin —
  THREAT-MODEL §3.6 invariant 11).
- `n8nBindingConfigSchema` — Zod schema for the binding's
  `config` JSONB. Required: `baseUrl`. Optional with defaults:
  `tagFilter` (`['catalog']`), `contentKind` (`'n8n-workflow'`).
  `.strict()` rejects unknown fields.

## Binding-config

```jsonc
{
  "baseUrl": "https://n8n.example.com",
  "tagFilter": ["catalog"],
  "contentKind": "n8n-workflow"
}
```

The shared content-kind enum lives at `@opencoo/shared/db`. n8n
bindings are 1:1 with their home domain (catalog scope).

## sourceRevision

The adapter computes `sourceRevision` as
`sha256(canonicalBytes(workflow_minus_updatedAt)).slice(0, 16)`,
where `canonicalBytes` JSON-serialises with sorted keys and no
whitespace. The hash is **stable across replay**: a no-op edit
that touches only `updatedAt` produces the SAME revision; a real
change produces a different one. NOT updatedAt-derived.

## contentBytes

The adapter emits `contentBytes` as `JSON.stringify(workflow_minus_updatedAt, null, 2)` —
pretty-printed JSON makes the catalog page's git diff readable to
humans. The compiler embeds these bytes verbatim inside the
fenced ` ```n8n-workflow ` block.

`updatedAt` is stripped in BOTH layers (decision 3): the adapter
strips at fetch time so both the emitted `contentBytes` and the
canonical revision input omit that field, and the compiler also
strips defense-in-depth so a non-n8n upstream cannot smuggle the
field through. Note that the **revision** is computed from a
SEPARATE canonical byte stream (sorted-keys, no whitespace) so
`sourceRevision` is stable regardless of pretty-print whitespace
in `contentBytes`.

## 1 MiB ceiling

Inherited from the shared `SourceAdapter` contract (assertion 7).
Workflows whose serialised body exceeds 1 MiB are dropped — the
Scanner pipeline's BullMQ payload would overflow otherwise. The
drop is silent at the adapter layer; operators see it indirectly
via the cursor advancing without a corresponding intake row, and
the contract test pins the behavior. Adding adapter-level logging
is a v0.2 hardening (matches the source-drive precedent).

## Tag-filter defense-in-depth

The adapter forwards `tagFilter` to n8n's `?tag=` query AND
re-checks tag membership in code. The API may return a workflow
whose tags were edited mid-scan to no longer match — the post-
filter catches that case.

## Tests

```sh
pnpm --filter @opencoo/source-n8n test            # 31 tests
pnpm --filter @opencoo/source-n8n test:contract   # shared contract suite
```

Use-case tier only. Mock listing API at
`src/testing/mock-n8n-listing.ts` honors `since`-cursor + tag
filtering so the shared contract suite passes without real n8n.

## Catalog-workflow compile path

This adapter's emitted documents flow into
`packages/engine-ingestion/src/compiler/catalog-workflow.ts` —
deterministic template, single atomic wikiWrite to
`catalog/workflows/<slug>-<id>.md`, ONE `page_citations` row with
`prompt_version: 'catalog-workflow:1.0'`. See that module for the
fenced-block format and the strict round-trip parser.
