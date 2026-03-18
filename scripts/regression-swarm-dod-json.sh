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
  RUN_X=(bun)
elif command -v npx >/dev/null 2>&1; then
  RUN_X=(npx -y tsx@4.20.6)
else
  echo "ERROR: runtime required. Install bun or npx (for tsx fallback)." >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "ERROR: node is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "ERROR: tmux is required" >&2; exit 1; }

AGENTS_RAW="${AGENTS:-codex,claude,gemini}"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/regression-swarm-dod-json.sh [--agents codex,claude,gemini]

Options:
  --agents  Comma-separated agent list. Default: codex,claude,gemini (or AGENTS env)
  -h,--help Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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
  "${RUN_X[@]}" "$SWARM_TS" "$@"
}

swarm_json() {
  local label="$1"
  shift
  local out
  echo "[SWARM][CALL] $label :: $*" >&2
  if ! out="$(run_swarm "$@" 2>&1)"; then
    echo "[SWARM][RET][FAIL] $label" >&2
    echo "$out" >&2
    return 1
  fi
  echo "[SWARM][RET][OK] $label" >&2
  echo "$out" >&2
  printf '%s' "$out"
}

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

dod_field_of() {
  local task_id="$1"
  local field="$2"
  local task_json
  local enc
  enc="$(node -p "encodeURIComponent(process.argv[1])" "$task_id")"
  task_json="$STATE_DIR/${enc}.json"
  TASK_JSON="$task_json" FIELD_PATH="$field" node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.env.TASK_JSON, "utf8"));
const path = String(process.env.FIELD_PATH || "").split(".");
let cur = data;
for (const key of path) {
  if (!key) continue;
  if (!cur || typeof cur !== "object" || !(key in cur)) {
    process.stdout.write("");
    process.exit(0);
  }
  cur = cur[key];
}
if (typeof cur === "object") process.stdout.write(JSON.stringify(cur));
else process.stdout.write(String(cur ?? ""));
'
}

task_json_path() {
  local task_id="$1"
  local enc
  enc="$(node -p "encodeURIComponent(process.argv[1])" "$task_id")"
  printf '%s/%s.json' "$STATE_DIR" "$enc"
}

get_task_field() {
  local task_id="$1"
  local field="$2"
  local task_json
  task_json="$(task_json_path "$task_id")"
  if [[ ! -f "$task_json" ]]; then
    return 1
  fi
  TASK_JSON="$task_json" FIELD_PATH="$field" node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.env.TASK_JSON, "utf8"));
const path = String(process.env.FIELD_PATH || "").split(".");
let cur = data;
for (const key of path) {
  if (!key) continue;
  if (!cur || typeof cur !== "object" || !(key in cur)) {
    process.stdout.write("");
    process.exit(0);
  }
  cur = cur[key];
}
if (typeof cur === "object") process.stdout.write(JSON.stringify(cur));
else process.stdout.write(String(cur ?? ""));
'
}

print_task_result() {
  local task_id="$1"
  local pass="$2"
  local note="$3"
  local task_json
  local log_path
  local worktree
  task_json="$(task_json_path "$task_id")"
  log_path="$(get_task_field "$task_id" "log" || true)"
  worktree="$(get_task_field "$task_id" "worktree" || true)"
  echo "[RESULT][TASK] task=$task_id pass=$pass note=$note"
  echo "[RESULT][PATH] task=$task_id task_json=$task_json"
  echo "[RESULT][PATH] task=$task_id log=${log_path:-missing}"
  echo "[RESULT][PATH] task=$task_id worktree=${worktree:-missing}"
}

wait_status() {
  local task_id="$1"
  local expected="$2"
  local timeout_sec="${3:-180}"
  local start_ts now_ts elapsed json st
  start_ts="$(date +%s)"
  while true; do
    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    json="$(swarm_json "check:$task_id" check --json)"
    st="$(status_of "$json" "$task_id")"
    if [[ "$st" == "$expected" ]]; then
      return 0
    fi
    if (( elapsed >= timeout_sec )); then
      echo "[ERROR] timeout waiting status=$expected task=$task_id current=$st"
      return 1
    fi
    sleep 5
  done
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "[ERROR] assert failed: $msg (expected=$expected actual=$actual)"
    return 1
  fi
  return 0
}

