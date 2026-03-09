#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWARM_JS="$ROOT_DIR/skills/openclaw-agent-swarm-batch/scripts/swarm-batch.js"
STATE_DIR="$HOME/.agents/agent-swarm-batch/tasks"

if [[ ! -f "$SWARM_JS" ]]; then
  echo "ERROR: swarm-batch script not found: $SWARM_JS" >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "ERROR: node is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "ERROR: tmux is required" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "ERROR: codex is required" >&2; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: claude is required" >&2; exit 1; }

TIMEOUT_SEC="${1:-900}"
CONCURRENCY="${2:-20}"
POLL_SEC=15
PREFIX="regbatch-$(date +%Y%m%d-%H%M%S)-$RANDOM"
TMP_REPO="$(mktemp -d "/tmp/swarm-batch-regrepo-XXXXXX")"
TASKS_FILE="/tmp/${PREFIX}-cases.tsv"

if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]] || (( TIMEOUT_SEC <= 0 )); then
  echo "ERROR: timeout must be a positive integer (seconds), got: $TIMEOUT_SEC" >&2
  exit 1
fi
if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || (( CONCURRENCY < 4 )); then
  echo "ERROR: concurrency must be an integer >= 4 to include mixed read/write tasks, got: $CONCURRENCY" >&2
  exit 1
fi

cleanup() {
  rm -rf "$TMP_REPO"
  rm -f "$TASKS_FILE"
  rm -f /tmp/"${PREFIX}"-*.spawn.out /tmp/"${PREFIX}"-*.spawn.err
}
trap cleanup EXIT

echo "[INFO] temp repo: $TMP_REPO"
echo "[INFO] task prefix: $PREFIX"
echo "[INFO] timeout: ${TIMEOUT_SEC}s"
echo "[INFO] concurrency(total tasks): $CONCURRENCY"

git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" config user.name "swarm-batch-regression"
git -C "$TMP_REPO" config user.email "swarm-batch-regression@example.com"
cat > "$TMP_REPO/README.md" <<'EOF'
# swarm batch regression temp repo
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
      expected_file="BATCH_REG_CDX_${idx}.md"
    else
      expected_file="BATCH_REG_CLD_${idx}.md"
    fi
    expected_msg="test: ${agent} batch regression write ${idx}"
    task="写任务：在仓库根目录创建 ${expected_file}，写两行文本并提交 commit，提交信息为 \"${expected_msg}\"。"
  else
    kind="read"
    expected_file="-"
    expected_msg="-"
    task="只读任务：列出仓库根目录文件并给一句总结；不要修改文件，不要提交 commit。"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$agent" "$kind" "$idx" "$expected_file" "$expected_msg" "$task" >> "$TASKS_FILE"
done

declare -a TASK_IDS=()
declare -a SPAWN_PIDS=()
declare -a WRITE_CASES=()
declare -a READ_CASES=()

while IFS=$'\t' read -r agent kind idx expected_file expected_msg task; do
  task_id="${PREFIX}-${agent}-${kind}${idx}"
  TASK_IDS+=("$task_id")
  if [[ "$kind" == "write" ]]; then
    WRITE_CASES+=("${task_id}|${expected_file}|${expected_msg}")
  else
    READ_CASES+=("$task_id")
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
    if [[ -f /tmp/"${id}".spawn.out ]]; then
      out="$(cat /tmp/"${id}".spawn.out || true)"
      [[ -n "$out" ]] && echo "[SPAWN_OUT] $id :: $out"
    fi
  done
  exit 1
fi

spawn_json_fail=0
for id in "${TASK_IDS[@]}"; do
  if [[ ! -f /tmp/"${id}".spawn.out ]]; then
    echo "[ERROR] spawn output missing: $id"
    spawn_json_fail=1
    continue
  fi
  ok="$(SPAWN_JSON_PATH="/tmp/${id}.spawn.out" node -e '
const fs = require("fs");
try {
  const d = JSON.parse(fs.readFileSync(process.env.SPAWN_JSON_PATH, "utf8") || "{}");
  process.stdout.write(String(Boolean(d.ok)));
} catch {
  process.stdout.write("false");
}
')"
  if [[ "$ok" != "true" ]]; then
    echo "[ERROR] spawn returned ok=false: $id"
    cat /tmp/"${id}".spawn.out
    spawn_json_fail=1
  fi
done

if [[ "$spawn_json_fail" -ne 0 ]]; then
  exit 1
fi

echo "[INFO] spawn phase ok (${#TASK_IDS[@]} tasks)"

