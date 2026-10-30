#!/usr/bin/env bash
# Run Kairos for development in one terminal: the API (reloaded on change), the console, and,
# with KAIROS_WORKER=separate, the jobs worker. A process that already listens on the API or the
# console port is stopped first, so running this again restarts everything. Ctrl-C stops it all.
#
#   scripts/dev.sh
#
# PORT (8787), CONSOLE_PORT (5273), KAIROS_PG_PORT and KAIROS_WORKER come from the environment or .env.
set -euo pipefail

cd "$(dirname "$0")/.."

from_env_file() {
  [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1 | tr -d '"' || true
}

API_PORT="${PORT:-$(from_env_file PORT)}"
API_PORT="${API_PORT:-8787}"
CONSOLE_PORT="${CONSOLE_PORT:-$(from_env_file CONSOLE_PORT)}"
CONSOLE_PORT="${CONSOLE_PORT:-5273}"
WORKER="${KAIROS_WORKER:-$(from_env_file KAIROS_WORKER)}"

# The process and every process under it.
tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" || true); do tree "$child"; done
  echo "$pid"
}

stop() {
  local pids=""
  for pid in "$@"; do pids="$pids $(tree "$pid")"; done
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 100); do
    # shellcheck disable=SC2086
    ps -p $(echo $pids | tr ' ' ',') >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
}

free_port() {
  local port=$1 pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)
  [ -z "$pids" ] && return 0
  echo "Port $port is in use. Stopping:"
  # shellcheck disable=SC2086
  ps -o pid=,command= -p $(echo $pids | tr ' ' ',') | cut -c1-160 | sed 's/^/  /'
  # shellcheck disable=SC2086
  stop $pids
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null; then
    echo "Port $port is still in use." >&2
    exit 1
  fi
}

free_port "$API_PORT"
free_port "$CONSOLE_PORT"

children=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping Kairos..."
  # The API stops its embedded Postgres when it gets SIGTERM.
  [ ${#children[@]} -gt 0 ] && stop "${children[@]}"
}
trap cleanup INT TERM EXIT

PORT="$API_PORT" pnpm --filter @kairos/server dev &
children+=($!)
if [ "$WORKER" = "separate" ]; then
  pnpm --filter @kairos/server worker &
  children+=($!)
fi
KAIROS_URL="http://localhost:$API_PORT" pnpm --filter @kairos/console dev --port "$CONSOLE_PORT" --strictPort &
children+=($!)

echo "API: http://localhost:$API_PORT · console: http://localhost:$CONSOLE_PORT · Ctrl-C stops both"

# When one of them exits, stop the others.
while :; do
  for pid in "${children[@]}"; do
    kill -0 "$pid" 2>/dev/null || exit 1
  done
  sleep 1
done
