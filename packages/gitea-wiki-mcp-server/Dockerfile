# syntax=docker/dockerfile:1.6

# ---- build stage: compile TS, install all deps ----
FROM node:20-alpine AS build
WORKDIR /app

# Install native deps needed by @vscode/ripgrep binary (unpacks ripgrep at postinstall).
RUN apk add --no-cache git

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production deps only (keeps ripgrep binary via @vscode/ripgrep).
RUN npm prune --omit=dev

# ---- runtime stage: minimal Alpine + compiled JS ----
FROM node:20-alpine
WORKDIR /app

# Git required for clone/pull at runtime.
RUN apk add --no-cache git tini \
  && addgroup -S app \
  && adduser -S -G app app

# Copy production node_modules + built output.
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json LICENSE README.md ./

# Data dir (repo clones + indexes) is expected to be a volume.
RUN mkdir -p /data && chown -R app:app /data
ENV DATA_DIR=/data
ENV MCP_MODE=http
ENV HOST=0.0.0.0
ENV PORT=3000

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/health || exit 1

# tini reaps zombie child processes from git subprocess invocations.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
