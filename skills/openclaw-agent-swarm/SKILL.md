---
name: openclaw-agent-swarm
description: Spawn coding agents (codex/claude/gemini) in parallel across isolated git worktrees for async background execution. Use when user mentions "run in background", "parallel tasks", "spawn agents", "worktree tasks", "async execution", or wants to work on multiple features simultaneously. Fire-and-forget by default - spawn tasks and return immediately.
---

# Agent Swarm

Run coding tasks asynchronously in isolated git worktrees with automatic status tracking, Definition of Done (DoD) validation, and PR creation.

## What This Skill Does

This skill spawns coding agents (codex, claude, or gemini) in isolated git worktrees running inside tmux sessions. Each task runs independently in the background, allowing you to work on multiple features or fixes in parallel without blocking your main workflow.

Key capabilities:
- Spawn tasks in isolated worktrees (no conflicts with your main branch)
- Two modes: `interactive` (you can send follow-up messages) or `batch` (fire-and-forget)
- Automatic status tracking and change notifications
- Definition of Done validation (`dod_spec`: status/clean/commit/CI checks)
- Automatic git push and PR/MR creation when tasks complete
- Follow-up tasks that reuse or create new worktrees

## When to Use This Skill

Use this skill when you need to:
- Run multiple coding tasks in parallel without blocking each other
- Execute long-running tasks in the background while you continue working
- Isolate experimental changes in separate worktrees
- Automatically validate task completion with CI commands
- Create PRs/MRs automatically after task completion

Don't use this for:
- Simple, quick edits in your current directory (just do them directly)
- Tasks that need immediate interactive feedback (unless using interactive mode)
- Non-git repositories (this skill requires git)

## Prerequisites

Before using this skill, verify these tools are installed:
- `git` (required)
- `tmux` (required)
- At least one agent: `codex`, `claude`, or `gemini` (required)
- Runtime for executing `swarm.ts`: `bun` (preferred) or `npx` (fallback to `npx -y tsx@4.20.6`)
- Optional: `gh` (GitHub CLI) or `glab` (GitLab CLI) for automatic PR creation

Resolve `${RUN_X}` runtime once in your shell:

```bash
if command -v bun >/dev/null 2>&1; then
  RUN_X=(bun)
elif command -v npx >/dev/null 2>&1; then
  RUN_X=(npx -y tsx@4.20.6)
else
  echo "runtime is required. Install bun or npx (for tsx fallback)." >&2
  exit 1
fi
```

## Quick Start

```bash
# Spawn a task (returns immediately with task ID)
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo /path/to/your/repo \
  --task "Add error handling to the login function" \
  --mode batch
```

See **Common Workflows** below for detailed usage patterns.

## Core Concepts

### Task Modes

**Batch mode** (default):
- Agent runs the prompt once and exits
- Task succeeds if exit code is 0, fails otherwise
- Best for: well-defined tasks, automated workflows, CI-like operations

**Interactive mode**:
- Agent stays running, you can send follow-up messages via `attach`
- Task stays in `running` or `pending` state until you manually stop it
- Best for: exploratory work, iterative refinement, complex debugging

### Task Status Lifecycle

```
running ↔ pending → success/failed/stopped (terminal states)
```

- `running`: Agent is actively working
- `pending`: Interactive mode, agent waiting for input
- `success`: Batch mode completed with exit code 0
- `failed`: Task failed (non-zero exit code or error)
- `stopped`: Task was cancelled or tmux session died

### Definition of Done (DoD)

DoD is evaluated automatically when task status transitions to `pending` or `success`:

**Default DoD checks:**
1. Current status is in `dod_spec.checks.allowed_statuses` (default: `pending`, `success`)
2. Worktree is clean (default enabled)
3. Optional: current branch has commits ahead of `base_branch`
4. All `dod_spec.checks.ci_commands` pass (if specified)
5. On `success` only: execute `dod_spec.actions.push_command` and `dod_spec.actions.pr_command` (if non-empty)