json_field_from_text() {
  local json="$1"
  local field="$2"
  JSON_INPUT="$json" FIELD_PATH="$field" node -e '
const data = JSON.parse(process.env.JSON_INPUT || "{}");
const path = String(process.env.FIELD_PATH || "").split(".");
let cur = data;
for (const key of path) {
  if (!key) continue;
  if (!cur || typeof cur !== "object" || !(key in cur)) {
    process.stdout.write("");
    process.exit(0);
  }
  cur = cur[key];
}
if (typeof cur === "object") process.stdout.write(JSON.stringify(cur));
else process.stdout.write(String(cur ?? ""));
'
}

run_agent_cases() {
  local agent="$1"
  local prefix="$2"
  local repo="$3"

  local task1 task2 task3 task4
  task1="${prefix}-batch-ci-pass"
  task2="${prefix}-interactive-pending-no-push-pr"
  task3="${prefix}-batch-ahead-pass"
  task4="${prefix}-batch-ahead-fail"

  swarm_json "spawn:$task1" spawn \
    --repo "$repo" \
    --agent "$agent" \
    --mode batch \
    --name "$task1" \
    --ci-commands "git status --porcelain" \
    --task "批处理只读：列出仓库根目录文件并给一句总结，不要修改任何文件，完成后退出。" >/dev/null
  wait_status "$task1" "success" 240
  assert_eq "pass" "$(dod_field_of "$task1" "dod.status")" "${agent} case1 dod pass"
  print_task_result "$task1" "true" "${agent} case1 batch_ci_pass"

  swarm_json "spawn:$task3" spawn \
    --repo "$repo" \
    --agent "$agent" \
    --mode batch \
    --name "$task3" \
    --dod-json '{"require_commits_ahead_base":true}' \
    --task '批处理写任务：在仓库根目录创建 REG_DOD_AHEAD_PASS.md，写一行文本并提交 commit，提交信息为 "test: dod ahead pass"，完成后退出。' >/dev/null
  wait_status "$task3" "success" 240
  assert_eq "pass" "$(dod_field_of "$task3" "dod.status")" "${agent} case3 dod pass with ahead commits"
  print_task_result "$task3" "true" "${agent} case3 batch_ahead_pass"

  swarm_json "spawn:$task4" spawn \
    --repo "$repo" \
    --agent "$agent" \
    --mode batch \
    --name "$task4" \
    --dod-json '{"require_commits_ahead_base":true}' \
    --task "批处理只读：列出仓库根目录文件并给一句总结，不要修改任何文件，完成后退出。" >/dev/null
  wait_status "$task4" "success" 240
  assert_eq "fail" "$(dod_field_of "$task4" "dod.status")" "${agent} case4 dod fail without ahead commits"
  assert_eq "no_commits_ahead_base" "$(dod_field_of "$task4" "dod.result.reason")" "${agent} case4 fail reason"
  print_task_result "$task4" "true" "${agent} case4 batch_ahead_fail_expected"

  list_out="$(swarm_json "list:${agent}" list)"
  assert_eq "true" "$(json_field_from_text "$list_out" "ok")" "${agent} list ok"
  status_id_out="$(swarm_json "status:${task1}" status --id "$task1")"
  assert_eq "true" "$(json_field_from_text "$status_id_out" "ok")" "${agent} status id ok"
  status_query_out="$(swarm_json "status-query:${task1}" status --query "$task1")"
  assert_eq "true" "$(json_field_from_text "$status_query_out" "ok")" "${agent} status query ok"

  swarm_json "spawn-followup-new:${task4}" spawn-followup \
    --from "$task4" \
    --session-mode new \
    --name "${task4}-followup-new" \
    --task "followup new: 批处理只读检查，输出一句总结后退出。" >/dev/null
  wait_status "${task4}-followup-new" "success" 240
  print_task_result "${task4}-followup-new" "true" "${agent} followup_new_success"

  swarm_json "spawn-followup-reuse:${task4}" spawn-followup \
    --from "$task4" \
    --session-mode reuse \
    --name "${task4}-followup-reuse" \
    --task "followup reuse: 批处理只读检查，输出一句总结后退出。" >/dev/null
  wait_status "${task4}-followup-reuse" "success" 240
  print_task_result "${task4}-followup-reuse" "true" "${agent} followup_reuse_success"

  publish_out="$(swarm_json "publish:${task3}" publish --id "$task3")"
  assert_eq "true" "$(json_field_from_text "$publish_out" "ok")" "${agent} publish ok"
  assert_eq "true" "$(json_field_from_text "$publish_out" "publish.ok")" "${agent} publish.push ok"
  pr_out="$(swarm_json "create-pr:${task3}" create-pr --id "$task3")"
  assert_eq "true" "$(json_field_from_text "$pr_out" "ok")" "${agent} create-pr call ok"
  print_task_result "$task3" "true" "${agent} publish_create_pr_checked"

  swarm_json "spawn:$task2" spawn \
    --repo "$repo" \
    --agent "$agent" \
    --mode interactive \
    --name "$task2" \
    --dod-json '{"allowed_statuses":["pending","success"],"ci_commands":["git status --porcelain"],"push_command":"touch .dod_push_done","pr_command":"touch .dod_pr_done"}' \
    --task "交互只读：列出仓库根目录文件并给一句总结；完成后保持会话等待，不要退出。" >/dev/null
  wait_status "$task2" "pending" 240
  assert_eq "pass" "$(dod_field_of "$task2" "dod.status")" "${agent} case2 dod pass in pending"
  assert_eq "false" "$(dod_field_of "$task2" "dod.result.actions.push.executed")" "${agent} case2 pending no push"
  assert_eq "false" "$(dod_field_of "$task2" "dod.result.actions.pr.executed")" "${agent} case2 pending no pr"

  swarm_json "cancel:$task2" cancel --id "$task2" --reason "regression_dod_pending_to_success" >/dev/null
  wait_status "$task2" "success" 120
  assert_eq "true" "$(dod_field_of "$task2" "dod.result.actions.push.executed")" "${agent} case2 success push executed"
  assert_eq "true" "$(dod_field_of "$task2" "dod.result.actions.pr.executed")" "${agent} case2 success pr executed"
  print_task_result "$task2" "true" "${agent} case2 interactive_pending_then_success"
}

