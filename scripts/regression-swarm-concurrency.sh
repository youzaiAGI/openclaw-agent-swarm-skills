#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWARM_TS="$ROOT_DIR/skills/openclaw-agent-swarm/scripts/swarm.ts"
STATE_DIR="$HOME/.agents/agent-swarm/tasks"

if [[ ! -f "$SWARM_TS" ]]; then
  echo "ERROR: swarm script not found: $SWARM_TS" >&2
  exit 1
fi

if command -v bun >/dev/null 2>&1; then
  BUN_X=(bun)
elif command -v npx >/dev/null 2>&1; then
  BUN_X=(npx -y bun)
else
  echo "ERROR: bun runtime is required. Install bun from https://bun.sh/" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 1; }

AGENTS_RAW="${AGENTS:-codex,claude,gemini}"
IFS=',' read -r -a AGENTS_INPUT <<< "$AGENTS_RAW"
declare -a AGENTS_LIST=()
for item in "${AGENTS_INPUT[@]}"; do
  agent="${item//[[:space:]]/}"
  [[ -z "$agent" ]] && continue
  case "$agent" in
    codex|claude|gemini) AGENTS_LIST+=("$agent") ;;
    *) echo "ERROR: unsupported agent in AGENTS: $agent (allowed: codex,claude,gemini)" >&2; exit 1 ;;
  esac
done
if [[ "${#AGENTS_LIST[@]}" -eq 0 ]]; then
  echo "ERROR: no valid agents selected. Set AGENTS like: codex,gemini" >&2
  exit 1
fi
for agent in "${AGENTS_LIST[@]}"; do
  command -v "$agent" >/dev/null 2>&1 || { echo "ERROR: $agent is required (selected via AGENTS)" >&2; exit 1; }
done

run_swarm() {
  "${BUN_X[@]}" "$SWARM_TS" "$@"
}

# policy knobs (script-side external timeout control)
BATCH_RUNNING_KILL_SEC=180
INTERACTIVE_LOG_QUIET_TO_PENDING_SEC=60
INTERACTIVE_CONTINUOUS_UPDATE_FAIL_SEC=180
POLL_SEC=5

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
echo "[INFO] agents: ${AGENTS_LIST[*]}"
echo "[INFO] workload: $((${#AGENTS_LIST[@]} * 4)) tasks (${AGENTS_LIST[*]} x batch/interactive x read/write)"
echo "[INFO] policy: batch running>${BATCH_RUNNING_KILL_SEC}s => cancel+FAIL"
echo "[INFO] policy: interactive quiet ${INTERACTIVE_LOG_QUIET_TO_PENDING_SEC}s => require status=pending => cancel => require success"
echo "[INFO] policy: interactive logs continuously updating>${INTERACTIVE_CONTINUOUS_UPDATE_FAIL_SEC}s => cancel+FAIL"

git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" config user.name "swarm-regression"
git -C "$TMP_REPO" config user.email "swarm-regression@example.com"
cat > "$TMP_REPO/README.md" <<'EOT'
# swarm regression temp repo
EOT
git -C "$TMP_REPO" add README.md
git -C "$TMP_REPO" commit -q -m "chore: init temp repo"

> "$TASKS_FILE"
for agent in "${AGENTS_LIST[@]}"; do
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$agent" "batch" "ro" "-" "-" \
    "批处理只读：列出仓库根目录文件并给一句总结，不要修改任何文件，完成后退出。" >> "$TASKS_FILE"

  if [[ "$agent" == "codex" ]]; then
    batch_file="REG_BATCH_CDX.md"
    batch_commit="test: codex batch write"
  elif [[ "$agent" == "claude" ]]; then
    batch_file="REG_BATCH_CLD.md"
    batch_commit="test: claude batch write"
  else
    batch_file="REG_BATCH_GMN.md"
    batch_commit="test: gemini batch write"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$agent" "batch" "write" "$batch_file" "$batch_commit" \
    "批处理写任务：在仓库根目录创建 ${batch_file}，写两行文本并提交 commit，提交信息为 \"${batch_commit}\"，完成后退出。" >> "$TASKS_FILE"

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$agent" "interactive" "ro" "-" "-" \
    "交互只读：列出仓库根目录文件并给一句总结；完成后保持会话等待，不要退出。" >> "$TASKS_FILE"

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$agent" "interactive" "write" "-" "-" \
    "交互写任务：在仓库根目录创建任意回归文件并提交 commit；完成后保持会话等待，不要退出。" >> "$TASKS_FILE"
done

declare -a TASK_IDS=()
declare -a BATCH_IDS=()
declare -a INTERACTIVE_IDS=()
declare -a SPAWN_PIDS=()
declare -a BATCH_WRITE_CASES=()
declare -a WRITE_IDS=()

