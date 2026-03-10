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
CONCURRENCY="${2:-10}"
POLL_SEC=15
PREFIX="regtest-$(date +%Y%m%d-%H%M%S)-$RANDOM"
TMP_REPO="$(mktemp -d "/tmp/swarm-regrepo-XXXXXX")"
TASKS_FILE="/tmp/${PREFIX}-cases.tsv"

if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]] || (( TIMEOUT_SEC <= 0 )); then
  echo "ERROR: timeout must be a positive integer (seconds), got: $TIMEOUT_SEC" >&2
  exit 1
fi
if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || (( CONCURRENCY < 2 )); then
  echo "ERROR: concurrency must be an integer >= 2 (to cover both codex and claude), got: $CONCURRENCY" >&2
  exit 1
fi

cleanup() {
  rm -rf "$TMP_REPO"
  rm -f "$TASKS_FILE"
}
trap cleanup EXIT

echo "[INFO] temp repo: $TMP_REPO"
echo "[INFO] task prefix: $PREFIX"
echo "[INFO] timeout: ${TIMEOUT_SEC}s"
echo "[INFO] concurrency(total tasks): $CONCURRENCY"

git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" config user.name "swarm-regression"
git -C "$TMP_REPO" config user.email "swarm-regression@example.com"
cat > "$TMP_REPO/README.md" <<'EOF'
# swarm regression temp repo
EOF
git -C "$TMP_REPO" add README.md
git -C "$TMP_REPO" commit -q -m "chore: init temp repo"

> "$TASKS_FILE"
codex_idx=0
claude_idx=0
for i in $(seq 1 "$CONCURRENCY"); do
  if (( i % 2 == 1 )); then
    agent="codex"
    codex_idx=$((codex_idx + 1))
    idx="$codex_idx"
  else
    agent="claude"
    claude_idx=$((claude_idx + 1))
    idx="$claude_idx"
  fi

  if (( idx % 2 == 1 )); then
    kind="write"
    if [[ "$agent" == "codex" ]]; then
      expected_file="REG_CDX_${idx}.md"
    else
      expected_file="REG_CLD_${idx}.md"
    fi
    expected_msg="test: ${agent} regression write ${idx}"
    task="写任务：在仓库根目录创建 ${expected_file}，写两行文本并提交 commit，提交信息为 \"${expected_msg}\"。"
  else
    kind="ro"
    expected_file="-"
    expected_msg="-"
    task="只读任务：请列出当前仓库根目录文件名并给一句总结；不要修改任何文件。"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$agent" "$kind" "$idx" "$expected_file" "$expected_msg" "$task" >> "$TASKS_FILE"
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
      --mode batch \
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
echo "[INFO] tmux attach commands:"
for id in "${TASK_IDS[@]}"; do
  if [[ ! -f /tmp/"${id}".spawn.out ]]; then
    echo "[ATTACH] $id :: (spawn output missing)"
    continue
  fi
  session="$(SPAWN_JSON_PATH="/tmp/${id}.spawn.out" node -e '
const fs = require("fs");
const p = process.env.SPAWN_JSON_PATH || "";
if (!p || !fs.existsSync(p)) process.exit(0);
try {
  const d = JSON.parse(fs.readFileSync(p, "utf8") || "{}");
  process.stdout.write(String((d.task || {}).tmux_session || ""));
} catch {}
')"
  if [[ -n "${session:-}" ]]; then
    echo "[ATTACH] $id :: tmux attach -t $session"
  else
    echo "[ATTACH] $id :: (tmux session not found in spawn output)"
  fi
done

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
const terminals = new Set(["success", "failed", "stopped"]);
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

