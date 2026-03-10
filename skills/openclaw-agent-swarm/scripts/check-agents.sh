#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SWARM_JS="$SCRIPT_DIR/swarm.js"
if [[ ! -f "$SWARM_JS" ]]; then
  SWARM_JS="$ROOT_DIR/skills/openclaw-agent-swarm/scripts/swarm.js"
fi
LOCK_FILE="${HOME}/.agents/agent-swarm/check-agents.lock"

mkdir -p "$(dirname "$LOCK_FILE")"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo '{"ok":true,"skipped":true,"reason":"check_locked"}'
  exit 0
fi

node "$SWARM_JS" check --changes-only "$@"