Notes:
- If you do not want auto-push, set `dod_spec.actions.push_command` to an empty string.
- If `dod_spec.actions.push_command` and/or `dod_spec.actions.pr_command` is empty, only remind/suggest manual `publish`/`create-pr`; do not auto-run those commands.
- For GitHub CLI, a common PR command is `gh pr create --fill --base main --head "$(git rev-parse --abbrev-ref HEAD)"`.

**DoD status:**
- `pass`: Task completed successfully and met all criteria
- `fail`: Task didn't meet DoD criteria

Only tasks with `dod.status=pass` can be published.

### Follow-up Tasks

When a task fails or needs more work, spawn a follow-up:

**New session** (`--session-mode new`):
- Reuses the same worktree but starts fresh agent session
- Use when you want a clean slate but keep the code changes

**Reuse session** (`--session-mode reuse`):
- Continues the previous agent's conversation
- Use when you want to build on the previous context
- Must use the same agent as parent task

## Script Locations

Determine `SKILL_DIR` as the directory containing this SKILL.md file.

- Main script: `$SKILL_DIR/scripts/swarm.ts`
- Check wrapper: `$SKILL_DIR/scripts/check-agents.sh`
- DoD spec example: `$SKILL_DIR/references/dod.json`
- State format: `$SKILL_DIR/references/state-format.md` (JSON schemas)

## Agent Behavior Guidelines

**IMPORTANT: Fire-and-Forget Pattern**

When using this skill, follow these rules:

1. **Spawn and Return**: After running `spawn`, immediately return to the user with the task info (id, status, worktree). Do NOT poll, wait, or loop to check status.

2. **Never Proactively Check**: The `check` command is designed for system cron/heartbeat jobs, not for agent-initiated polling. Do NOT call `check` or `status` after spawn unless:
   - User explicitly asks about task status
   - System heartbeat/cron provides check results to you

3. **Trust Async Execution**: Tasks run independently in background. Your job is to spawn and inform, not to monitor.

4. **User-Driven Follow-up**: Only query task status when the user asks. Use `status --id <task-id>` for specific tasks or `list` for overview.

**Example of Correct Behavior**:
```
User: "帮我并行跑三个任务"
Agent: [spawns 3 tasks, returns immediately]
"已启动 3 个异步任务:
- task-1 (id: 20260323-xxx): Fix bug #123
- task-2 (id: 20260323-yyy): Add dark mode
- task-3 (id: 20260323-zzz): Update deps

任务正在后台运行，如需查看状态请告诉我。"
```

## Commands Reference

### Repository Path Resolution (Required)

Before running `spawn`, resolve `--repo` using this rule:

1. If user input is an existing absolute/relative directory path, use it directly.
2. If user input is a fuzzy name (for example `yyy`), search candidate directories by basename (for example any directory named `yyy`) across likely work roots first.
3. If exactly one git repo candidate is found, report the resolved full path and proceed.
4. If multiple candidates are found, list numbered options and ask the user to reply with the option number only. Do not ask them to type the full path.
5. Only run `spawn` after this repo path is confirmed.

Suggested search behavior:
- Prioritize current workspace and common project roots (such as `~/projects`, `~/work`, `~/code`) before broad home-directory scans.
- For each candidate, verify it is a git repository before presenting it.

### spawn - Create New Task

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo <path> \
  --task "<description>" \
  [--mode interactive|batch] \
  [--agent codex|claude|gemini] \
  [--name <custom-task-id>] \
  [--ci-commands "<command-1,command-2>"] \
  [--dod-json '{"checks":{"ci_commands":["npm test"],"require_commits_ahead_base":true}}'] \
  [--dod-json-file "$SKILL_DIR/references/dod.json"]
