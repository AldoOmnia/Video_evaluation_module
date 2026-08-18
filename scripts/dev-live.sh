#!/usr/bin/env bash
#
# Start the platform against the real UNICOMM line — one command, on site.
#
# Live line needs two processes: the glasses-repo backend (which holds the SQL
# credentials and talks to WARKFSQL002) and this platform (which only speaks
# HTTP to it). Starting them by hand invites two mistakes that are annoying to
# diagnose in front of an audience: forgetting the connector branch, and
# letting the two API keys drift apart. This does both for you.
#
#   ./scripts/dev-live.sh
#
# Environment:
#   GLASSES_REPO   path to the comer-rokid-demo clone   (default ../comer-rokid-demo)
#   BRIDGE_PORT    port for the connector backend       (default 3000)
#   PLATFORM_PORT  port for this platform               (default 3001)
#
set -uo pipefail

GLASSES_REPO="${GLASSES_REPO:-$(cd "$(dirname "$0")/.." && pwd)/../comer-rokid-demo}"
BRIDGE_PORT="${BRIDGE_PORT:-3000}"
PLATFORM_PORT="${PLATFORM_PORT:-3001}"
CONNECTOR_BRANCH="connectors/mssql-unicomm-database"
PLATFORM_DIR="$(cd "$(dirname "$0")/.." && pwd)"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

die() { red "✗ $*"; exit 1; }

# ── Preconditions ────────────────────────────────────────────────────────────
[ -d "$GLASSES_REPO" ] || die "glasses repo not found at $GLASSES_REPO
    Clone it, or point GLASSES_REPO at your checkout:
      GLASSES_REPO=/path/to/comer-rokid-demo $0"

GLASSES_REPO="$(cd "$GLASSES_REPO" && pwd)"
BRIDGE_BACKEND="$GLASSES_REPO/backend"
[ -f "$BRIDGE_BACKEND/server.js" ] || die "no backend/server.js in $GLASSES_REPO"

branch="$(git -C "$GLASSES_REPO" branch --show-current 2>/dev/null || echo '?')"
if [ "$branch" != "$CONNECTOR_BRANCH" ]; then
  ylw "! $GLASSES_REPO is on '$branch', not '$CONNECTOR_BRANCH'."
  info "The UNICOMM SQL connector only exists on that branch. Either:"
  info "  git -C $GLASSES_REPO checkout $CONNECTOR_BRANCH"
  info "  # or leave your work alone and use a worktree:"
  info "  git -C $GLASSES_REPO worktree add ../comer-connector $CONNECTOR_BRANCH"
  info "  GLASSES_REPO=../comer-connector $0"
  die "wrong branch — nothing started"
fi

ENV_FILE="$BRIDGE_BACKEND/.env"
[ -f "$ENV_FILE" ] || die "no $ENV_FILE
    Copy backend/.env.example and fill in BACKEND_API_KEY plus the
    UNCOMM_MSSQL_* credentials (read-only login from Comer IT)."

# Read the connector's own key and reuse it, so the platform's
# LINE_BRIDGE_API_KEY can never drift from the connector's BACKEND_API_KEY.
api_key="$(grep -E '^BACKEND_API_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
[ -n "$api_key" ] || die "BACKEND_API_KEY is empty in $ENV_FILE — the connector refuses to boot without it"

if ! grep -qE '^MES_ADAPTER=unicomm' "$ENV_FILE"; then
  ylw "! MES_ADAPTER is not set to 'unicomm' in $ENV_FILE"
  info "Without it the connector serves mock data and /v1/unicomm/* stays degraded."
fi
if ! grep -qE '^UNCOMM_MSSQL_HOST=' "$ENV_FILE"; then
  ylw "! UNCOMM_MSSQL_HOST is not set (note the UNCOMM_ prefix, no second I)."
fi

# ── Connector ────────────────────────────────────────────────────────────────
bridge_pid=""
cleanup() {
  [ -n "$bridge_pid" ] && kill "$bridge_pid" 2>/dev/null
  wait "$bridge_pid" 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "▸ connector  $GLASSES_REPO ($branch) on :$BRIDGE_PORT"
( cd "$BRIDGE_BACKEND" && BACKEND_PORT="$BRIDGE_PORT" node server.js ) &
bridge_pid=$!

# Wait for the SQL pool to open — a cold MSSQL connection is routinely slow,
# and starting the platform first would make its opening read fall back to
# demo data for no reason.
echo -n "▸ waiting for /v1/unicomm/health "
health=""
for _ in $(seq 1 40); do
  if ! kill -0 "$bridge_pid" 2>/dev/null; then
    echo; die "connector exited during startup — see its output above"
  fi
  health="$(curl -s -m 3 -H "x-api-key: $api_key" \
    "http://localhost:$BRIDGE_PORT/v1/unicomm/health" 2>/dev/null || true)"
  case "$health" in *'"ok"'*) break ;; esac
  echo -n "."
  sleep 1
done
echo

case "$health" in
  *'"ok":true'*) grn "✓ connector reports the MES reachable" ;;
  *'"ok"'*)      ylw "! connector answered but reports degraded — check SQL credentials and network:"
                 info "$health" ;;
  *)             ylw "! no health response after 40s. Starting the platform anyway;"
                 info "the Live line card will show 'line connection dropped · retrying'." ;;
esac

# ── Platform ─────────────────────────────────────────────────────────────────
echo "▸ platform   http://localhost:$PLATFORM_PORT/home/"
cd "$PLATFORM_DIR"
PORT="$PLATFORM_PORT" \
LINE_BRIDGE_URL="http://localhost:$BRIDGE_PORT" \
LINE_BRIDGE_API_KEY="$api_key" \
  npm run dev
