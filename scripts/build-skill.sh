#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CODE_DIR="$ROOT_DIR/code"
SKILL_DIR="$ROOT_DIR/skills/openclaw-agent-swarm"

if [[ ! -f "$CODE_DIR/package.json" ]]; then
  echo "missing $CODE_DIR/package.json" >&2
  exit 1
fi

pushd "$CODE_DIR" >/dev/null
if [[ ! -d "node_modules" ]]; then
  npm install
fi
npm run build
popd >/dev/null

mkdir -p "$SKILL_DIR/scripts"
cp "$CODE_DIR/dist/src/swarm.js" "$SKILL_DIR/scripts/swarm.js"
chmod +x "$SKILL_DIR/scripts/swarm.js"

echo "Build complete: $SKILL_DIR/scripts/swarm.js"