wait_task_terminal() {
  local task_id="$1"
  local timeout_sec="${2:-300}"
  local start_ts
  start_ts="$(date +%s)"
  while true; do
    local now_ts
    now_ts="$(date +%s)"
    if (( now_ts - start_ts > timeout_sec )); then
      echo "[ERROR] timeout waiting terminal status for task: $task_id"
      return 1
    fi
    local status
    status="$(node "$SWARM_JS" check --json | TARGET_TASK_ID="$task_id" node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync(0,"utf8")||"{}");
const id=String(process.env.TARGET_TASK_ID||"");
const t=(d.tasks||[]).find(x=>String(x.id||"")===id);
process.stdout.write(String((t&&t.status)||"missing"));
')"
    if [[ "$status" == "success" || "$status" == "failed" || "$status" == "stopped" ]]; then
      return 0
    fi
    sleep 5
  done
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

run_attach_regression_case() {
  local agent="$1"
  local attach_task_id="${PREFIX}-${agent}-attach"
  local spawn_task="请先输出 need your input，然后保持会话等待，不要自行退出。"
  local attach_msg="补充要求：请确认已收到附加指令。"

  node "$SWARM_JS" spawn \
    --repo "$TMP_REPO" \
    --mode interactive \
    --agent "$agent" \
    --name "$attach_task_id" \
    --task "$spawn_task" >/tmp/"${attach_task_id}".spawn.out 2>/tmp/"${attach_task_id}".spawn.err

  sleep 2

  local attach_json
  attach_json="$(node "$SWARM_JS" attach --id "$attach_task_id" --message "$attach_msg")"
  local attach_sent
  attach_sent="$(ATTACH_JSON="$attach_json" node -e 'const d=JSON.parse(process.env.ATTACH_JSON||"{}");process.stdout.write(String(Boolean(d.sent)));')"
  if [[ "$attach_sent" != "true" ]]; then
    echo "[ERROR] attach expected sent=true for running task: $attach_task_id"
    echo "[DEBUG] attach response: $attach_json"
    return 1
  fi

  local cancel_json
  cancel_json="$(node "$SWARM_JS" cancel --id "$attach_task_id" --force --reason "regression_cleanup_attach")"
  local cancel_ok
  cancel_ok="$(CANCEL_JSON="$cancel_json" node -e 'const d=JSON.parse(process.env.CANCEL_JSON||"{}");const ok=Boolean(d.cancelled)&&String(d.status||"")==="stopped"&&String(d.converged_reason||"").startsWith("user_cancelled:");process.stdout.write(String(ok));')"
  if [[ "$cancel_ok" != "true" ]]; then
    echo "[ERROR] cancel expected cancelled=true and status=stopped: $attach_task_id"
    echo "[DEBUG] cancel response: $cancel_json"
    return 1
  fi

  local cancel_again_json
  cancel_again_json="$(node "$SWARM_JS" cancel --id "$attach_task_id" --reason "idempotent_check")"
  local cancel_idempotent
  cancel_idempotent="$(CANCEL_JSON="$cancel_again_json" node -e 'const d=JSON.parse(process.env.CANCEL_JSON||"{}");process.stdout.write(String(Boolean(d.already_terminal)));')"
  if [[ "$cancel_idempotent" != "true" ]]; then
    echo "[ERROR] cancel expected already_terminal=true on second call: $attach_task_id"
    echo "[DEBUG] cancel second response: $cancel_again_json"
    return 1
  fi

  local attach_after_cancel_json
  attach_after_cancel_json="$(node "$SWARM_JS" attach --id "$attach_task_id" --message "再次补充")"
  local requires_confirmation
  requires_confirmation="$(ATTACH_JSON="$attach_after_cancel_json" node -e 'const d=JSON.parse(process.env.ATTACH_JSON||"{}");process.stdout.write(String(Boolean(d.requires_confirmation)));')"
  if [[ "$requires_confirmation" != "true" ]]; then
    echo "[ERROR] attach expected requires_confirmation=true for non-running task: $attach_task_id"
    echo "[DEBUG] attach response after cancel: $attach_after_cancel_json"
    return 1
  fi

  # User rejects confirmation: do nothing and ensure no follow-up task is auto-created.
  local followup_count_before
  followup_count_before="$(node "$SWARM_JS" list | FOLLOW_PARENT_ID="$attach_task_id" node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8")||"{}");const c=(d.tasks||[]).filter(t=>String(t.parent_task_id||"")===String(process.env.FOLLOW_PARENT_ID||"")).length;process.stdout.write(String(c));')"
  local followup_count_after_reject
  followup_count_after_reject="$(node "$SWARM_JS" list | FOLLOW_PARENT_ID="$attach_task_id" node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8")||"{}");const c=(d.tasks||[]).filter(t=>String(t.parent_task_id||"")===String(process.env.FOLLOW_PARENT_ID||"")).length;process.stdout.write(String(c));')"
  if [[ "$followup_count_after_reject" != "$followup_count_before" ]]; then
    echo "[ERROR] reject path should not create follow-up task automatically: $attach_task_id"
    return 1
  fi

  # User agrees confirmation: create follow-up (new worktree) and verify commit.
  local followup_task_id="${attach_task_id}-agree"
  local followup_file="FOLLOWUP_NEW_${agent}.md"
  local followup_commit="test: ${agent} followup new commit"
  local followup_json
  followup_json="$(node "$SWARM_JS" spawn-followup \
    --from "$attach_task_id" \
    --task "写任务：在仓库根目录创建 ${followup_file}，写两行文本并提交 commit，提交信息为 \"${followup_commit}\"。" \
    --worktree-mode new \
    --agent "$agent" \
    --name "$followup_task_id")"
  local followup_ok
  followup_ok="$(FOLLOWUP_JSON="$followup_json" FOLLOWUP_TASK_ID="$followup_task_id" FOLLOW_PARENT_ID="$attach_task_id" node -e 'const d=JSON.parse(process.env.FOLLOWUP_JSON||"{}");const ok=Boolean(d.ok)&&String(d.parent_id||"")===String(process.env.FOLLOW_PARENT_ID||"")&&String((d.task||{}).id||"")===String(process.env.FOLLOWUP_TASK_ID||"");process.stdout.write(String(ok));')"
  if [[ "$followup_ok" != "true" ]]; then
    echo "[ERROR] agree path should create follow-up task: $attach_task_id"
    echo "[DEBUG] follow-up response: $followup_json"
    return 1
  fi
  if ! wait_task_terminal "$followup_task_id" 300; then
    return 1
  fi
  if ! validate_task_file_and_commit "$followup_task_id" "$followup_file" "$followup_commit"; then
    return 1
  fi

  # User agrees confirmation with reuse mode and verify same worktree + commit.
  local followup_reuse_task_id="${attach_task_id}-agree-reuse"
  local followup_reuse_file="FOLLOWUP_REUSE_${agent}.md"
  local followup_reuse_commit="test: ${agent} followup reuse commit"
  local followup_reuse_json
  followup_reuse_json="$(node "$SWARM_JS" spawn-followup \
    --from "$attach_task_id" \
    --task "写任务：在仓库根目录创建 ${followup_reuse_file}，写两行文本并提交 commit，提交信息为 \"${followup_reuse_commit}\"。" \
    --worktree-mode reuse \
    --agent "$agent" \
    --name "$followup_reuse_task_id")"
  local followup_reuse_ok
  followup_reuse_ok="$(FOLLOWUP_JSON="$followup_reuse_json" FOLLOWUP_TASK_ID="$followup_reuse_task_id" FOLLOW_PARENT_ID="$attach_task_id" node -e '
