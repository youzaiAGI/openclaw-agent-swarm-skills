---
name: openclaw-agent-swarm
description: Run coding tasks in parallel using isolated git worktrees and background agents (codex/claude/gemini). Use this when the user wants to run tasks asynchronously, work on multiple features simultaneously, execute long-running coding tasks in the background, spawn parallel agents, or manage multiple coding tasks at once. Triggers include "run this in the background", "work on multiple tasks", "spawn agents", "run in parallel", "create worktree tasks", or any request to handle multiple coding tasks concurrently.
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

### Basic Workflow

1. **Spawn a task** - Creates isolated worktree and starts agent
2. **Check status** - See what's running and what changed
3. **Review results** - When task completes, check the output
4. **Publish** - Push to remote and optionally create PR

### Example: Spawn a Simple Task

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo /path/to/your/repo \
  --task "Add error handling to the login function" \
  --mode batch
```

This creates a new worktree, spawns an agent, and runs the task in the background.

### Example: Check What's Running

```bash
bash "$SKILL_DIR/scripts/check-agents.sh"
```

This shows only tasks that changed status since last check. Use this in a heartbeat/cron to get notifications.

### Example: Publish When Done

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" publish \
  --id <task_id> \
  --auto-pr
```

This pushes the branch and creates a PR automatically.

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
1. Current status is in `dod_spec.allowed_statuses` (default: `pending`, `success`)
2. Worktree is clean (default enabled)
3. Optional: current branch has commits ahead of `base_branch`
4. All `dod_spec.ci_commands` pass (if specified)
5. On `success` only: execute `dod_spec.push_command` and `dod_spec.pr_command` (if non-empty)

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

## Commands Reference

### spawn - Create New Task

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo <path> \
  --task "<description>" \
  [--mode interactive|batch] \
  [--agent codex|claude|gemini] \
  [--name <custom-task-id>] \
  [--ci-commands "<command-1,command-2>"] \
  [--dod-json '{"ci_commands":["npm test"],"require_commits_ahead_base":true}'] \
  [--dod-json-file "$SKILL_DIR/references/dod.json"]
```

**Parameters:**
- `--repo`: Path to git repository (required)
- `--task`: Task description for the agent (required)
- `--mode`: `batch` (default) or `interactive`
- `--agent`: Which agent to use (auto-detected if not specified)
- `--name`: Custom task ID (auto-generated if not specified)
- `--ci-commands`: CI commands for DoD (comma/newline separated; repeatable)
- `--dod-json`: Inline DoD spec JSON object
- `--dod-json-file`: Path to DoD spec JSON file

**Output:** JSON with task details including `id`, `worktree`, `branch`, `tmux_session`

**Example:**
```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Fix the memory leak in the cache module" \
  --mode batch \
  --ci-commands "npm run lint,npm test -- --run"
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
  [--dod-json '{"allowed_statuses":["pending","success"]}'] \
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
  --session-mode new
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

### check - Poll All Tasks for Changes

```bash
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

**Use this in a heartbeat/cron** to get automatic notifications when tasks complete or need attention.

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
- Task status must be:
  - `success` (batch)
  - `stopped` or `success` (interactive)

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

### Workflow 1: Simple Batch Task

```bash
# 1. Spawn task
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Add logging to the payment processor" \
  --mode batch

# 2. Check periodically (or set up cron)
bash "$SKILL_DIR/scripts/check-agents.sh"

# 3. When it shows success, publish
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" publish \
  --id <task-id> \
  --auto-pr
```

### Workflow 2: Interactive Task with Follow-ups

```bash
# 1. Spawn interactive task
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Refactor the authentication module" \
  --mode interactive

# 2. Send additional instructions
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" attach \
  --id <task-id> \
  --message "Also update the tests to match the new structure"

# 3. Check status
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id <task-id>

# 4. When satisfied, cancel to stop (triggers DoD evaluation)
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" cancel --id <task-id>

# 5. If DoD passes, publish
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" publish --id <task-id> --auto-pr
```

### Workflow 3: Parallel Tasks

```bash
# Spawn multiple tasks at once
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

# Check all at once
bash "$SKILL_DIR/scripts/check-agents.sh"
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
  --session-mode new