start_ts="$(date +%s)"
success_count=0
failed_count=0
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
let found = 0;
let success = 0;
let failed = 0;
const rows = [];
for (const t of data.tasks || []) {
  if (!ids.has(String(t.id || ""))) continue;
  found++;
  const status = String(t.status || "unknown");
  if (status === "success") success++;
  if (status === "failed") failed++;
  rows.push(`${t.id}:${status}`);
}
console.log(JSON.stringify({ found, success, failed, total: ids.size, rows }));
')"
  found="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(String(s.found));")"
  success_count="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(String(s.success));")"
  failed_count="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(String(s.failed));")"
  total="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(String(s.total));")"
  rows="$(SUMMARY_JSON="$summary" node -e "const s=JSON.parse(process.env.SUMMARY_JSON); process.stdout.write(s.rows.join(' | '));")"
  echo "[CHECK] +${elapsed}s ${rows}"

  if (( failed_count > 0 )); then
    echo "[ERROR] detected failed tasks during convergence"
    break
  fi
  if [[ "$found" -eq "$total" && "$success_count" -eq "$total" ]]; then
    echo "[INFO] all tasks reached success status"
    break
  fi
  sleep "$POLL_SEC"
done

if [[ "${success_count:-0}" -ne "${#TASK_IDS[@]}" ]]; then
  echo "[ERROR] not all tasks reached success"
  exit 1
fi

IDS_CSV="$(IFS=,; echo "${TASK_IDS[*]}")" STATE_DIR="$STATE_DIR" node - <<'NODE'
const fs = require("fs");
const path = require("path");
const ids = (process.env.IDS_CSV || "").split(",").filter(Boolean);
const stateDir = process.env.STATE_DIR || "";
for (const id of ids) {
  const p = path.join(stateDir, `${encodeURIComponent(id)}.json`);
  if (!fs.existsSync(p)) {
    console.log(`[RESULT] ${id} status=missing converged_reason=missing_task_json`);
    continue;
  }
  const t = JSON.parse(fs.readFileSync(p, "utf8"));
  const status = t.status || "unknown";
  const reason = t.converged_reason || "unknown";
  console.log(`[RESULT] ${id} status=${status} converged_reason=${reason}`);
}
NODE

validate_write_task() {
  local task_id="$1"
  local expected_file="$2"
  local expected_msg="$3"
  local encoded task_json worktree branch base_branch
  encoded="$(node -p "encodeURIComponent(process.argv[1])" "$task_id")"
  task_json="$STATE_DIR/${encoded}.json"
  if [[ ! -f "$task_json" ]]; then
    echo "[ERROR] task json missing: $task_id"
    return 1
  fi

  local meta
  meta="$(TASK_JSON="$task_json" node -e '
const fs=require("fs");
const t=JSON.parse(fs.readFileSync(process.env.TASK_JSON,"utf8"));
process.stdout.write([String(t.worktree||""), String(t.branch||""), String(t.base_branch||"")].join("\t"));
')"
  IFS=$'\t' read -r worktree branch base_branch <<< "$meta"
  if [[ -z "$worktree" || ! -d "$worktree" ]]; then
    echo "[ERROR] worktree missing for $task_id"
    return 1
  fi
  if [[ ! -f "$worktree/$expected_file" ]]; then
    echo "[ERROR] expected file missing for $task_id: $expected_file"
    return 1
  fi
  local head_msg ahead status
  head_msg="$(git -C "$worktree" log -n 1 --pretty=%s || true)"
  ahead="$(git -C "$worktree" rev-list --count "${base_branch}..${branch}" || echo 0)"
  status="$(git -C "$worktree" status --porcelain || true)"
  if [[ "$head_msg" != "$expected_msg" ]]; then
    echo "[ERROR] unexpected commit message for $task_id: $head_msg"
    return 1
  fi
  if ! [[ "$ahead" =~ ^[0-9]+$ ]] || (( ahead < 1 )); then
    echo "[ERROR] write task has no commit ahead for $task_id"
    return 1
  fi
  if [[ -n "$status" ]]; then
    echo "[ERROR] write task worktree not clean for $task_id"
    return 1
  fi
  echo "[OK] write task verified: $task_id"
}

