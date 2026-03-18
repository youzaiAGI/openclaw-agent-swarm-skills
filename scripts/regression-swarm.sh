#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SUITE="all"
AGENTS_RAW="${AGENTS:-codex,claude,gemini}"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/regression-swarm.sh [--suite all|concurrency|dod-json] [--agents codex,claude,gemini]

Options:
  --suite   Which regression suite to run. Default: all
  --agents  Comma-separated agent list. Default: codex,claude,gemini (or AGENTS env)
  -h,--help Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --suite)
      [[ $# -ge 2 ]] || { echo "ERROR: --suite requires a value" >&2; exit 1; }
      SUITE="$2"
      shift 2
      ;;
    --agents)
      [[ $# -ge 2 ]] || { echo "ERROR: --agents requires a value" >&2; exit 1; }
      AGENTS_RAW="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

case "$SUITE" in
  all|concurrency|dod-json) ;;
  *)
    echo "ERROR: invalid --suite: $SUITE (allowed: all, concurrency, dod-json)" >&2
    exit 1
    ;;
esac

run_concurrency() {
  AGENTS="$AGENTS_RAW" "$ROOT_DIR/scripts/regression-swarm-concurrency.sh"
}

run_dod_json() {
  AGENTS="$AGENTS_RAW" "$ROOT_DIR/scripts/regression-swarm-dod-json.sh"
}

case "$SUITE" in
  all)
    run_concurrency
    run_dod_json
    echo "[SUMMARY][OVERALL] suite=all result=pass"
    ;;
  concurrency)
    run_concurrency
    echo "[SUMMARY][OVERALL] suite=concurrency result=pass"
    ;;
  dod-json)
    run_dod_json
    echo "[SUMMARY][OVERALL] suite=dod-json result=pass"
    ;;
esac
