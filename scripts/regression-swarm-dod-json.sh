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
command -v tmux >/dev/null 2>&1 || { echo "ERROR: tmux is required" >&2; exit 1; }

if command -v codex >/dev/null 2>&1; then
  AGENT="codex"
elif command -v claude >/dev/null 2>&1; then
  AGENT="claude"
elif command -v gemini >/dev/null 2>&1; then
  AGENT="gemini"
else
  echo "ERROR: one of codex/claude/gemini is required" >&2
  exit 1
fi

run_swarm() {
  "${BUN_X[@]}" "$SWARM_TS" "$@"
}

PREFIX="regdod-$(date +%Y%m%d-%H%M%S)-$RANDOM"
TMP_REPO="$(mktemp -d "/tmp/swarm-regdod-XXXXXX")"

cleanup() {
  rm -rf "$TMP_REPO"
}
trap cleanup EXIT

echo "[INFO] temp repo: $TMP_REPO"
echo "[INFO] agent: $AGENT"

git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" config user.name "swarm-regdod"
git -C "$TMP_REPO" config user.email "swarm-regdod@example.com"
cat > "$TMP_REPO/README.md" <<'EOT'
# swarm dod json regression temp repo
EOT
git -C "$TMP_REPO" add README.md
git -C "$TMP_REPO" commit -q -m "chore: init temp repo"

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

wait_status() {
  local task_id="$1"
  local expected="$2"
  local timeout_sec="${3:-180}"
  local start_ts now_ts elapsed json st
  start_ts="$(date +%s)"
  while true; do
    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    json="$(run_swarm check --json)"
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
    exit 1
  fi
}

# Case 1: ci_commands from CLI should execute and pass.
TASK1="${PREFIX}-batch-ci-pass"
run_swarm spawn \
  --repo "$TMP_REPO" \
  --agent "$AGENT" \
  --mode batch \
  --name "$TASK1" \
  --ci-commands "git status --porcelain" \
  --task "批处理只读：列出仓库根目录文件并给一句总结，不要修改任何文件，完成后退出。" >/dev/null
wait_status "$TASK1" "success" 240
assert_eq "pass" "$(dod_field_of "$TASK1" "dod.status")" "case1 dod pass"

# Case 2: pending should run DoD checks but must not execute push/pr commands.
TASK2="${PREFIX}-interactive-pending-no-push-pr"
run_swarm spawn \
  --repo "$TMP_REPO" \
  --agent "$AGENT" \
  --mode interactive \
  --name "$TASK2" \
  --dod-json '{"allowed_statuses":["pending","success"],"ci_commands":["git status --porcelain"],"push_command":"touch .dod_push_done","pr_command":"touch .dod_pr_done"}' \
  --task "交互只读：列出仓库根目录文件并给一句总结；完成后保持会话等待，不要退出。" >/dev/null
wait_status "$TASK2" "pending" 240
assert_eq "pass" "$(dod_field_of "$TASK2" "dod.status")" "case2 dod pass in pending"
assert_eq "false" "$(dod_field_of "$TASK2" "dod.result.actions.push.executed")" "case2 pending no push"
assert_eq "false" "$(dod_field_of "$TASK2" "dod.result.actions.pr.executed")" "case2 pending no pr"

# On cancel, status becomes success and push/pr should execute.
run_swarm cancel --id "$TASK2" --reason "regression_dod_pending_to_success" >/dev/null
wait_status "$TASK2" "success" 120
assert_eq "true" "$(dod_field_of "$TASK2" "dod.result.actions.push.executed")" "case2 success push executed"
assert_eq "true" "$(dod_field_of "$TASK2" "dod.result.actions.pr.executed")" "case2 success pr executed"

# Case 3: require_commits_ahead_base should pass for write task with commit.
TASK3="${PREFIX}-batch-ahead-pass"
run_swarm spawn \
  --repo "$TMP_REPO" \
  --agent "$AGENT" \
  --mode batch \
  --name "$TASK3" \
  --dod-json '{"require_commits_ahead_base":true}' \
  --task '批处理写任务：在仓库根目录创建 REG_DOD_AHEAD_PASS.md，写一行文本并提交 commit，提交信息为 "test: dod ahead pass"，完成后退出。' >/dev/null
wait_status "$TASK3" "success" 240
assert_eq "pass" "$(dod_field_of "$TASK3" "dod.status")" "case3 dod pass with ahead commits"

# Case 4: require_commits_ahead_base should fail for read-only task.
TASK4="${PREFIX}-batch-ahead-fail"
run_swarm spawn \
  --repo "$TMP_REPO" \
  --agent "$AGENT" \
  --mode batch \
  --name "$TASK4" \
  --dod-json '{"require_commits_ahead_base":true}' \
  --task "批处理只读：列出仓库根目录文件并给一句总结，不要修改任何文件，完成后退出。" >/dev/null
wait_status "$TASK4" "success" 240
assert_eq "fail" "$(dod_field_of "$TASK4" "dod.status")" "case4 dod fail without ahead commits"
assert_eq "no_commits_ahead_base" "$(dod_field_of "$TASK4" "dod.result.reason")" "case4 fail reason"

echo "[PASS] DoD JSON regression cases passed"
