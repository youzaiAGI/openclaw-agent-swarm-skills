#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SWARM_TS="$SCRIPT_DIR/swarm.ts"
if [[ ! -f "$SWARM_TS" ]]; then
  SWARM_TS="$ROOT_DIR/skills/openclaw-agent-swarm/scripts/swarm.ts"
fi
if [[ ! -f "$SWARM_TS" ]]; then
  echo "ERROR: swarm script not found: $SWARM_TS" >&2
  exit 1
fi

if command -v bun >/dev/null 2>&1; then
  RUN_X=(bun)
elif command -v npx >/dev/null 2>&1; then
  RUN_X=(npx -y tsx@4.20.6)
else
  echo "ERROR: runtime required. Install bun or npx (for tsx fallback)." >&2
  exit 1
fi
LOCK_FILE="${HOME}/.agents/agent-swarm/check-agents.lock"

mkdir -p "$(dirname "$LOCK_FILE")"

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo '{"ok":true,"skipped":true,"reason":"check_locked"}'
    exit 0
  fi
fi

"${RUN_X[@]}" "$SWARM_TS" check --changes-only "$@"
