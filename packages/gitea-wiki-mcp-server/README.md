# gitea-wiki-mcp-server

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-blue.svg)](https://modelcontextprotocol.io/)

MCP server that exposes a Gitea-backed markdown wiki as tools for AI agents. Six read-only tools that give an LLM the same "grep + list + open" workflow a human uses, without embeddings or vector databases.

Works with **Claude Code**, **n8n** (`@n8n/n8n-nodes-langchain.mcpClientTool`), **Cursor**, **Claude Desktop**, or anything that speaks MCP over stdio or streamable HTTP.

## Why

Most "wiki RAG" stacks ship embeddings + a vector DB + an index-maintenance headache. At 30–200 pages, a ripgrep sidecar + a small frontmatter index beats vector search on latency, precision, and operational cost. Inspired by [gbrain](https://github.com/garrytan/gbrain), [Karpathy's LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), and Anthropic's agentic-search approach in Claude Code.

## Tools

| Tool | Purpose |
| --- | --- |
| `wiki_toc` | Directory tree with per-page title / type / tags / updated — rich TOC. |
| `wiki_read` | Fetch one page; returns parsed frontmatter + body + sha + modified-at. |
| `wiki_search` | Ripgrep full-text search with optional `path_glob`. |
| `wiki_frontmatter_index` | Filter pages by `tag` / `type` / `updated_since` / `path_prefix`. |
| `wiki_backlinks` | Pages that link TO a given path (supports `[[wikilinks]]` + markdown). |
| `wiki_recent_changes` | Recent commits touching the wiki, optionally filtered by date + path. |

All tools are read-only, support `response_format: "markdown"` (default) or `"json"`, and paginate via `limit` / `offset` where applicable.

## Architecture

```
Gitea repo  ──(git clone + scheduled pull)──▶  /data/repos/<slug>/
                                                      │
                                               (on each pull)
                                                      ▼
                                               /data/index/<slug>.json
                                                      │
                                                      ▼
  AI client ──(MCP over stdio OR HTTP)──▶  Tools that walk /data
```

- **Stateless** streamable HTTP transport (one transport per request).
- **Multi-repo aware** — server config lists repos; each tool accepts an optional `repo` slug.
- **Bearer auth** on `/mcp`; timing-safe compare.
- **HMAC-verified** Gitea webhook at `/refresh/:slug` for instant index rebuild on push.

## Installation

```bash
npm install
npm run build
cp .env.example .env
# edit .env — required: MCP_BEARER_TOKEN, GITEA_PAT, REPOS
```

## Run locally

### stdio (for Claude Code, Claude Desktop)

```bash
MCP_BEARER_TOKEN=$(openssl rand -hex 32) \
GITEA_PAT=your_gitea_pat \
REPOS='[{"slug":"my-wiki","owner":"me","name":"my-wiki","default":true}]' \
node dist/index.js
```

Or simply `npm start` with a fully populated `.env`.

### streamable HTTP (for n8n, remote use)

```bash
MCP_MODE=http npm start
# → http://localhost:3000/mcp  (bearer required)
# → http://localhost:3000/health  (no auth)
# → http://localhost:3000/refresh/<slug>  (HMAC-verified webhook)
```

## Client setup

### Claude Code

```bash
# local stdio
claude mcp add wiki --command node --args /path/to/dist/index.js \
  --env MCP_BEARER_TOKEN=… --env GITEA_PAT=… --env REPOS='[…]'

# remote HTTP
claude mcp add wiki-remote --transport http \
  --url https://mcp-wiki.your-domain.com/mcp \
  --header "Authorization: Bearer $BEARER"
```

### n8n (via the official MCP Client Tool, v1.2+)

1. Credentials → "Add Credential" → "Bearer Auth" (`httpBearerAuth`) with the same token the server sees.
2. In your AI-Agent workflow, add `@n8n/n8n-nodes-langchain.mcpClientTool`:
   - Endpoint: `http://gitea-wiki-mcp:3000/mcp` (if co-located in the same Docker network) or the public HTTPS URL
   - Server Transport: **HTTP Streamable**
   - Authentication: **Bearer Auth**
   - Credentials: the bearer credential from step 1
   - Tools to Include: `All` (or `Selected` + pick specific tools)
3. Connect the MCP node's `ai_tool` output into the AI Agent's `ai_tool` input.

No `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE` env flag needed — the MCP Client Tool is built in.

## Configuration

All via environment variables. See `.env.example` for the full list with descriptions. Highlights:

| Var | Purpose |
| --- | --- |
| `MCP_MODE` | `stdio` (default) or `http` |
| `MCP_BEARER_TOKEN` | Required. Bearer for `/mcp`. Generate: `openssl rand -hex 32`. |
| `GITEA_PAT` | Required. Gitea token with `read:repository`. |
| `GITEA_BASE_URL` | Your Gitea's URL (required). Example: `https://gitea.example.com`. |
| `REPOS` | JSON array of repos. **Exactly one** must have `default: true`. |
| `DATA_DIR` | Where clones + indexes live. Default `./data`. |
| `SYNC_INTERVAL_MIN` | Periodic pull interval in minutes. `0` disables. Default `5`. |
| `GITEA_WEBHOOK_SECRET` | If set, enables `/refresh/<slug>` with HMAC verification. |

## Multi-repo

`REPOS` is a JSON array — add as many as you want:

```jsonc
[
  {"slug":"public-wiki","owner":"org","name":"public-wiki","default":true,"access_tag":"public"},
  {"slug":"exec-wiki","owner":"org","name":"exec-wiki","default":false,"access_tag":"exec"}
]
```

Each tool accepts an optional `repo: "slug"` parameter; omit it to target the default repo.

**Planned (not built yet)**: per-token repo scoping via a `TOKENS` env map. Today a single bearer gates all repos.

## Development

```bash
npm run dev           # tsx watch, stdio
npm run dev:http      # tsx watch, HTTP on :3000
npm test              # vitest — unit tests
npm run build         # compile TS to dist/
node scripts/smoke-stdio.mjs    # end-to-end MCP handshake + tool calls
node scripts/smoke-http.mjs     # HTTP + bearer + HMAC webhook
npm run inspector     # open the official MCP Inspector against the server
```

Tests use a small fixture wiki at `tests/fixtures/sample-wiki/` — a generic engineering wiki with strategy + project + index pages plus one page without frontmatter to exercise fallbacks.

## Deployment

See [`deploy/MANUAL_DEPLOY.md`](./deploy/MANUAL_DEPLOY.md) for the exact Hetzner / Docker Compose / Caddy steps.

TL;DR:

```bash
docker build -t gitea-wiki-mcp-server:0.1.0 .
# run with env file + /data volume + behind a reverse proxy on TLS
```

## Public OAuth 2.1 access (ChatGPT Team, Claude.ai, …)

For purely internal deploys, the static `MCP_BEARER_TOKEN` is all you need. For external clients that *only* accept OAuth 2.1 — ChatGPT Team custom connectors and Claude.ai remote MCP both do — flip on the OAuth path using Gitea as the Identity Provider:

1. **Create an OAuth2 app in Gitea** (Settings → Applications → OAuth2 Applications). Redirect URIs must include every one your client publishes, e.g. for ChatGPT:
   - `https://chatgpt.com/connector_platform_oauth_redirect`
   - `https://chat.openai.com/connector_platform_oauth_redirect`

   Confidential client: yes. Copy `client_id` + `client_secret`.

2. **Set these env vars** (all three together, or none):

   ```bash
   PUBLIC_URL=https://mcp-wiki.example.com
   GITEA_OAUTH_CLIENT_ID=<from step 1>
   GITEA_OAUTH_CLIENT_SECRET=<from step 1>
   CORS_ORIGINS=https://chatgpt.com,https://chat.openai.com
   # optional — lets /oauth/register auto-append new redirect URIs to the app
   GITEA_ADMIN_TOKEN=<gitea PAT with admin:oauth2>
   ```

3. **Reverse-proxy it on TLS** — Caddy snippet:

   ```caddyfile
   mcp-wiki.example.com {
     reverse_proxy gitea-wiki-mcp:3000
   }
   ```

4. **Add the connector** in the client. ChatGPT Team → Settings → Connectors → Create custom connector → MCP URL = `https://mcp-wiki.example.com/mcp`, Authentication = OAuth. Each user hits Gitea login on first use; a valid Gitea session grants access.

What the server does when OAuth is on:

- `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` return RFC 9728 / 8414 discovery documents pointing clients at Gitea for authorize + token, and back at us for registration.
- `POST /oauth/register` is a thin Dynamic Client Registration (RFC 7591) proxy — Gitea has no native DCR, so we echo back the shared app's `client_id`/`client_secret` to every caller.
- `/mcp` accepts **both** the static `MCP_BEARER_TOKEN` (n8n, Claude Code) **and** any Gitea-issued access token (ChatGPT, …), validated via `userinfo` and LRU-cached for 5 minutes.
- On 401 we emit `WWW-Authenticate: Bearer resource_metadata=…` so OAuth-aware clients auto-discover the flow.

Rollback = unset `PUBLIC_URL`. Internal static-bearer path is completely unchanged.

## Security

- Bearer middleware accepts static `MCP_BEARER_TOKEN` (timing-safe compare) and/or Gitea OAuth tokens (userinfo-validated, cached).
- Gitea webhook on `/refresh/:slug` requires HMAC-SHA256 via `X-Gitea-Signature`.
- Path-traversal protection in `wiki_read` — absolute paths and `..` are rejected.
- Ripgrep `path_glob` is allow-list-validated; queries are passed as argv, never shell.
- Rate limit: 60 requests/min per IP on `/mcp` (trust proxy = 1 hop for real client IPs behind Caddy).
- CORS origin allow-list via `CORS_ORIGINS`; `WWW-Authenticate` / `Mcp-Session-Id` / `Mcp-Protocol-Version` kept in `exposedHeaders`.

## Known limits

- No write tools (by design). Humans + workflows own writes.
- No embedding / vector search. [Research](https://github.com/garrytan/gbrain) says you don't need it below ~200 pages; when you do, consider `text-embedding-004` + pgvector alongside these tools.
- Gitea webhook needs its HMAC secret set on both sides to work.
- `wiki_recent_changes` requires a real cloned git repo (fails gracefully otherwise).

## License

Apache-2.0. See [LICENSE](./LICENSE). Earlier releases of this package were distributed under MIT; those copies remain MIT.

## Credits

Patterns borrowed from:
- [gbrain](https://github.com/garrytan/gbrain) by Garry Tan — hybrid search + compiled-truth schema
- [Karpathy's LLM wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — pure tool-use + index.md
- [Anthropic's Claude Code](https://www.anthropic.com/news/contextual-retrieval) — agentic search over RAG
