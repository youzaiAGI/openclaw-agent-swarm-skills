---
name: openclaw-agent-swarm-batch
description: Orchestrate parallel coding agents in non-interactive batch mode with git worktree + tmux. Supports spawn, follow-up (new/reuse worktree), cancel, heartbeat-driven status checks, and publish/PR flow.
---

# OpenClaw Agent Swarm Batch

Use this skill to run coding tasks as background tmux sessions with isolated git worktrees, while each sub-agent runs in non-interactive mode and exits automatically.

## Hard Rules

1. Refuse execution when target directory is not a git repository.
2. Detect local tools before spawn:
- If neither `codex` nor `claude` exists, stop and ask user to install at least one.
- If user specifies `codex` or `claude`, honor it.
- If user does not specify, auto-pick: `codex` first, then `claude`.
3. Keep main chat async: return spawn result immediately (task id/session/worktree/branch).
4. Agent runtime is non-interactive:
- `codex`: `codex exec --dangerously-bypass-approvals-and-sandbox "<prompt>"`
- `claude`: `claude --dangerously-skip-permissions -p "<prompt>"`
5. `attach` is not supported in batch mode. Return `requires_confirmation` with follow-up actions.
6. Heartbeat reporting should be incremental: use `check --changes-only`.
7. Do not auto-cancel long-running tasks. If a task runs over 3 hours (default), keep status `running` and return a timeout confirmation prompt in `check` output so OpenClaw can ask user whether to cancel.
8. DoD uses default built-in checks only:
- task status is `success`
- task branch has commits ahead of base branch
- worktree is clean (`git status --porcelain` empty)

## Global state

Global task registry and heartbeat state:
- `~/.agents/agent-swarm-batch/tasks/<task_id>.json`
- `~/.agents/agent-swarm-batch/agent-swarm-batch-last-check.json`

Runtime artifacts:
- `~/.agents/agent-swarm-batch/logs/<task_id>.log`
- `~/.agents/agent-swarm-batch/logs/<task_id>.exit`
- `~/.agents/agent-swarm-batch/prompts/<task_id>.txt`

Worktree root:
- `~/.agents/agent-swarm-batch/worktree/<repo-name>/<task_id>`

## Commands

Set reusable root:

```bash
SKILL_ROOT="$HOME/.openclaw/skills/openclaw-agent-swarm-batch"
```

Preferred runtime (Node 18+):

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" <subcommand> ...
```

Spawn task:

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" spawn \
  --repo <git_repo_path> \
  --task "<task description>" \
  [--agent codex|claude] \
  [--name <task_name>]
```

Spawn follow-up task from existing task:

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" spawn-followup \
  --from <task_id> \
  --task "<followup instruction>" \
  --worktree-mode new|reuse \
  [--agent codex|claude] \
  [--name <task_name>]
```

Attach (unsupported in batch mode, returns confirmation payload):

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" attach \
  --id <task_id> \
  --message "<extra instruction>"
```

Cancel task:

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" cancel \
  --id <task_id> \
  [--reason "<cancel reason>"]
```

Status query:

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" status --id <task_id>
node "$SKILL_ROOT/scripts/swarm-batch.js" status --query "<id|branch|session|keyword>"
```

List tasks:

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" list
```

Check tasks (full or changes-only):

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" check
node "$SKILL_ROOT/scripts/swarm-batch.js" check --changes-only
```

Publish finished task branch to remote:

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" publish \
  --id <task_id> \
  [--remote origin] \
  [--target-branch <base_branch>] \
  [--auto-pr]
```

Create PR/MR explicitly:

```bash
node "$SKILL_ROOT/scripts/swarm-batch.js" create-pr \
  --id <task_id> \
  [--remote origin] \
  [--target-branch <base_branch>] \
  [--title "<title>"] \
  [--body "<body>"]
```

Heartbeat wrapper:

```bash
bash "$SKILL_ROOT/scripts/check-agents.sh"
```

## Regression

Use the batch regression script:

```bash
./scripts/regression-swarm-batch-concurrency.sh
./scripts/regression-swarm-batch-concurrency.sh 1200 20
```