i=0
while IFS=$'\t' read -r agent mode kind expected_file expected_msg task; do
  i=$((i + 1))
  task_id="${PREFIX}-${agent}-${mode}-${kind}"
  TASK_IDS+=("$task_id")
  if [[ "$mode" == "batch" ]]; then
    BATCH_IDS+=("$task_id")
  else
    INTERACTIVE_IDS+=("$task_id")
  fi
  if [[ "$mode" == "batch" && "$kind" == "write" ]]; then
    BATCH_WRITE_CASES+=("${task_id}|${expected_file}|${expected_msg}")
  fi
  if [[ "$kind" == "write" ]]; then
    WRITE_IDS+=("$task_id")
  fi

  (
    run_swarm spawn \
      --repo "$TMP_REPO" \
      --mode "$mode" \
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
echo "[PROGRESS] phase=spawn"
for id in "${TASK_IDS[@]}"; do
  echo "[PROGRESS][spawn] task=$id status=spawned"
done

status_of() {
  local json="$1"
  local id="$2"
  STATUS_INPUT_JSON="$json" TARGET_ID="$id" node -e '
const d = JSON.parse(process.env.STATUS_INPUT_JSON || "{}");
const id = String(process.env.TARGET_ID || "");
const t = (d.tasks || []).find(x => String(x.id || "") === id);
process.stdout.write(String((t && t.status) || "missing"));
'
}

dod_status_of() {
  local json="$1"
  local id="$2"
  STATUS_INPUT_JSON="$json" TARGET_ID="$id" node -e '
const d = JSON.parse(process.env.STATUS_INPUT_JSON || "{}");
const id = String(process.env.TARGET_ID || "");
const t = (d.tasks || []).find(x => String(x.id || "") === id);
const dod = t && t.dod && typeof t.dod === "object" ? t.dod : {};
process.stdout.write(String(dod.status || "missing"));
'
}

print_status_snapshot() {
  local phase="$1"
  local json="$2"
  shift 2
  for id in "$@"; do
    local st
    st="$(status_of "$json" "$id")"
    echo "[PROGRESS][$phase] task=$id status=$st"
  done
}

task_json_path() {
  local task_id="$1"
  local enc
  enc="$(node -p "encodeURIComponent(process.argv[1])" "$task_id")"
  printf '%s/%s.json' "$STATE_DIR" "$enc"
}

get_task_worktree() {
  local task_id="$1"
  local task_json
  task_json="$(task_json_path "$task_id")"
  if [[ ! -f "$task_json" ]]; then
    return 1
  fi
  node -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(t.worktree||''));" "$task_json"
}

get_task_log() {
  local task_id="$1"
  local task_json
  task_json="$(task_json_path "$task_id")"
  if [[ ! -f "$task_json" ]]; then
    return 1
  fi
  node -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(t.log||''));" "$task_json"
}

get_mtime() {
  local p="$1"
  if [[ -z "$p" || ! -e "$p" ]]; then
    echo 0
    return
  fi
  if stat -f %m "$p" >/dev/null 2>&1; then
    stat -f %m "$p"
    return
  fi
  if stat -c %Y "$p" >/dev/null 2>&1; then
    stat -c %Y "$p"
    return
  fi
  echo 0
}

validate_task_file_and_commit() {
  local task_id="$1"
  local expected_file="$2"
  local expected_msg="$3"
  local worktree
  worktree="$(get_task_worktree "$task_id" || true)"
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

validate_task_has_commit() {
  local task_id="$1"
  local worktree
  worktree="$(get_task_worktree "$task_id" || true)"
  if [[ -z "$worktree" || ! -d "$worktree" ]]; then
    echo "[ERROR] worktree missing for $task_id"
    return 1
  fi
  local commit_count
  commit_count="$(git -C "$worktree" rev-list --count HEAD 2>/dev/null || echo 0)"
  if [[ "$commit_count" =~ ^[0-9]+$ ]] && (( commit_count >= 2 )); then
    echo "[OK] $task_id commit count verified: $commit_count"
    return 0
  fi
  echo "[ERROR] expected extra commit for $task_id, got commit_count=$commit_count"
  return 1
}

cancel_task() {
  local id="$1"
  local reason="$2"
  local expected_statuses="${3:-stopped}"
  local out
  out="$(run_swarm cancel --id "$id" --reason "$reason")"
  local ok
  ok="$(CANCEL_JSON="$out" EXPECTED_STATUSES="$expected_statuses" node -e 'const d=JSON.parse(process.env.CANCEL_JSON||"{}");const expected=String(process.env.EXPECTED_STATUSES||"stopped").split(",").map(s=>s.trim()).filter(Boolean);const st=String(d.status||"");const ok=(Boolean(d.cancelled)&&expected.includes(st))||Boolean(d.already_terminal);process.stdout.write(String(ok));')"
  if [[ "$ok" != "true" ]]; then
    echo "[ERROR] cancel failed for $id (expected=${expected_statuses}): $out"
    return 1
  fi
  return 0
}

cancel_non_terminal_tasks() {
  local json
  json="$(run_swarm check --json)"
  for id in "${TASK_IDS[@]}"; do
    local st
    st="$(status_of "$json" "$id")"
    case "$st" in
      success|failed|stopped)
        ;;
      *)
        echo "[CLEANUP] cancel non-terminal task: $id (status=$st)"
        cancel_task "$id" "regression_failure_cleanup" || true
        ;;
    esac
  done
}

