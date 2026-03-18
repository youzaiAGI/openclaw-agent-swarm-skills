# State Format

`swarm.ts` prints JSON to stdout.

## Storage

- `~/.agents/agent-swarm/tasks/<task_id>.json`
- `~/.agents/agent-swarm/tasks/history/<yyyy-mm-dd>/<task_id>.json`
- `~/.agents/agent-swarm/agent-swarm-last-check.json`
- `~/.agents/agent-swarm/logs/<task_id>.log`
- `~/.agents/agent-swarm/logs/<task_id>.exit`
- `~/.agents/agent-swarm/prompts/<task_id>.txt`

## Task Fields (Core)

- `id`
- `mode`: `interactive|batch`
- `status`: `running|pending|success|failed|stopped`
- `agent`
- `repo`, `worktree`, `branch`, `base_branch`
- `tmux_session`
- `task`, `parent_task_id`
- `dod_spec`
- `created_at`, `updated_at`, `last_activity_at`, `timeout_since`
- `log`, `exit_file`, `exit_code`, `result_excerpt`
- `converged_at`, `converged_reason`
- `dod`, `publish`, `pr`, `cancel`

## DoD Object

DoD is stored under `task.dod`:

```json
{
  "status": "pass",
  "dod_spec": {
    "checks": {
      "allowed_statuses": ["pending", "success"],
      "require_clean_worktree": true,
      "require_commits_ahead_base": false,
      "ci_commands": ["npm test -- --run smoke"]
    },
    "actions": {
      "push_command": "git push -u origin HEAD",
      "pr_command": ""
    }
  },
  "result": {
    "reason": "ok",
    "error": "",
    "terminal": true,
    "worktree_clean": true,
    "commits_ahead_base": 1,
    "checks": [
      { "name": "status_allowed", "pass": true },
      { "name": "worktree_clean", "pass": true }
    ],
    "actions": {
      "push": { "command": "", "executed": false },
      "pr": { "command": "", "executed": false }
    }
  },
  "updated_at": "2026-03-10T10:00:00.000Z"
}
```

Notes:
- `status` only allows `pass|fail`.
- System exceptions must be written to `dod.result.error`.

## last-check.json

```json
{
  "meta": {
    "updated_at": "2026-03-10T10:00:00.000Z",
    "archive_age_sec": 86400
  },
  "tasks": {
    "task-id-1": {
      "last_status": "running",
      "updated_at": "2026-03-10T10:00:00.000Z",
      "reminder_count": 1,
      "last_reminder_at": "2026-03-10T09:00:00.000Z"
    }
  }
}
```

Reminder counters are maintained only in `last-check.json`, not in `task.json`.
