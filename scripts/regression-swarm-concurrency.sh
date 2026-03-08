#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWARM_JS="$ROOT_DIR/skills/openclaw-agent-swarm/scripts/swarm.js"
STATE_DIR="$HOME/.agents/agent-swarm/tasks"

if [[ ! -f "$SWARM_JS" ]]; then
  echo "ERROR: swarm script not found: $SWARM_JS" >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "ERROR: node is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "ERROR: codex is required" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: claude is required" >&2; exit 1; }

TIMEOUT_SEC="${1:-900}"
POLL_SEC=15
PREFIX="regtest-$(date +%Y%m%d-%H%M%S)-$RANDOM"
TMP_REPO="$(mktemp -d "/tmp/swarm-regrepo-XXXXXX")"
TASKS_FILE="/tmp/${PREFIX}-cases.tsv"

cleanup() {
  rm -rf "$TMP_REPO"
  rm -f "$TASKS_FILE"
}
trap cleanup EXIT

echo "[INFO] temp repo: $TMP_REPO"
echo "[INFO] task prefix: $PREFIX"

git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" config user.name "swarm-regression"
git -C "$TMP_REPO" config user.email "swarm-regression@example.com"
cat > "$TMP_REPO/README.md" <<'EOF'
# swarm regression temp repo
EOF
git -C "$TMP_REPO" add README.md
git -C "$TMP_REPO" commit -q -m "chore: init temp repo"

> "$TASKS_FILE"
for agent in codex claude; do
  for i in $(seq 1 10); do
    if (( i % 2 == 1 )); then
      kind="ro"
      expected_file="-"
      expected_msg="-"
      task="只读任务：请列出当前仓库根目录文件名并给一句总结；不要修改任何文件。"
    else
      kind="write"
      if [[ "$agent" == "codex" ]]; then
        expected_file="REG_CDX_${i}.md"
      else
        expected_file="REG_CLD_${i}.md"
      fi
      expected_msg="test: ${agent} regression write ${i}"
      task="写任务：在仓库根目录创建 ${expected_file}，写两行文本并提交 commit，提交信息为 \"${expected_msg}\"。"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$agent" "$kind" "$i" "$expected_file" "$expected_msg" "$task" >> "$TASKS_FILE"
  done
done

declare -a TASK_IDS=()
declare -a SPAWN_PIDS=()
declare -a WRITE_CASES=()

while IFS=$'\t' read -r agent kind idx expected_file expected_msg task; do
  task_id="${PREFIX}-${agent}-${kind}${idx}"
  TASK_IDS+=("$task_id")
  if [[ "$kind" == "write" ]]; then
    WRITE_CASES+=("${task_id}|${expected_file}|${expected_msg}")
  fi
  (
    node "$SWARM_JS" spawn \
      --repo "$TMP_REPO" \
      --agent "$agent" \
      --name "$task_id" \
      --task "$task" >/tmp/"${task_id}".spawn.out 2>/tmp/"${task_id}".spawn.err
  ) &
  SPAWN_PIDS+=("$!")
done < "$TASKS_FILE"

spawn_fail=0
for pid in "${SPAWN_PIDS[@]}"; do
  if ! wait "$pid"; then
    spawn_fail=1
  fi
done

if [[ "$spawn_fail" -ne 0 ]]; then
  echo "[ERROR] spawn phase failed"
  for id in "${TASK_IDS[@]}"; do
    if [[ -f /tmp/"${id}".spawn.err ]]; then
      err="$(cat /tmp/"${id}".spawn.err || true)"
      [[ -n "$err" ]] && echo "[SPAWN_ERR] $id :: $err"
    fi
  done
  exit 1
fi
echo "[INFO] spawn phase ok (${#TASK_IDS[@]} tasks)"