# 1) batch phase: must end in success; running >3min => cancel+FAIL
batch_fail=0
batch_pass_count=0
batch_fail_count=0
batch_start_ts="$(date +%s)"
while true; do
  json="$(run_swarm check --json)"
  now_ts="$(date +%s)"
  elapsed=$((now_ts - batch_start_ts))
  all_done=1
  row=""
  for id in "${BATCH_IDS[@]}"; do
    st="$(status_of "$json" "$id")"
    row+="$id:$st | "
    case "$st" in
      success)
        ;;
      failed|stopped)
        batch_fail=1
        ;;
      running|pending)
        all_done=0
        if (( elapsed >= BATCH_RUNNING_KILL_SEC )); then
          echo "[WARN] batch over ${BATCH_RUNNING_KILL_SEC}s, cancel: $id"
          cancel_task "$id" "batch_running_over_${BATCH_RUNNING_KILL_SEC}s" || true
          batch_fail=1
        fi
        ;;
      *)
        all_done=0
        ;;
    esac
  done
  echo "[CHECK][batch] +${elapsed}s ${row% | }"
  print_status_snapshot "batch" "$json" "${BATCH_IDS[@]}"

  if [[ "$all_done" -eq 1 ]]; then
    break
  fi
  if (( elapsed > BATCH_RUNNING_KILL_SEC + 120 )); then
    echo "[ERROR] batch phase watchdog timeout"
    batch_fail=1
    break
  fi
  sleep "$POLL_SEC"
done

json_batch_final="$(run_swarm check --json)"
for id in "${BATCH_IDS[@]}"; do
  st="$(status_of "$json_batch_final" "$id")"
  if [[ "$st" == "success" ]]; then
    batch_pass_count=$((batch_pass_count + 1))
  else
    batch_fail_count=$((batch_fail_count + 1))
  fi
done

for item in "${BATCH_WRITE_CASES[@]}"; do
  IFS='|' read -r task_id expected_file expected_msg <<< "$item"
  if ! validate_task_file_and_commit "$task_id" "$expected_file" "$expected_msg"; then
    batch_fail=1
  fi
done

if (( batch_fail != 0 )); then
  echo "[ERROR] batch requirement failed: all batch tasks must be success"
fi

# 2) interactive attach check
interactive_fail=0
interactive_pass_count=0
interactive_fail_count=0
declare -a INTERACTIVE_READY_IDS=()
for id in "${INTERACTIVE_IDS[@]}"; do
  attach_json="$(run_swarm attach --id "$id" --message "回归附加指令：请回复已收到并继续等待")"
  attach_sent="$(ATTACH_JSON="$attach_json" node -e 'const d=JSON.parse(process.env.ATTACH_JSON||"{}");process.stdout.write(String(Boolean(d.sent)));')"
  if [[ "$attach_sent" != "true" ]]; then
    echo "[ERROR] attach expected sent=true for running interactive task: $id"
    echo "[DEBUG] attach response: $attach_json"
    echo "[WARN] attach failed, cancel task to avoid leaked session: $id"
    cancel_task "$id" "attach_failed_cleanup" || true
    interactive_fail=1
    interactive_fail_count=$((interactive_fail_count + 1))
    continue
  fi
  echo "[OK] attach verified: $id"
  INTERACTIVE_READY_IDS+=("$id")
done

# 3) interactive case pass criteria (script-side):
#    - wait until log is quiet for 60s
#    - then status must be pending
#    - then cancel immediately
#    - then status must become success