const d = JSON.parse(process.env.FOLLOWUP_JSON || "{}");
const t = d.task || {};
const ok = Boolean(d.ok)
  && String(d.parent_id || "") === String(process.env.FOLLOW_PARENT_ID || "")
  && String(t.id || "") === String(process.env.FOLLOWUP_TASK_ID || "")
  && String(t.worktree_mode || "") === "reuse";
process.stdout.write(String(ok));
')"
  if [[ "$followup_reuse_ok" != "true" ]]; then
    echo "[ERROR] agree path (reuse) should create follow-up task: $attach_task_id"
    echo "[DEBUG] follow-up reuse response: $followup_reuse_json"
    return 1
  fi

  local same_worktree
  same_worktree="$(node "$SWARM_JS" list | FOLLOWUP_JSON="$followup_reuse_json" PARENT_TASK_ID="$attach_task_id" node -e '
const fs = require("fs");
const followup = JSON.parse(process.env.FOLLOWUP_JSON || "{}");
const parentId = String(process.env.PARENT_TASK_ID || "");
const list = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const parent = (list.tasks || []).find((t) => String(t.id || "") === String(parentId));
const childWt = String((followup.task || {}).worktree || "");
const parentWt = String((parent || {}).worktree || "");
process.stdout.write(String(Boolean(childWt && parentWt && childWt === parentWt)));
')"
  if [[ "$same_worktree" != "true" ]]; then
    echo "[ERROR] reuse mode should reuse parent worktree: $attach_task_id"
    echo "[DEBUG] follow-up reuse response: $followup_reuse_json"
    return 1
  fi

  if ! wait_task_terminal "$followup_reuse_task_id" 300; then
    return 1
  fi
  if ! validate_task_file_and_commit "$followup_reuse_task_id" "$followup_reuse_file" "$followup_reuse_commit"; then
    return 1
  fi

  echo "[OK] attach+cancel+confirm(new+reuse) regression verified for $agent"
  return 0
}

attach_fail=0
for agent in codex claude; do
  if ! run_attach_regression_case "$agent"; then
    attach_fail=1
  fi
done

if (( attach_fail != 0 )); then
  echo "[ERROR] attach/cancel regression failed"
  exit 1
fi

echo "[PASS] concurrency regression passed"