validate_read_task() {
  local task_id="$1"
  local encoded task_json worktree branch base_branch
  encoded="$(node -p "encodeURIComponent(process.argv[1])" "$task_id")"
  task_json="$STATE_DIR/${encoded}.json"
  if [[ ! -f "$task_json" ]]; then
    echo "[ERROR] task json missing: $task_id"
    return 1
  fi
  local meta
  meta="$(TASK_JSON="$task_json" node -e '
const fs=require("fs");
const t=JSON.parse(fs.readFileSync(process.env.TASK_JSON,"utf8"));
process.stdout.write([String(t.worktree||""), String(t.branch||""), String(t.base_branch||"")].join("\t"));
')"
  IFS=$'\t' read -r worktree branch base_branch <<< "$meta"
  if [[ -z "$worktree" || ! -d "$worktree" ]]; then
    echo "[ERROR] worktree missing for $task_id"
    return 1
  fi
  local ahead status
  ahead="$(git -C "$worktree" rev-list --count "${base_branch}..${branch}" || echo 999)"
  status="$(git -C "$worktree" status --porcelain || true)"
  if ! [[ "$ahead" =~ ^[0-9]+$ ]] || (( ahead != 0 )); then
    echo "[ERROR] read task unexpectedly created commits for $task_id"
    return 1
  fi
  if [[ -n "$status" ]]; then
    echo "[ERROR] read task worktree not clean for $task_id"
    return 1
  fi
  echo "[OK] read task verified: $task_id"
}

wait_task_status() {
  local task_id="$1"
  local expected_status="$2"
  local timeout_sec="${3:-300}"
  local start_ts now_ts status
  start_ts="$(date +%s)"
  while true; do
    now_ts="$(date +%s)"
    if (( now_ts - start_ts > timeout_sec )); then
      echo "[ERROR] timeout waiting status=$expected_status for task: $task_id"
      return 1
    fi
    status="$(node "$SWARM_JS" status --id "$task_id" | node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync(0,"utf8")||"{}");
process.stdout.write(String((d.task||{}).status||""));
')"
    if [[ "$status" == "$expected_status" ]]; then
      return 0
    fi
    sleep 3
  done
}

run_attach_cancel_case() {
  local agent="$1"
  local task_id="${PREFIX}-${agent}-attach-cancel"
  local long_task="长任务：先执行 sleep 120，再输出一句 done。"
  local spawn_json
  spawn_json="$(node "$SWARM_JS" spawn --repo "$TMP_REPO" --agent "$agent" --name "$task_id" --task "$long_task")"
  local spawn_ok
  spawn_ok="$(SPAWN_JSON="$spawn_json" node -e 'const d=JSON.parse(process.env.SPAWN_JSON||"{}");process.stdout.write(String(Boolean(d.ok)));')"
  if [[ "$spawn_ok" != "true" ]]; then
    echo "[ERROR] attach/cancel case spawn failed: $task_id"
    echo "[DEBUG] $spawn_json"
    return 1
  fi

  if ! wait_task_status "$task_id" "running" 40; then
    return 1
  fi

  local attach_json requires_confirmation sent reason
  attach_json="$(node "$SWARM_JS" attach --id "$task_id" --message "补充要求：请继续")"
  requires_confirmation="$(ATTACH_JSON="$attach_json" node -e 'const d=JSON.parse(process.env.ATTACH_JSON||"{}");process.stdout.write(String(Boolean(d.requires_confirmation)));')"
  sent="$(ATTACH_JSON="$attach_json" node -e 'const d=JSON.parse(process.env.ATTACH_JSON||"{}");process.stdout.write(String(Boolean(d.sent)));')"
  reason="$(ATTACH_JSON="$attach_json" node -e 'const d=JSON.parse(process.env.ATTACH_JSON||"{}");process.stdout.write(String(d.reason||""));')"
  if [[ "$requires_confirmation" != "true" || "$sent" != "false" || "$reason" != "attach_not_supported_in_batch_mode" ]]; then
    echo "[ERROR] attach case assertion failed: $task_id"
    echo "[DEBUG] $attach_json"
    return 1
  fi

  local cancel_json cancelled status reason2
  cancel_json="$(node "$SWARM_JS" cancel --id "$task_id" --force --reason "regression_user_cancel")"
  cancelled="$(CANCEL_JSON="$cancel_json" node -e 'const d=JSON.parse(process.env.CANCEL_JSON||"{}");process.stdout.write(String(Boolean(d.cancelled)));')"
  status="$(CANCEL_JSON="$cancel_json" node -e 'const d=JSON.parse(process.env.CANCEL_JSON||"{}");process.stdout.write(String(d.status||""));')"
  reason2="$(CANCEL_JSON="$cancel_json" node -e 'const d=JSON.parse(process.env.CANCEL_JSON||"{}");process.stdout.write(String(d.converged_reason||""));')"
  if [[ "$cancelled" != "true" || "$status" != "failed" || "$reason2" != user_cancelled:* ]]; then
    echo "[ERROR] cancel case assertion failed: $task_id"
    echo "[DEBUG] $cancel_json"
    return 1
  fi
  echo "[OK] attach+cancel verified for $agent"
}

