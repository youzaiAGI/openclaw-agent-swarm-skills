# Architecture

Internal details of how agent-swarm works.

## Directory Structure

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

## Task State

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
    "checks": {
      "allowed_statuses": ["pending", "success"],
      "require_clean_worktree": true,
      "require_commits_ahead_base": false,
      "ci_commands": ["npm test -- --run"]
    },
    "actions": {
      "push_command": "git push -u origin HEAD",
      "pr_command": ""
    }
  },
  "dod": {},
  "created_at": "2026-03-16T14:30:22.000Z",
  "updated_at": "2026-03-16T14:30:22.000Z"
}
```

See `state-format.md` for complete field documentation.

## DoD Evaluation

DoD is automatically evaluated when status changes to `pending` or `success`.

**Default checks:**
1. Status is in `dod_spec.checks.allowed_statuses`
2. Worktree cleanliness check (if enabled)
3. Ahead-of-base commit check (if enabled)
4. All `dod_spec.checks.ci_commands` exit with code 0
5. On `success`: execute `dod_spec.actions.push_command` and `dod_spec.actions.pr_command` (if provided)

## Global State Files

- `~/.agents/agent-swarm/tasks/<task_id>.json` - Current task state
- `~/.agents/agent-swarm/agent-swarm-last-check.json` - Change tracking for notifications
- `~/.agents/agent-swarm/logs/<task_id>.log` - Full agent output
- `~/.agents/agent-swarm/logs/<task_id>.exit` - Exit code (batch mode only)
- `~/.agents/agent-swarm/prompts/<task_id>.txt` - Original task prompt