wait_interactive_quiet_then_pending() {
  local id="$1"
  local logp="$2"
  local last_mtime last_change now_ts quiet_sec elapsed json st
  local start_ts
  start_ts="$(date +%s)"
  last_mtime="$(get_mtime "$logp")"
  last_change="$start_ts"

  while true; do
    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    cur_mtime="$(get_mtime "$logp")"
    if (( cur_mtime > last_mtime )); then
      last_mtime="$cur_mtime"
      last_change="$now_ts"
    fi
    quiet_sec=$((now_ts - last_change))

    json="$(run_swarm check --json)"
    st="$(status_of "$json" "$id")"
    echo "[CHECK][interactive] $id status=$st quiet=${quiet_sec}s elapsed=${elapsed}s"

    if (( quiet_sec >= INTERACTIVE_LOG_QUIET_TO_PENDING_SEC )); then
      if [[ "$st" != "pending" ]]; then
        echo "[ERROR] after log quiet ${INTERACTIVE_LOG_QUIET_TO_PENDING_SEC}s, status must be pending: $id => $st"
        cancel_task "$id" "interactive_not_pending_after_quiet" || true
        return 1
      fi
      return 0
    fi

    if (( elapsed >= INTERACTIVE_CONTINUOUS_UPDATE_FAIL_SEC )); then
      echo "[WARN] interactive log continuously updating>${INTERACTIVE_CONTINUOUS_UPDATE_FAIL_SEC}s, cancel+FAIL: $id"
      cancel_task "$id" "interactive_continuous_update_over_${INTERACTIVE_CONTINUOUS_UPDATE_FAIL_SEC}s" || true
      return 1
    fi

    sleep "$POLL_SEC"
  done
}

wait_task_status() {
  local id="$1"
  local expected_status="$2"
  local timeout_sec="${3:-60}"
  local start_ts now_ts elapsed json st
  start_ts="$(date +%s)"
  while true; do
    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    json="$(run_swarm check --json)"
    st="$(status_of "$json" "$id")"
    if [[ "$st" == "$expected_status" ]]; then
      return 0
    fi
    if (( elapsed >= timeout_sec )); then
      echo "[ERROR] timeout waiting ${expected_status}: $id => $st"
      cancel_task "$id" "interactive_timeout_wait_${expected_status}" "stopped,success" || true
      return 1
    fi
    sleep "$POLL_SEC"
  done
}

for id in "${INTERACTIVE_READY_IDS[@]}"; do
  logp="$(get_task_log "$id" || true)"
  if ! wait_interactive_quiet_then_pending "$id" "$logp"; then
    interactive_fail=1
    interactive_fail_count=$((interactive_fail_count + 1))
    continue
  fi
  echo "[OK] pending verified after quiet window: $id"

  if ! cancel_task "$id" "interactive_pending_verified_then_cancel" "success"; then
    interactive_fail=1
    interactive_fail_count=$((interactive_fail_count + 1))
    continue
  fi
  if ! wait_task_status "$id" "success" 60; then
    interactive_fail=1
    interactive_fail_count=$((interactive_fail_count + 1))
    continue
  fi
  echo "[OK] success verified after cancel: $id"
  interactive_pass_count=$((interactive_pass_count + 1))
done

if (( interactive_fail != 0 )); then
  echo "[ERROR] interactive requirement failed"
fi

total_pass=$((batch_pass_count + interactive_pass_count))
total_fail=$((batch_fail_count + interactive_fail_count))
echo "[SUMMARY] batch_pass=${batch_pass_count}/${#BATCH_IDS[@]} batch_fail=${batch_fail_count}/${#BATCH_IDS[@]}"
echo "[SUMMARY] interactive_pass=${interactive_pass_count}/${#INTERACTIVE_IDS[@]} interactive_fail=${interactive_fail_count}/${#INTERACTIVE_IDS[@]}"
echo "[SUMMARY] total_pass=${total_pass}/${#TASK_IDS[@]} total_fail=${total_fail}/${#TASK_IDS[@]}"
json_end="$(run_swarm check --json)"

# 4) all tasks must have DoD pass
dod_fail=0
for id in "${TASK_IDS[@]}"; do
  dod_st="$(dod_status_of "$json_end" "$id")"
  if [[ "$dod_st" != "pass" ]]; then
    echo "[ERROR] DoD not pass: $id dod=$dod_st"
    dod_fail=1
  else
    echo "[OK] DoD pass: $id"
  fi
done

# 5) all write tasks must have at least one extra commit
write_fail=0
for id in "${WRITE_IDS[@]}"; do
  if ! validate_task_has_commit "$id"; then
    write_fail=1
  fi
done

for id in "${TASK_IDS[@]}"; do
  st="$(status_of "$json_end" "$id")"
  echo "[SUMMARY][CASE] task=$id final_status=$st"
done

if (( batch_fail != 0 || interactive_fail != 0 || dod_fail != 0 || write_fail != 0 )); then
  cancel_non_terminal_tasks
  echo "[FAIL] regression failed"
  exit 1
fi
echo "[PASS] regression passed (batch=success, interactive=success)"