run_followup_cases() {
  local parent_task_id="$1"
  local agent="$2"
  local parent_worktree
  parent_worktree="$(node "$SWARM_JS" status --id "$parent_task_id" | node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync(0,"utf8")||"{}");
process.stdout.write(String((d.task||{}).worktree||""));
')"
  if [[ -z "$parent_worktree" ]]; then
    echo "[ERROR] parent worktree missing for followup case: $parent_task_id"
    return 1
  fi

  local new_id="${parent_task_id}-followup-new"
  local new_file="FOLLOWUP_NEW_${agent}.md"
  local new_msg="test: ${agent} followup new"
  local new_json
  new_json="$(node "$SWARM_JS" spawn-followup --from "$parent_task_id" --task "写任务：在仓库根目录创建 ${new_file}，写两行文本并提交 commit，提交信息为 \"${new_msg}\"。" --worktree-mode new --agent "$agent" --name "$new_id")"
  local new_ok
  new_ok="$(FOLLOWUP_JSON="$new_json" node -e 'const d=JSON.parse(process.env.FOLLOWUP_JSON||"{}");process.stdout.write(String(Boolean(d.ok)));')"
  if [[ "$new_ok" != "true" ]]; then
    echo "[ERROR] followup new spawn failed: $new_id"
    echo "[DEBUG] $new_json"
    return 1
  fi
  if ! wait_task_status "$new_id" "success" 300; then
    return 1
  fi
  if ! validate_write_task "$new_id" "$new_file" "$new_msg"; then
    return 1
  fi
  local new_worktree
  new_worktree="$(node "$SWARM_JS" status --id "$new_id" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8")||"{}");process.stdout.write(String((d.task||{}).worktree||""));')"
  if [[ "$new_worktree" == "$parent_worktree" ]]; then
    echo "[ERROR] followup new should use different worktree: $new_id"
    return 1
  fi
  echo "[OK] followup new verified: $new_id"

  local reuse_id="${parent_task_id}-followup-reuse"
  local reuse_file="FOLLOWUP_REUSE_${agent}.md"
  local reuse_msg="test: ${agent} followup reuse"
  local reuse_json
  reuse_json="$(node "$SWARM_JS" spawn-followup --from "$parent_task_id" --task "写任务：在仓库根目录创建 ${reuse_file}，写两行文本并提交 commit，提交信息为 \"${reuse_msg}\"。" --worktree-mode reuse --agent "$agent" --name "$reuse_id")"
  local reuse_ok
  reuse_ok="$(FOLLOWUP_JSON="$reuse_json" node -e 'const d=JSON.parse(process.env.FOLLOWUP_JSON||"{}");process.stdout.write(String(Boolean(d.ok)));')"
  if [[ "$reuse_ok" != "true" ]]; then
    echo "[ERROR] followup reuse spawn failed: $reuse_id"
    echo "[DEBUG] $reuse_json"
    return 1
  fi
  if ! wait_task_status "$reuse_id" "success" 300; then
    return 1
  fi
  if ! validate_write_task "$reuse_id" "$reuse_file" "$reuse_msg"; then
    return 1
  fi
  local reuse_worktree
  reuse_worktree="$(node "$SWARM_JS" status --id "$reuse_id" | node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8")||"{}");process.stdout.write(String((d.task||{}).worktree||""));')"
  if [[ "$reuse_worktree" != "$parent_worktree" ]]; then
    echo "[ERROR] followup reuse should use parent worktree: $reuse_id"
    return 1
  fi
  echo "[OK] followup reuse verified: $reuse_id"
}

verify_fail=0
for item in "${WRITE_CASES[@]}"; do
  IFS='|' read -r task_id expected_file expected_msg <<< "$item"
  if ! validate_write_task "$task_id" "$expected_file" "$expected_msg"; then
    verify_fail=1
  fi
done
if (( ${#READ_CASES[@]} > 0 )); then
  for task_id in "${READ_CASES[@]}"; do
    if ! validate_read_task "$task_id"; then
      verify_fail=1
    fi
  done
else
  echo "[ERROR] no read tasks generated; increase concurrency"
  verify_fail=1
fi

if (( verify_fail != 0 )); then
  echo "[ERROR] regression verification failed"
  exit 1
fi

if ! run_attach_cancel_case "codex"; then
  exit 1
fi
if ! run_attach_cancel_case "claude"; then
  exit 1
fi

PARENT_TASK_ID="${PREFIX}-codex-write1"
if ! run_followup_cases "$PARENT_TASK_ID" "codex"; then
  exit 1
fi

echo "[PASS] batch concurrency regression passed (success-only + attach/cancel + followup new/reuse)"
