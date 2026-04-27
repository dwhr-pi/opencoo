# opencoo

> Compiled-knowledge infrastructure for AI agents. Ingests documents and meeting transcripts into a per-domain Markdown wiki in Gitea; serves that wiki to agents via MCP. Pre-synthesized at ingestion, not retrieved at query time — no RAG, no vectors.

## Status

Pre-code v0.1. The architecture, PRD, threat model, and implementation plan are frozen; TypeScript implementation starts from `IMPLEMENTATION-PLAN.md §0`. The one already-shipping package is `packages/gitea-wiki-mcp-server/` — in design-partner production.

## Quickstart (local development)

> **`compose.yml` embeds default credentials (`POSTGRES_PASSWORD=opencoo`) and is for local development only.** Partner deployments require a separate compose file with `_FILE` Docker secrets and a hardened Postgres password — that hardened compose ships in a phase-c PR. Do not use this file as-is on any host reachable from the public internet.

```sh
# 1. clone + start backing services
git clone https://github.com/czlonkowski/opencoo && cd opencoo
docker compose up -d
docker compose ps                   # expect 3 services healthy

# 2. install + build (workspace turbo pipeline)
pnpm install
pnpm build                          # bundles UI into engine-self-operating/dist/ui

# 3. one-time Gitea bootstrap (manual, ~2 min)
open http://localhost:3000          # register user 'admin', any password
#   - create org 'opencoo'
#   - create team 'opencoo-admins' (in that org), add 'admin' as member
#   - settings → applications → generate access token
#       scopes: read:user, read:organization
export OPENCOO_ADMIN_PAT=<paste>

# 4. seed env + apply schema
export DATABASE_URL=postgres://opencoo:opencoo@localhost:5432/opencoo
export REDIS_URL=redis://localhost:6379
export GITEA_URL=http://localhost:3000
export GITEA_BASE_URL=http://localhost:3000
export ADMIN_TEAM_SLUG=opencoo-admins
pnpm opencoo setup --yes            # writes .env mode 0600 (ENCRYPTION_KEY + SESSION_HMAC_KEY generated)
pnpm opencoo migrate                # apply Drizzle schema

# 5. health check
pnpm opencoo doctor                                           # secrets redacted, db ok
pnpm opencoo doctor --admin-pat $OPENCOO_ADMIN_PAT            # gitea_team: ok

# 6. boot the engine (long-running)
pnpm opencoo                        # 'opencoo: listening on :8080'
# in another terminal:
curl -s http://localhost:8080/health   # {"status":"ok"}
curl -s http://localhost:8080/ready    # {"status":"ready","probes":{"postgres":{"ok":true},"redis":{"ok":true}}}
open http://localhost:8080             # Management UI login form

# 7. graceful shutdown — Ctrl-C in the boot terminal: clean exit 0
```

Bare `opencoo` (no subcommand) is the long-running boot verb per `architecture.md` §14.5. v0.1 boots the self-operating engine (Management UI + admin API + agents); engine-ingestion's BullMQ workers wire in phase-b.

The other CLI verbs (`migrate` / `setup` / `doctor` / `source test` / `source forget` / `recompile`) are documented under `pnpm opencoo --help`.

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
