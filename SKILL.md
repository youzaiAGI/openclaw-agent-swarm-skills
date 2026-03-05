---
name: openclaw-agent-swarm
description: Orchestrate background coding agents with git worktree + tmux, including task spawn, task follow-up (attach), and heartbeat-friendly status change reporting via check-agents.sh. Use when user wants one main OpenClaw agent to dispatch multiple coding tasks in parallel while continuing chat, enforce git-repo-only execution, detect Codex/Claude availability, and receive only incremental task status updates.
---

# OpenClaw Agent Swarm

Use this skill to run coding tasks as background jobs with `worktree + tmux` and manage them from the main chat.

## Hard Rules

1. Refuse execution when target directory is not a git repository.
2. Detect local tools before spawn:
   - If neither `codex` nor `claude` exists, stop and tell user to install at least one.
   - If user specifies `codex` or `claude`, honor it.
   - If user does not specify, auto-pick in order: `codex` then `claude`.
3. Keep main chat responsive: spawn task in background and return task id/session/worktree immediately.
4. For follow-up instructions on an existing task, use attach mode (send text into that tmux session).
5. Heartbeat/status reporting must be incremental: only report changed tasks since last check.
6. DoD uses default built-in validation only (no project-specific config/scripts):
   - status must be `success`
   - task branch has at least one commit ahead of base branch
   - worktree is clean (`git status --porcelain` empty)
7. Agent CLI is launched in non-interactive dangerous mode by default (to avoid blocking approvals in tmux background runs):
   - codex: `--dangerously-bypass-approvals-and-sandbox`
   - claude: `--dangerously-skip-permissions`

## Global task registry (cross-repo)

All tasks (repo A/B/C/...) are aggregated into one summary file:

- `~/.openclaw/agent-swarm/agent-swarm-tasks.json`

Each task records:
- repo path
- worktree path
- tmux session
- branch
- status
- log / exit file path

This enables one check script to monitor all tasks across repositories.

## Commands

All commands use `scripts/swarm.py`.

### 1) Spawn task

```bash
python3 /root/openclaw-skills/openclaw-agent-swarm/scripts/swarm.py spawn \
  --repo <git_repo_path> \
  --task "<task description>" \
  [--agent codex|claude] \
  [--name <task_name>]
```

### 2) Attach follow-up to existing task

```bash
python3 /root/openclaw-skills/openclaw-agent-swarm/scripts/swarm.py attach \
  --id <task_id> \
  --message "<extra instruction>"
```

### 3) List all tasks (from global registry)

```bash
python3 /root/openclaw-skills/openclaw-agent-swarm/scripts/swarm.py list
```

### 4) Check tasks (full)

```bash
python3 /root/openclaw-skills/openclaw-agent-swarm/scripts/swarm.py check
```

### 5) Check tasks (incremental changes only)

```bash
python3 /root/openclaw-skills/openclaw-agent-swarm/scripts/swarm.py check --changes-only
```

### 6) Heartbeat script (recommended)

```bash
bash /root/openclaw-skills/openclaw-agent-swarm/scripts/check-agents.sh
```

This wrapper returns only changes by default and is intended for heartbeat calls.

## Main-agent response style

After spawn, always return:
- task id
- selected agent
- repo path
- worktree path
- tmux session name
- branch

After attach, always return:
- target task id
- whether message was successfully sent

After check:
- If no changes: return a short “no task status changes” message.
- If changed: summarize only changed tasks with `from -> to` plus short result excerpt.
- Never dump raw JSON to user by default; convert to readable status cards.

Readable output template:
- 任务: `<task_id>` (`<agent>` | `<repo>`)
- 状态: `<from> -> <to>`
- 摘要: `<result_excerpt key points>`
- DoD: `pass/fail` + `reason`
- 下一步: `attach补充指令 / 重试 / 人工处理建议`

## Files used

Global registry and check state:
- `~/.openclaw/agent-swarm/agent-swarm-tasks.json`
- `~/.openclaw/agent-swarm/agent-swarm-last-check.json`

Global runtime files:
- `~/.openclaw/agent-swarm/logs/<task_id>.log`
- `~/.openclaw/agent-swarm/logs/<task_id>.exit`
- `~/.openclaw/agent-swarm/prompts/<task_id>.txt`

Global worktree root:
- `~/.openclaw/agent-swarm/worktree/<repo-name>/<task_id>`

See `references/state-format.md` for output JSON fields.