```

**Parameters:**
- `--repo`: Path to git repository (required)
- `--task`: Task description for the agent (required)
- `--mode`: `batch` (default) or `interactive`
- `--agent`: Which agent to use (auto-detected if not specified)
- `--name`: Custom task ID (auto-generated if not specified)
- `--ci-commands`: CI commands for DoD (comma/newline separated; repeatable)
- `--dod-json`: Inline DoD spec JSON object (must use `checks`/`actions` fields)
- `--dod-json-file`: Path to DoD spec JSON file

**Output:** JSON with task details including `id`, `worktree`, `branch`, `tmux_session`

**Example:**
```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Fix the memory leak in the cache module" \
  --mode batch \
  --ci-commands "npm run lint,npm test -- --run" \
  --dod-json-file "$SKILL_DIR/references/dod.json"
```

### spawn-followup - Continue Failed/Stopped Task

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn-followup \
  --from <parent-task-id> \
  --task "<new-instructions>" \
  --session-mode new|reuse \
  [--agent codex|claude|gemini] \
  [--name <custom-task-id>] \
  [--ci-commands "<command-1,command-2>"] \
  [--dod-json '{"checks":{"allowed_statuses":["pending","success"]}}'] \
  [--dod-json-file "$SKILL_DIR/references/dod.json"]
```

**Parameters:**
- `--from`: Parent task ID (required)
- `--task`: New instructions for the follow-up (required)
- `--session-mode`: `new` (fresh session) or `reuse` (continue conversation) (required)
- `--agent`: Agent to use (for `new` mode; `reuse` must match parent)
- `--name`: Custom task ID (auto-generated if not specified)
- `--ci-commands`: Extra/override CI commands merged into follow-up `dod_spec`

**Example:**
```bash
# Parent task failed, spawn follow-up with fresh session
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn-followup \
  --from 20260316-143022-a1b2c3 \
  --task "The previous attempt failed because of missing imports. Fix the imports and try again." \
  --session-mode new \
  --dod-json-file "$SKILL_DIR/references/dod.json"
```

### attach - Send Message to Interactive Task

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" attach \
  --id <task-id> \
  --message "<text>"
```

**Only works for interactive mode tasks that are not yet terminal.**

**Example:**
```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" attach \
  --id 20260316-143022-a1b2c3 \
  --message "Also add unit tests for the new function"
```

### check - System Heartbeat Task (NOT for Agent Polling)

**This command is designed for system cron/heartbeat jobs only. Agents should NOT call this.**

```bash
# For system heartbeat/cron only:
bash "$SKILL_DIR/scripts/check-agents.sh"
```

Or directly:
```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" check --changes-only
```

**What it does:**
- Refreshes status for non-terminal tasks when needed:
  - interactive: tmux session is gone, or log has been quiet long enough
  - batch: running duration reaches timeout threshold
- Returns only tasks that changed status since last check
- Updates DoD when tasks reach terminal status
- Archives old terminal tasks (default: 24 hours)
- Tracks reminder counts for long-running/pending tasks

**When agents receive check results:**
- System heartbeat runs `check-agents.sh` periodically
- If tasks changed status, heartbeat passes results to agent
- Agent can then notify user about completed/failed tasks

**DO NOT call check after spawn.** Let system heartbeat handle it.

### status - Get Task Details

```bash
# Get specific task (always refreshes status)
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id <task-id>

# Search by query (branch name, task description, etc.)
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --query "login"

# Get latest 10 tasks (no refresh)
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status
```

**Output:** Task summary with `next_step` guidance in Chinese.

### list - Show All Active Tasks

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" list
```

Returns all tasks in `~/.agents/agent-swarm/tasks/` (excludes archived tasks).

### publish - Push Branch to Remote

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" publish \
  --id <task-id> \
  [--remote origin] \
  [--target-branch main] \
  [--auto-pr] \
  [--title "PR title"] \
  [--body "PR description"]
```

**Requirements:**
- Task must have `dod.status=pass`

**With `--auto-pr`:** Automatically creates PR/MR after successful push.

### create-pr - Create PR/MR

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" create-pr \
  --id <task-id> \
  [--remote origin] \
  [--target-branch main] \
  [--title "PR title"] \
  [--body "PR description"]
```