```

## How It Works

### Directory Structure

```
~/.agents/agent-swarm/
├── tasks/
│   ├── <task-id>.json          # Task metadata
│   └── history/
│       └── <date>/             # Archived tasks
├── worktree/
│   └── <repo-name>/
│       └── <task-id>/          # Isolated worktree
├── logs/
│   ├── <task-id>.log           # Agent output
│   └── <task-id>.exit          # Exit code (batch mode)
├── prompts/
│   └── <task-id>.txt           # Task prompt
└── agent-swarm-last-check.json # Change tracking
```

### Task State

Each task is stored as JSON in `~/.agents/agent-swarm/tasks/<task-id>.json`:

```json
{
  "id": "20260316-143022-a1b2c3",
  "mode": "batch",
  "status": "running",
  "agent": "codex",
  "repo": "/Users/you/projects/myapp",
  "worktree": "~/.agents/agent-swarm/worktree/myapp/20260316-143022-a1b2c3",
  "branch": "swarm/20260316-143022-a1b2c3",
  "base_branch": "main",
  "tmux_session": "swarm-batch-20260316-143022-a1b2c3",
  "task": "Add error handling to the login function",
  "dod_spec": {
    "allowed_statuses": ["pending", "success"],
    "require_clean_worktree": true,
    "require_commits_ahead_base": false,
    "ci_commands": ["npm test -- --run"],
    "push_command": "",
    "pr_command": ""
  },
  "dod": {},
  "created_at": "2026-03-16T14:30:22.000Z",
  "updated_at": "2026-03-16T14:30:22.000Z"
}
```

### DoD Evaluation

DoD is automatically evaluated when status changes to `pending` or `success`.

**Default checks:**
1. Status is in `dod_spec.allowed_statuses`
2. Worktree cleanliness check (if enabled)
3. Ahead-of-base commit check (if enabled)
4. All `dod_spec.ci_commands` exit with code 0
5. On `success`: execute `push_command` and `pr_command` (if provided)

## Advanced Usage

### Custom DoD with JSON Spec

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Implement user profile page" \
  --mode batch \
  --ci-commands "npm run lint,npm test -- --run,npm run type-check" \
  --dod-json '{"require_commits_ahead_base":true}'
```

Each CI command must pass for DoD to succeed. Commands run with 5-minute timeout.

### Reusing Worktrees for Follow-ups

```bash
# Original task
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Add user authentication" \
  --mode interactive

# After it stops, continue in same worktree with conversation history
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn-followup \
  --from <task-id> \
  --task "Now add password reset functionality" \
  --session-mode reuse
```

**Session mode comparison:**
- `new`: Fresh agent session, same worktree (good for fixing failures)
- `reuse`: Continues conversation, same worktree (good for iterative work)

### Automatic Reminders

The `check` command tracks long-running tasks and emits reminders:

- **Interactive pending**: Reminder after 3 hours of inactivity
- **Batch running**: Reminder after 3 hours of execution
- Max 3 reminders per task, one per hour

Set up a cron to run `check-agents.sh` every 10-15 minutes for automatic notifications.

## Global State Files

- `~/.agents/agent-swarm/tasks/<task_id>.json` - Current task state
- `~/.agents/agent-swarm/agent-swarm-last-check.json` - Change tracking for notifications
- `~/.agents/agent-swarm/logs/<task_id>.log` - Full agent output
- `~/.agents/agent-swarm/logs/<task_id>.exit` - Exit code (batch mode only)
- `~/.agents/agent-swarm/prompts/<task_id>.txt` - Original task prompt

## Error Handling

### Common Issues

**"task is not publishable for mode/status"**
- Check task status: `"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id <task-id>`
- For batch mode, task must be `success`
- For interactive mode, task must be `stopped` (use `cancel` to stop it)

**"task DoD not pass"**
- Check DoD details: `"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id <task-id>`
- Look at `dod.result.reason` to see what failed
- Common causes: uncommitted changes, no commits ahead of base, CI/push/PR command failures
- Fix issues and spawn follow-up, or manually update DoD if appropriate

**"attach_not_supported_in_batch_mode"**
- Batch tasks can't receive messages after spawn
- Use `spawn-followup` instead to create a new task

**"reuse_guard_failed"**
- Parent worktree is missing or invalid
- Parent tmux session is still running
- Use `--session-mode new` instead, or cancel parent first

## Integration with Heartbeat/Cron

Add this to your `HEARTBEAT.md` or cron:

```bash
bash "$SKILL_DIR/scripts/check-agents.sh"
```

This returns JSON with `changes` array showing tasks that changed status. Parse this to trigger notifications or take automated actions.

## Tips

1. **Use descriptive task descriptions** - The agent only sees your task description, so be specific about what you want.

2. **Batch mode for well-defined tasks** - If you can describe the task completely upfront, use batch mode. It's simpler and auto-converges.

3. **Interactive mode for exploration** - Use interactive when you're not sure exactly what needs to be done and want to guide the agent.

4. **Use `ci_commands` to gate quality** - Specify `--ci-commands` so DoD can validate before completion.

5. **Check logs when things fail** - The full agent transcript is in `~/.agents/agent-swarm/logs/<task-id>.log`

6. **Follow-ups reuse worktrees** - This is efficient and preserves context, but make sure the parent task is terminal first.

7. **Use `status --id` for accurate refresh** - Plain `status` without `--id` returns cached summaries. Use `--id` when you need current state.

## Limitations

- Requires git repository (refuses to run otherwise)
- Requires tmux (for background session management)
- Requires at least one agent CLI (codex, claude, or gemini)
- PR creation requires `gh` or `glab` CLI (falls back to manual URL)
- Tasks run with `--dangerously-bypass-approvals-and-sandbox` / `--yolo` flags
- Chinese language used in `next_step` summaries and some prompts

## Reference Files

For detailed schemas and DoD examples:
- `$SKILL_DIR/references/state-format.md` - JSON structure documentation
- `$SKILL_DIR/references/dod.json` - DoD spec example
