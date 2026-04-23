# Manual Deployment Guide

How to run `gitea-wiki-mcp-server` alongside an existing n8n + Gitea Docker Compose stack. The primary path is **internal-only** — the MCP server joins the shared Docker network and isn't exposed on the public internet. n8n reaches it at `http://gitea-wiki-mcp:3000/mcp`. You (Claude Code on laptop) reach it via an SSH tunnel when needed. Public HTTPS via Caddy is an optional follow-up (§11).

This guide assumes:

- A host running `docker` + `docker compose`.
- An existing compose file with at least `n8n` and `gitea` services on a shared network.
- Gitea hosts a markdown-backed wiki repo you want to expose.
- SSH access to the host.

Replace placeholder names (e.g. `my-org/my-wiki`, `mcp-wiki.example.com`) with your own values throughout.

## 1. Build the image

**Option A — build locally, ship via `docker save`:**

```bash
# on your workstation
cd /path/to/gitea-wiki-mcp-server
docker build -t gitea-wiki-mcp-server:0.1.0 .
docker save gitea-wiki-mcp-server:0.1.0 | gzip | \
  ssh root@your-host 'gunzip | docker load'
```

**Option B — build on the server:**

```bash
ssh root@your-host
cd /root
git clone <this-repo-url> gitea-wiki-mcp-server
cd gitea-wiki-mcp-server
docker build -t gitea-wiki-mcp-server:0.1.0 .
```

## 2. Generate the two secrets

Anywhere:

```bash
# Bearer token — used by n8n (and optionally Claude Code) to authenticate to /mcp
openssl rand -hex 32

# Gitea webhook secret — used by Gitea → /refresh to trigger immediate re-index
openssl rand -hex 32
```

Save both. You'll need the bearer in n8n and the webhook secret in Gitea.

## 3. Create a Gitea Personal Access Token

1. Open your Gitea instance, log in as a user with read access to the wiki repo.
2. Settings → Applications → **Generate New Token**.
3. Name: `wiki-mcp-read`. Scopes: **`read:repository`** (only).
4. Copy the token — shown only once.

## 4. Write the server `.env` on the host

```bash
ssh root@your-host
mkdir -p /root/gitea-wiki-mcp
cat > /root/gitea-wiki-mcp/.env <<'EOF'
MCP_MODE=http
PORT=3000
HOST=0.0.0.0
MCP_BEARER_TOKEN=<paste bearer from step 2>
GITEA_PAT=<paste PAT from step 3>
GITEA_BASE_URL=https://gitea.example.com
REPOS=[{"slug":"my-wiki","owner":"my-org","name":"my-wiki","default":true,"access_tag":"public"}]
DATA_DIR=/data
SYNC_INTERVAL_MIN=5
GITEA_WEBHOOK_SECRET=<paste webhook secret from step 2>
LOG_LEVEL=info
EOF
chmod 600 /root/gitea-wiki-mcp/.env
```

Adjust `GITEA_BASE_URL`, `REPOS` slug/owner/name, and any other field for your stack.

## 5. Add the service to your existing compose file

Edit the compose file that hosts your n8n + Gitea (typical path: `/root/n8n-docker-caddy/docker-compose.yml` or similar). Append under `services:` using the **same network name** as n8n/Gitea — usually something like `n8n`:

```yaml
  gitea-wiki-mcp:
    image: gitea-wiki-mcp-server:0.1.0
    container_name: gitea-wiki-mcp
    restart: unless-stopped
    env_file:
      - /root/gitea-wiki-mcp/.env
    volumes:
      - gitea_wiki_mcp_data:/data
    networks:
      - n8n       # same network name n8n + gitea use
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

Append the volume alongside the other volume declarations:

```yaml
volumes:
  # ... existing volumes
  gitea_wiki_mcp_data:
