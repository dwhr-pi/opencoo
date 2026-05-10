# syntax=docker/dockerfile:1.7
#
# opencoo engine — three-stage container build (PR-X2, phase-a follow-up).
#
# Stage layout:
#   1. base    — node:22-slim with corepack + pnpm enabled (shared base
#                across deps/build/runtime; keeps the apt-get layer in
#                ONE cache line)
#   2. build   — full source copy + pnpm install + turbo build + pnpm
#                deploy bundle for @opencoo/cli
#   3. runtime — node:22-slim + non-root user (UID 10001) + just the
#                deploy bundle, the Drizzle migration SQLs, and the
#                bundled Management UI dist
#
# What runs at `CMD`: the `opencoo` CLI's bare-no-subcommand boot verb
# (packages/cli/src/commands/serve.ts), which dynamic-imports BOTH
# engines (engine-self-operating + engine-ingestion) into one process.
# Schema migrations apply automatically before the listener binds (PR-X1
# via `applyMigrationsWithLock`); migration SQLs are resolved relative
# to the compiled @opencoo/shared dist and so MUST be present at
# `node_modules/@opencoo/shared/drizzle/` in the runtime image.
#
# Targets: linux/amd64 only for now. The `# syntax` directive + the
# `setup-buildx-action` in `.github/workflows/release-image.yml` keep
# `linux/arm64` a one-line addition when v0.2 needs it.
#
# Image budget: < 500 MB. node:22-slim is ~80 MB; the deploy bundle
# pulls the workspace closure of @opencoo/cli (engines + adapters +
# shared); the UI dist is a few MB; Drizzle SQLs are <100 KB.
#
# Cache strategy notes:
#   - We do NOT split `deps` into its own stage with a partial copy of
#     workspace package.jsons. The "naive" pattern `COPY packages/*/
#     package.json ./packages/` does not preserve subdirectory layout,
#     and the safer tar/find-based skeleton extraction (see e.g.
#     pnpm-deploy + container-skeleton recipes) adds significant
#     complexity for marginal cache benefit when GHA `cache-from/-to`
#     handles the layer caching at the BuildKit layer instead.
#   - Inside the build stage, `--mount=type=cache,target=...` for the
#     pnpm content-addressable store keeps `pnpm install` fast across
#     successive builds even when the install layer cache misses.
#   - Documented deviation from the skill skeleton (PR-X2 spec): we
#     collapse stages 1+2 into one `build` stage. This raises the build
#     stage's apparent layer count by 0 (the install + build commands
#     would have been in the build stage anyway) and removes the
#     workspace-skeleton-copy fragility entirely.

ARG NODE_IMAGE=node:22-slim

# ---------- Stage 1: build (install + tsc/vite + deploy bundle) ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Corepack pins pnpm to the version declared in root package.json's
# `packageManager` field (currently 9.15.4). No global npm install needed.
RUN corepack enable

# Single source copy. The .dockerignore at the repo root strips tests,
# dist outputs, .git, docs/local, partner-private artifacts, etc. before
# this COPY runs, so the layer is tight.
COPY . .

# Install with cache mount on pnpm's content-addressable store. The
# mount survives across builds on a single buildx host but is not baked
# into the image. `--frozen-lockfile` matches CI; a lockfile drift fails
# the build immediately.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Build the eslint plugin first (the lint task depends on it) then the
# full workspace via turbo. The UI build emits to packages/engine-self-
# operating/dist/ui/ per packages/ui/vite.config.ts.
RUN pnpm --filter @opencoo/eslint-plugin build
RUN pnpm build

# Generate a self-contained, production-only bundle for @opencoo/cli.
# `pnpm deploy --prod` resolves the entire transitive workspace closure
# (engines + adapters + shared + their runtime deps) into /tmp/deploy/
# with hard-linked node_modules. The CLI's package.json declares every
# adapter as a workspace:* dep so dynamic imports at runtime resolve
# without "module not found" surprises.
#
# IMPORTANT: this depends on every transitive workspace package having
# its `dist/**` built before `pnpm deploy` runs. The `pnpm build` line
# above satisfies this for any package whose package.json `files` field
# includes `dist/**`. If a future PR introduces a workspace package the
# CLI dynamic-imports but does NOT list in its dependencies, this
# fails-closed (deploy omits it; runtime ImportError trips on first
# resolve) — fix by adding the dep to packages/cli/package.json.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm --filter @opencoo/cli deploy --prod /tmp/deploy