Pushes branch first, then creates PR using `gh` (GitHub) or `glab` (GitLab) if available. Falls back to manual URL if CLI not found.

### cancel - Stop Running Task

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" cancel \
  --id <task-id> \
  [--reason "why you're cancelling"]
```

Kills the tmux session and sets task status:
- Usually `stopped`
- `success` when task is interactive and currently `pending`

## Common Workflows

### Workflow 1: Simple Batch Task (Fire-and-Forget)

```bash
# Spawn task and return immediately
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Add logging to the payment processor" \
  --mode batch

# Returns: {"id": "20260323-xxx", "status": "running", ...}
# Agent should inform user and STOP HERE. No polling.
```

**Later, when user asks or heartbeat provides check results:**
```bash
# User asks: "任务完成了吗？"
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id 20260323-xxx

# Or heartbeat/cron runs and provides changes:
# System runs: bash "$SKILL_DIR/scripts/check-agents.sh"
# If task changed, agent receives the info and can notify user

# When task succeeded, user may want to publish:
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" publish \
  --id 20260323-xxx \
  --auto-pr
```

### Workflow 2: Interactive Task (User-Driven)

```bash
# 1. Spawn interactive task
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Refactor the authentication module" \
  --mode interactive
# Returns immediately with task id
```

**Later, when user provides follow-up instructions:**
```bash
# User says: "让 agent 也更新测试"
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" attach \
  --id <task-id> \
  --message "Also update the tests to match the new structure"
```

**When user wants to finish:**
```bash
# User asks: "完成了吗？帮我停止"
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id <task-id>
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" cancel --id <task-id>

# If DoD passes, publish
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" publish --id <task-id> --auto-pr
```

### Workflow 3: Parallel Tasks (Fire-and-Forget)

```bash
# Spawn multiple tasks - return immediately after all spawns
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Fix bug #123 in checkout flow" \
  --mode batch

"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Add dark mode support to settings page" \
  --mode batch

"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Update dependencies to latest versions" \
  --mode batch

# Returns: 3 task IDs. Agent informs user and STOPS.
# DO NOT call check here. Let system heartbeat handle it.
```

**When user asks status or heartbeat provides updates:**
```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" list
# Or for specific task:
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id <task-id>
```

### Workflow 4: Failed Task Recovery

```bash
# 1. Task failed, check what happened
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id <failed-task-id>

# 2. Read the log to understand the failure
cat ~/.agents/agent-swarm/logs/<task-id>.log | tail -100

# 3. Spawn follow-up with fix instructions
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn-followup \
  --from <failed-task-id> \
  --task "The test failed because of missing mock data. Add the mock data and rerun tests." \
  --session-mode new \
  --dod-json-file "$SKILL_DIR/references/dod.json"
```

## How It Works

Tasks run in isolated git worktrees inside tmux sessions. For internal architecture details (directory structure, task state JSON, DoD evaluation), see `$SKILL_DIR/references/architecture.md`.

## Advanced Usage

For advanced patterns (custom DoD, worktree reuse, automatic reminders), see `$SKILL_DIR/references/advanced.md`.

## Integration with Heartbeat/Cron

Add this to your `HEARTBEAT.md` or cron:

```bash
bash "$SKILL_DIR/scripts/check-agents.sh"
```

This returns JSON with `changes` array showing tasks that changed status.

## Troubleshooting

For common issues, tips, and limitations, see `$SKILL_DIR/references/troubleshooting.md`.

## Reference Files

- `$SKILL_DIR/references/state-format.md` - Task JSON field documentation
- `$SKILL_DIR/references/dod.json` - DoD spec example
- `$SKILL_DIR/references/architecture.md` - Internal architecture details
- `$SKILL_DIR/references/advanced.md` - Advanced usage patterns
- `$SKILL_DIR/references/troubleshooting.md` - Common issues and tips
