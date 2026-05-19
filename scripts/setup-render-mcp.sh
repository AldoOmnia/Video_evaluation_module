#!/usr/bin/env bash
# Paste a Render API key into ~/.cursor/mcp.json for the hosted MCP server.
# Usage: ./scripts/setup-render-mcp.sh [optional-api-key]
set -euo pipefail

MCP_JSON="${HOME}/.cursor/mcp.json"
KEY_FILE="${HOME}/.config/render/api_key"

mkdir -p "$(dirname "$KEY_FILE")"

if [[ "${1:-}" != "" ]]; then
  KEY="$1"
elif [[ -f "$KEY_FILE" ]]; then
  KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
  echo "Using existing key from $KEY_FILE"
else
  echo "Create an API key: https://dashboard.render.com/u/settings?add-api-key"
  echo -n "Paste your Render API key (rnd_…): "
  read -rs KEY
  echo
fi

if [[ -z "$KEY" ]]; then
  echo "No API key provided." >&2
  exit 1
fi

printf '%s' "$KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

if [[ ! -f "$MCP_JSON" ]]; then
  echo "Missing $MCP_JSON — create it first or install Cursor." >&2
  exit 1
fi

# Patch the placeholder in mcp.json (macOS sed)
if grep -q 'REPLACE_WITH_RENDER_API_KEY' "$MCP_JSON"; then
  sed -i '' "s/REPLACE_WITH_RENDER_API_KEY/${KEY}/g" "$MCP_JSON"
  echo "Updated Authorization header in $MCP_JSON"
else
  echo "Note: REPLACE_WITH_RENDER_API_KEY not found in $MCP_JSON"
  echo "Add the render block manually — see docs/render-mcp-setup.md"
fi

echo "Done. Restart MCP in Cursor (Settings → MCP → Refresh)."
echo "Then ask: Set my Render workspace to <name>"