start_ts="$(date +%s)"
while true; do
  now_ts="$(date +%s)"
  elapsed=$((now_ts - start_ts))
  if (( elapsed > TIMEOUT_SEC )); then
    echo "[ERROR] timeout waiting tasks to converge (${TIMEOUT_SEC}s)"
    break
  fi

  json="$(node "$SWARM_JS" check --json)"
  summary="$(SUMMARY_INPUT_JSON="$json" IDS_CSV="$(IFS=,; echo "${TASK_IDS[*]}")" node -e '
const data = JSON.parse(process.env.SUMMARY_INPUT_JSON || "{}");
const ids = new Set((process.env.IDS_CSV || "").split(",").filter(Boolean));
const terminals = new Set(["success", "failed", "stopped", "needs_human"]);
let found = 0;
let done = 0;
const rows = [];
for (const t of data.tasks || []) {
  if (!ids.has(String(t.id || ""))) continue;
  found++;
  const status = String(t.status || "unknown");
  if (terminals.has(status)) done++;
  rows.push(`${t.id}:${status}`);
}
console.log(JSON.stringify({ found, done, total: ids.size, rows }));
')"
  found="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(String(s.found));")"
  done="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(String(s.done));")"
  total="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(String(s.total));")"
  rows="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(s.rows.join(' | '));")"
  echo "[CHECK] +${elapsed}s  ${rows}"

  if [[ "$found" -eq "$total" && "$done" -eq "$total" ]]; then
    echo "[INFO] all tasks reached terminal status"
    break
  fi
  sleep "$POLL_SEC"
done

if [[ "${done:-0}" -ne "${#TASK_IDS[@]}" ]]; then
  echo "[ERROR] not all tasks converged"
  exit 1
fi

# Print final converged reason for each task.
IDS_CSV="$(IFS=,; echo "${TASK_IDS[*]}")" STATE_DIR="$STATE_DIR" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const ids = (process.env.IDS_CSV || '').split(',').filter(Boolean);
const stateDir = process.env.STATE_DIR || '';
for (const id of ids) {
  const p = path.join(stateDir, `${encodeURIComponent(id)}.json`);
  if (!fs.existsSync(p)) {
    console.log(`[RESULT] ${id} status=missing converged_reason=missing_task_json`);
    continue;
  }
  const t = JSON.parse(fs.readFileSync(p, 'utf8'));
  const status = t.status || 'unknown';
  const reason = t.converged_reason || 'unknown';
  console.log(`[RESULT] ${id} status=${status} converged_reason=${reason}`);
}
NODE

# Validate every write task created file and commit.
validate_task_file_and_commit() {
  local task_id="$1"
  local expected_file="$2"
  local expected_msg="$3"
  local task_id_encoded
  task_id_encoded="$(node -p "encodeURIComponent(process.argv[1])" "$task_id")"
  local task_json="$STATE_DIR/${task_id_encoded}.json"
  if [[ ! -f "$task_json" ]]; then
    echo "[ERROR] task json missing: $task_id"
    return 1
  fi
  local worktree
  worktree="$(node -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync('$task_json','utf8'));process.stdout.write(t.worktree||'');")"
  if [[ -z "$worktree" || ! -d "$worktree" ]]; then
    echo "[ERROR] worktree missing for $task_id"
    return 1
  fi
  if [[ ! -f "$worktree/$expected_file" ]]; then
    echo "[ERROR] expected file missing for $task_id: $expected_file"
    return 1
  fi
  local head_msg
  head_msg="$(git -C "$worktree" log -n 1 --pretty=%s || true)"
  if [[ "$head_msg" != "$expected_msg" ]]; then
    echo "[ERROR] unexpected commit message for $task_id: $head_msg"
    return 1
  fi
  echo "[OK] $task_id file+commit verified"
  return 0
}

write_fail=0
for item in "${WRITE_CASES[@]}"; do
  IFS='|' read -r task_id expected_file expected_msg <<< "$item"
  if ! validate_task_file_and_commit "$task_id" "$expected_file" "$expected_msg"; then
    write_fail=1
  fi
done

if (( write_fail != 0 )); then
  echo "[ERROR] write task verification failed (require all write tasks committed)"
  exit 1
fi

echo "[PASS] concurrency regression passed"