# ---------- Stage 2: runtime (minimal, non-root, healthchecked) ----------
# Why a separate stage: the runtime image only needs the deploy bundle
# (production node_modules + compiled CLI dist + transitive workspace
# packages), the Drizzle migration SQLs, and the bundled UI dist. No
# source trees, no devDependencies, no pnpm CLI, no tsc.
FROM ${NODE_IMAGE} AS runtime

# wget for the HEALTHCHECK probe (node:22-slim does not include curl or
# wget by default). dumb-init reaps zombie children — useful because the
# CLI dispatches BullMQ workers that fork.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
           wget \
           dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Non-root user with a fixed UID for predictable bind-mount perms across
# host/container boundaries. Matches THREAT-MODEL §3.8 ("don't run as
# root").
ARG OPENCOO_UID=10001
ARG OPENCOO_GID=10001
RUN groupadd --system --gid ${OPENCOO_GID} opencoo \
    && useradd --system \
        --uid ${OPENCOO_UID} \
        --gid opencoo \
        --shell /usr/sbin/nologin \
        --create-home \
        opencoo

WORKDIR /app

# 1. The pnpm-deploy bundle — production node_modules + compiled CLI
#    dist + every workspace package's dist that the CLI transitively
#    pulls.
COPY --from=build --chown=opencoo:opencoo /tmp/deploy ./

# 2. Drizzle migration SQLs. `applyMigrationsWithLock` resolves them
#    relative to the compiled @opencoo/shared dist via
#    `resolveSharedMigrationsDir` (packages/shared/src/db/auto-migrate.ts:98),
#    which walks `<this-file-dir> → ../../drizzle`. The deploy bundle
#    lays the shared package out as
#    `node_modules/@opencoo/shared/dist/db/auto-migrate.js`, so the
#    migrations folder must land at
#    `node_modules/@opencoo/shared/drizzle/`. The shared package.json's
#    `files` field whitelists `drizzle/**`, so pnpm-deploy already
#    includes them; this COPY is belt-and-braces to guard against a
#    future regression.
COPY --from=build --chown=opencoo:opencoo \
    /app/packages/shared/drizzle \
    ./node_modules/@opencoo/shared/drizzle

# 3. The bundled Management UI dist (Vite build output). Per packages/
#    ui/vite.config.ts, vite emits to packages/engine-self-operating/
#    dist/ui/. The static-ui middleware reads from `UI_DIST_PATH`; we
#    set it explicitly below so resolution is path-independent.
COPY --from=build --chown=opencoo:opencoo \
    /app/packages/engine-self-operating/dist/ui \
    ./packages/engine-self-operating/dist/ui

ENV NODE_ENV=production \
    PORT=8080 \
    UI_DIST_PATH=/app/packages/engine-self-operating/dist/ui

# Install an `opencoo` shim on PATH so `docker run <image> opencoo
# <verb>` (and `docker compose run --rm opencoo opencoo <verb>` from
# the runbook + compose template) work as documented. The bare CMD
# below still boots the engine; the shim is purely for invoking
# subcommands (doctor / migrate / source test / etc.). Owned by root,
# world-readable + executable so the non-root `opencoo` user can run
# it. Installed BEFORE `USER opencoo` so the chmod takes.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'exec node /app/dist/bin.js "$@"' \
    > /usr/local/bin/opencoo \
    && chmod 0755 /usr/local/bin/opencoo

USER opencoo

EXPOSE 8080

# Healthcheck against the shared engine-scaffold `/health` endpoint
# (see packages/shared/src/engine-scaffold/server.ts:51 — always-200,
# no probes; `/ready` is the deeper Postgres+Redis+Gitea probe used by
# orchestrator readiness gates, not Docker's healthcheck). `--start-
# period` is generous (15s) because the auto-migrate step (PR-X1) can
# take several seconds on the first boot against a fresh Postgres.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# dumb-init reaps zombie subprocesses spawned by BullMQ workers; without
# it, a worker that exits abnormally can leave defunct entries in the
# process table.
#
# CMD invokes the CLI's bin entry directly. The pnpm-deploy bundle lays
# the @opencoo/cli package out at WORKDIR root (its package.json + dist
# go straight under /app/), with workspace deps hosted under
# node_modules/@opencoo/. So the CLI's bin is at /app/dist/bin.js, NOT
# /app/node_modules/@opencoo/cli/dist/bin.js.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/bin.js"]
