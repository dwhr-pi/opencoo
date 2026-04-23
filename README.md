# opencoo

> Compiled-knowledge infrastructure for AI agents. Ingests documents and meeting transcripts into a per-domain Markdown wiki in Gitea; serves that wiki to agents via MCP. Pre-synthesized at ingestion, not retrieved at query time — no RAG, no vectors.

## Status

Pre-code v0.1. The architecture, PRD, threat model, and implementation plan are frozen; TypeScript implementation starts from `IMPLEMENTATION-PLAN.md §0`. The one already-shipping package is `packages/gitea-wiki-mcp-server/` — in design-partner production.

## Getting oriented

Read in this order:

1. **`docs/ARCHITECTURE.md`** — shapes and load-bearing decisions.
2. **`PRD.md`** — v0.1 scope, users, success criteria, non-goals.
3. **`IMPLEMENTATION-PLAN.md`** — phased (a/b/c) delivery with test-first acceptance per PR.
4. **`CONVENTIONS.md`** — TDD / TypeScript / testing discipline, ESLint boundary rules, PR discipline.
5. **`THREAT-MODEL.md`** — security invariants, per-subsystem must-do / must-not-do, PR checklist.
6. **`docs/decisions-resolved.md`** — canonical list of architectural decisions with rationale.
7. **`DECISIONS.md`** — running list of open decisions (currently empty).
8. **`design_system/`** — visual design system skill; start at `design_system/README.md` before producing any UI artifact.
9. **`diagrams/`** — mermaid sources + rendered SVGs of the engine topology.

## Package layout

```
packages/
  shared/                 — DB schema, logger, errors, LLM router, cost tracker,
                            credential store, wiki-write, text-normalize,
                            prompts, adapter-contract-tests
  engine-ingestion/       — Fastify boot + eight BullMQ pipelines
  engine-self-operating/  — Fastify boot + agent harness + five first-party agents
                            + Review Dashboard + UI host
  ui/                     — React app, bundled as static files into self-op
  adapters/<kind>-<slug>/ — one package per adapter
  cli/                    — opencoo binary
  gitea-wiki-mcp-server/  — already shipping, Apache-2.0, separately npm-published
```

## License

Apache-2.0. See `LICENSE`.

## Contributing

Contribution guidance lands with the `0.1.0-a` tag. Until then the repo is under active pre-release work; open issues welcome for discussion, but PRs should wait for the first tagged release unless coordinated with a maintainer.