```

**Do NOT publish any ports** and **do NOT add a Caddy block**. The whole point of this pattern is that the service is reachable only from inside the shared Docker network.

## 6. Launch

```bash
cd /path/to/your/compose/dir
docker compose up -d gitea-wiki-mcp
docker compose logs -f gitea-wiki-mcp
```

Expected log tail:

```
[git-sync] cloning my-wiki -> /data/repos/my-wiki
[git-sync] cloned my-wiki
[index-builder] built my-wiki (N pages)
[git-sync] periodic pulls every 5min
[http] listening on http://0.0.0.0:3000 (bind path /mcp, /refresh/:slug, /health)
```

## 7. Verify from inside the shared network

```bash
# On the host, attach to the n8n container and curl the mcp service by name:
docker compose exec n8n \
  wget -qO- http://gitea-wiki-mcp:3000/health
# → {"status":"ok","service":"gitea-wiki-mcp-server","version":"0.1.0","repos":["my-wiki"]}
```

If that returns 200, n8n can talk to the MCP server.

## 8. Configure n8n: Bearer credential + MCP Client Tool

1. Open n8n. **Credentials → Create Credential** → search for **"Bearer Auth"** (type `httpBearerAuth`).
2. Name: `wiki-mcp-bearer`. Token: paste the bearer from step 2. Save.
3. In the workflow where your AI Agent lives, add an **MCP Client Tool** node (`@n8n/n8n-nodes-langchain.mcpClientTool` v1.2).
4. Configure:
   - **Endpoint URL**: `http://gitea-wiki-mcp:3000/mcp`
   - **Server Transport**: `HTTP Streamable`
   - **Authentication**: `Bearer Auth`
   - **Credentials**: `wiki-mcp-bearer`
   - **Tools to Include**: `All` (or `Selected` + pick specific tool names)
5. Connect this node's `ai_tool` output into the AI Agent's `ai_tool` input.

No `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE` flag needed — the MCP Client Tool is built in.

## 9. End-to-end test

Trigger whatever workflow invokes your AI Agent. Watch the execution trace — it should now show calls to `wiki_toc` / `wiki_read` / `wiki_search` via the MCP Client Tool node.

## 10. (Optional) Gitea webhook for instant re-index

Skip this if the 5-minute periodic pull is fast enough.

1. Gitea repo → Settings → Webhooks → **Add Webhook** → **Gitea**.
2. Target URL: `http://gitea-wiki-mcp:3000/refresh/<slug>` (Gitea is on the same Docker network, so internal service DNS works).
3. Content type: `application/json`.
4. Secret: the webhook secret from step 2.
5. Trigger: **Push events** only.
6. Active: yes. Save.
7. Use the "Test Delivery" button — check server logs for `[index-builder] built …` within 1–2 seconds.

## 11. (Optional) Make the server reachable from Claude Code on your laptop

Only do this if you want to query the wiki from your terminal via Claude Code.

### Option A — SSH tunnel (zero config, no DNS)

```bash
# In a background terminal:
ssh -N -L 3000:gitea-wiki-mcp:3000 root@your-host &

# Add to Claude Code:
claude mcp add wiki \
  --transport http \
  --url http://localhost:3000/mcp \
  --header "Authorization: Bearer $BEARER_FROM_STEP_2"

# Verify:
/mcp  # should show "wiki" with 6 tools
```

Kill the tunnel when done: `kill %1`.

### Option B — Publish via Caddy (public HTTPS)

1. DNS: add an `A` record for `mcp-wiki.example.com` → the host IP.
2. Edit the Caddyfile, append:
   ```
   mcp-wiki.example.com {
     encode zstd gzip
     reverse_proxy gitea-wiki-mcp:3000
   }
   ```
3. `docker compose restart caddy`.
4. Claude Code:
   ```bash
   claude mcp add wiki --transport http \
     --url https://mcp-wiki.example.com/mcp \
     --header "Authorization: Bearer $BEARER"
   ```

See `deploy/Caddyfile.example` for a copy-pasteable block.

## Rollback

```bash
cd /path/to/your/compose/dir
docker compose stop gitea-wiki-mcp
docker compose rm -f gitea-wiki-mcp
# remove the service block + volume from docker-compose.yml if you want to go clean
```

If you switched n8n to the MCP Client Tool, disable (don't delete) the new node and re-enable the original HTTP-tool nodes as a fallback.
