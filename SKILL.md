---
name: openclaw-agent-swarm
description: Orchestrate parallel coding agents with git worktree + tmux. Supports spawn, follow-up (new/reuse worktree), attach mid-task instructions, heartbeat-driven incremental status checks, and concise progress cards for OpenClaw chat.
---

# OpenClaw Agent Swarm

Use this skill to run coding tasks as background tmux sessions with isolated git worktrees, while keeping OpenClaw chat responsive.

## Hard Rules

1. Refuse execution when target directory is not a git repository.
2. Detect local tools before spawn:
- If neither `codex` nor `claude` exists, stop and ask user to install at least one.
- If user specifies `codex` or `claude`, honor it.
- If user does not specify, auto-pick: `codex` first, then `claude`.
3. Keep main chat async: return spawn result immediately (task id/session/worktree/branch).
4. Agent runtime uses tmux interactive sessions, so follow-up instructions are sent via `attach`.
5. Heartbeat reporting must be incremental: only return changed tasks on each check.
6. DoD uses default built-in checks only:
- task status is `success`
- task branch has commits ahead of base branch
- worktree is clean (`git status --porcelain` empty)
7. If attaching to a non-running task, do not silently send. Return `requires_confirmation` with next action choices.

## Global state

Global task registry and heartbeat state:
- `~/.openclaw/agent-swarm/agent-swarm-tasks.json`
- `~/.openclaw/agent-swarm/agent-swarm-last-check.json`

Runtime artifacts:
- `~/.openclaw/agent-swarm/logs/<task_id>.log`
- `~/.openclaw/agent-swarm/logs/<task_id>.exit`
- `~/.openclaw/agent-swarm/prompts/<task_id>.txt`

Worktree root:
- `~/.openclaw/agent-swarm/worktree/<repo-name>/<task_id>`

## Commands

Set reusable root:

```bash
SKILL_ROOT="$HOME/.openclaw/skills/openclaw-agent-swarm"
```

Spawn task:

```bash
python3 "$SKILL_ROOT/scripts/swarm.py" spawn \
  --repo <git_repo_path> \
  --task "<task description>" \
  [--agent codex|claude] \
  [--name <task_name>]
```

Spawn follow-up task from existing task:

```bash
python3 "$SKILL_ROOT/scripts/swarm.py" spawn-followup \
  --from <task_id> \
  --task "<followup instruction>" \
  --worktree-mode new|reuse \
  [--agent codex|claude] \
  [--name <task_name>]
```

Attach extra instruction to running task:

```bash
python3 "$SKILL_ROOT/scripts/swarm.py" attach \
  --id <task_id> \
  --message "<extra instruction>"
```

Status query:

```bash
python3 "$SKILL_ROOT/scripts/swarm.py" status --id <task_id>
python3 "$SKILL_ROOT/scripts/swarm.py" status --query "<id|branch|session|keyword>"
```

List tasks:

```bash
python3 "$SKILL_ROOT/scripts/swarm.py" list
```

Check tasks (full or changes-only):

```bash
python3 "$SKILL_ROOT/scripts/swarm.py" check
python3 "$SKILL_ROOT/scripts/swarm.py" check --changes-only
```

Heartbeat wrapper:

```bash
bash "$SKILL_ROOT/scripts/check-agents.sh"
```

## Heartbeat Requirement

This skill expects OpenClaw heartbeat polling to be configured.

You must configure heartbeat in OpenClaw built-in `HEARTBEAT.md` (not this repo) to run:

```bash
bash "$HOME/.openclaw/skills/openclaw-agent-swarm/scripts/check-agents.sh"
```

Without heartbeat, task status transitions (`running -> success/failed/needs_human`) may not be updated in time.

## OpenClaw chat mapping

Natural language intents map to commands:
- “开个并发任务” -> `spawn`
- “看看这个任务进展” -> `status --id` or `status --query`
- “给这个任务补充要求” -> `attach`
- “如果结束了继续做” -> `spawn-followup --worktree-mode new|reuse` (ask user first)
- “轮询有没有变化” -> `check --changes-only`

Follow-up routing policy:
- If task is `running/awaiting_input`: use `attach`.
- If task is ended (`success/failed/stopped/needs_human`): do not attach directly.
- Return `requires_confirmation`, then ask user:
- New worktree: `spawn-followup --worktree-mode new`
- Reuse worktree: `spawn-followup --worktree-mode reuse` (guarded)

If query is ambiguous, return candidate tasks and ask user to pick one.

## Response style

For user-facing replies, convert JSON to concise cards. Do not dump raw JSON by default.

Card template:
- 任务: `<task_id>` (`<agent>` | `<repo>`)
- 状态: `<status>`
- 摘要: `<result_excerpt key points>`
- DoD: `pass/fail` + `reason`
- 下一步: `attach补充指令 / follow-up(new|reuse) / 人工处理`

See `references/state-format.md` for JSON fields.