echo "[INFO] agents: ${AGENTS_LIST[*]}"

for agent in "${AGENTS_LIST[@]}"; do
  PREFIX="regdod-${agent}-$(date +%Y%m%d-%H%M%S)-$RANDOM"
  TMP_REPO="$(mktemp -d "/tmp/swarm-regdod-${agent}-XXXXXX")"
  REMOTE_REPO_DIR=""
  cleanup_repo() {
    rm -rf "$TMP_REPO"
    [[ -n "$REMOTE_REPO_DIR" ]] && rm -rf "$REMOTE_REPO_DIR"
  }
  trap cleanup_repo EXIT

  echo "[INFO] temp repo: $TMP_REPO"
  echo "[INFO] agent: $agent"

  git -C "$TMP_REPO" init -q
  git -C "$TMP_REPO" config user.name "swarm-regdod"
  git -C "$TMP_REPO" config user.email "swarm-regdod@example.com"
  cat > "$TMP_REPO/README.md" <<'EOT'
# swarm dod json regression temp repo
EOT
  git -C "$TMP_REPO" add README.md
  git -C "$TMP_REPO" commit -q -m "chore: init temp repo"
  REMOTE_REPO_DIR="$(mktemp -d "/tmp/swarm-regdod-remote-${agent}-XXXXXX")"
  REMOTE_REPO="$REMOTE_REPO_DIR/origin.git"
  git init --bare -q "$REMOTE_REPO"
  git -C "$TMP_REPO" remote add origin "$REMOTE_REPO"

  run_agent_cases "$agent" "$PREFIX" "$TMP_REPO"

  rm -rf "$REMOTE_REPO_DIR"
  rm -rf "$TMP_REPO"
  trap - EXIT
done

echo "[PASS] DoD JSON regression cases passed"
echo "[SUMMARY][OVERALL] dod-json regression=pass"
