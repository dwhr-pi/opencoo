# syntax=docker/dockerfile:1.7
#
# gitea-wiki-mcp-server — three-stage container build.
#
# PR-X2 skill-guided pass over the original two-stage Dockerfile:
#   - upgraded `# syntax` from 1.6 → 1.7 (matches engine Dockerfile)
#   - bumped base from node:20-alpine → node:22-alpine (matches engine
#     Dockerfile + the engine workspace's `engines.node: ">=22"`; the
#     MCP server's own `engines.node: ">=18"` accepts 22)
#   - split `deps` from `build` so a source change does not bust the
#     `npm ci` cache layer
#   - added `--mount=type=cache` for the npm cache directory
#   - bumped non-root UID from default `adduser -S` (random) to a
#     fixed UID 10002 (engine uses 10001; pick distinct UIDs so
#     bind-mount perms don't collide when both containers stack on
#     a shared volume layout)
#   - HEALTHCHECK keeps the same parameter set (interval/timeout/
#     start-period/retries) the original already had — present for
#     reference; nothing to change
#   - COPY --chown remains on every runtime copy

# ---- Stage 1: deps (cached separately from source changes) ----
FROM node:22-alpine AS deps
WORKDIR /app

# Install native deps needed by @vscode/ripgrep binary (unpacks
# ripgrep at postinstall).
RUN apk add --no-cache git

COPY package.json ./

# Cache mount keeps successive builds fast across layer-cache misses.
#
# Lockfile strategy: the package-lock.json was removed when the package
# was integrated into the opencoo pnpm workspace at the repo root
# (commit `c436d56`). Pure `npm install` would be non-deterministic
# across builds — a 6-month-old tagged image rebuilt today could pick
# up yanked or upgraded transitive deps, breaking supply-chain trust
# for partner deployments. So we materialise a lockfile here from the
# current package.json's caret/tilde ranges, then `npm ci` against it.
# This makes the install stage internally consistent within a single
# build (npm ci enforces the just-generated lockfile). Cross-build
# reproducibility for a given tag is still imperfect — that's a v0.2
# follow-up (either commit a per-package lockfile or shift the build
# context to repo root + use pnpm-from-root). PR-X2 reviewer (#1) flag.
RUN --mount=type=cache,target=/root/.npm \
    npm install --package-lock-only --no-audit --no-fund \
    && npm ci --no-audit --no-fund

# ---- Stage 2: build (compile TS, prune dev deps) ----
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache git

COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
COPY package.json ./

# tsc compile. Output lands in /app/dist per tsconfig.json `outDir`.
RUN npm run build

# Prune to production deps only (keeps the @vscode/ripgrep binary
# unpacked under node_modules/@vscode/ripgrep/bin/).
RUN npm prune --omit=dev

# ---- Stage 3: runtime (minimal Alpine + compiled JS, non-root) ----
FROM node:22-alpine AS runtime
WORKDIR /app

# Runtime deps:
#   - git: simple-git spawns it for clone/pull at runtime
#   - tini: PID-1 zombie reaper for git subprocesses
#   - wget: explicit dep for HEALTHCHECK probe; node:22-alpine ships
#     busybox wget but installing the standalone util keeps the probe
#     working if the base image ever drops busybox utilities.
RUN apk add --no-cache git tini wget

# Non-root user with a fixed UID. UID 10002 is one above the engine
# image's UID 10001 — keeps bind-mount perms predictable when the
# operator stacks both containers against the same volume layout.
ARG MCP_UID=10002
ARG MCP_GID=10002
RUN addgroup -S -g ${MCP_GID} mcpserver \
    && adduser -S -G mcpserver -u ${MCP_UID} -s /sbin/nologin mcpserver

# Production node_modules + compiled JS + manifest + license.
COPY --from=build --chown=mcpserver:mcpserver /app/node_modules ./node_modules
COPY --from=build --chown=mcpserver:mcpserver /app/dist ./dist
COPY --chown=mcpserver:mcpserver package.json LICENSE README.md ./

# Data dir (repo clones + indexes) is expected to be a volume mount
# from the host. The fixed UID + chown ensure the volume's perms are
# stable across container restarts.
RUN mkdir -p /data && chown -R mcpserver:mcpserver /data

ENV DATA_DIR=/data \
    MCP_MODE=http \
    HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

USER mcpserver
EXPOSE 3000

# No `gitea-wiki-mcp-server` shim on PATH (cf. engine image's
# /usr/local/bin/opencoo wrapper). This server is a long-running HTTP
# daemon with no admin CLI subcommands — `src/index.ts` boots the
# server unconditionally and ignores process.argv. If a future PR adds
# operator subcommands (status / reindex / etc.), mirror the engine's
# wrapper pattern here.

# Full healthcheck parameter set (interval / timeout / start-period /
# retries). `--start-period` accommodates the initial git clone +
# index build the server performs on first boot — without it, a slow
# clone trips the unhealthy threshold before /health is reachable.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# tini reaps zombie child processes from git subprocess invocations.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
