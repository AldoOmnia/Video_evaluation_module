# Render MCP — monitor deploys from Cursor

Cursor can talk to your Render account (services, deploys, logs, metrics)
via Render's **hosted** MCP server. You do **not** need to run the
GitHub repo locally for day-to-day use.

- **Hosted MCP (recommended):** `https://mcp.render.com/mcp`
- **Source repo (optional):** cloned to `~/tools/render-mcp-server` for reference

Official docs: https://render.com/docs/mcp-server

---

## 1. Create a Render API key

1. Open https://dashboard.render.com/u/settings?add-api-key
2. Name it something like `cursor-mcp`
3. Copy the key (starts with `rnd_`)

This key can access **all workspaces and services** your account can see.
Only create it if you're comfortable with that scope.

---

## 2. Wire Cursor

Your global MCP config is `~/.cursor/mcp.json`. A `render` entry is
already added; you only need to paste the key.

**Option A — setup script (fastest)**

From this repo:

```bash
./scripts/setup-render-mcp.sh
```

Paste your API key when prompted. The script stores it in
`~/.config/render/api_key` (mode `600`) and patches `~/.cursor/mcp.json`.

**Option B — manual**

Edit `~/.cursor/mcp.json` and replace `REPLACE_WITH_RENDER_API_KEY` with
your key:

```json
"render": {
  "url": "https://mcp.render.com/mcp",
  "headers": {
    "Authorization": "Bearer rnd_xxxxxxxx"
  }
}
```

---

## 3. Restart MCP in Cursor

1. **Cursor Settings → MCP** (or Command Palette → "MCP: List Servers")
2. Confirm **render** appears and shows as connected (green)
3. If it stays red, click **Refresh** or restart Cursor

---

## 4. Select your workspace (required once)

In any Cursor chat, say:

```
Set my Render workspace to [your workspace name]
```

Or:

```
List my Render workspaces
```

Until a workspace is selected, tools like `list_services` won't return
your `comer-platform` service.

---

## 5. Useful prompts for `comer-platform`

After the TS build fix deploy (`6218b91` on `platform-comer`):

```
List my Render services
```

```
Get details for my comer-platform service
```

```
List the last 5 deploys for comer-platform
```

```
Pull the most recent error-level logs for comer-platform
```

```
What was the HTTP status breakdown for comer-platform in the last hour?
```

---

## Local clone (optional)

The repo is at:

```
~/tools/render-mcp-server
```

Render recommends the **hosted** server because it auto-updates. Run
locally only if you need to hack on the MCP itself:

```bash
curl -fsSL https://raw.githubusercontent.com/render-oss/render-mcp-server/refs/heads/main/bin/install.sh | sh
```

Then point `~/.cursor/mcp.json` at the installed binary (see
https://render.com/docs/mcp-server#running-locally).

---

## Security

- Never commit your `rnd_` key to git
- `~/.config/render/api_key` is local-only (not in this repo)
- Rotating the key: create a new one in Render → update `mcp.json` → revoke the old key
