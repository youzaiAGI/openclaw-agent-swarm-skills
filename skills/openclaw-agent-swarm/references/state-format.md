# State Format

`swarm.js` prints JSON to stdout.

## Storage Model

Global state root:

`~/.agents/agent-swarm`

Task storage is directory-based (not a single tasks.json file):

- `~/.agents/agent-swarm/tasks/<task_id>.json`
- `~/.agents/agent-swarm/tasks/history/<yyyy-mm-dd>/<task_id>.json` (archived terminal tasks)
- `~/.agents/agent-swarm/agent-swarm-last-check.json`
- `~/.agents/agent-swarm/logs/<task_id>.log`
- `~/.agents/agent-swarm/logs/<task_id>.exit`
- `~/.agents/agent-swarm/prompts/<task_id>.txt`

`registry` fields returned by commands now point to:

`~/.agents/agent-swarm/tasks`

## Common Task Fields

Common persisted fields include:

- `id`, `agent`, `status`
- `repo`, `worktree`, `branch`, `base_branch`
- `tmux_session`
- `task`, `parent_task_id`
- `created_at`, `updated_at`, `last_activity_at`
- `log`, `exit_file`, `result_excerpt`
- `exit_code` (when available)
- `converged_at`, `converged_reason` (when status transitions to terminal)
- `dod`, `publish`, `pr`

Terminal statuses:

- `success`, `failed`, `stopped`, `needs_human`

## spawn

```json
{
  "ok": true,
  "task": {
    "id": "20260308-120101-ab12cd",
    "agent": "codex",
    "status": "running",
    "repo": "/path/repo-a",
    "worktree": "/Users/youzai/.agents/agent-swarm/worktree/repo-a/20260308-120101-ab12cd",
    "branch": "swarm/20260308-120101-ab12cd",
    "base_branch": "main",
    "tmux_session": "swarm-20260308-120101-ab12cd"
  },
  "tools": {
    "codex": true,
    "claude": true,
    "tmux": true,
    "git": true
  },
  "registry": "/Users/youzai/.agents/agent-swarm/tasks"
}
```

## spawn-followup

```json
{
  "ok": true,
  "parent_id": "20260308-120101-ab12cd",
  "task": {
    "id": "20260308-121010-ef56aa",
    "status": "running",
    "worktree_mode": "new"
  },
  "registry": "/Users/youzai/.agents/agent-swarm/tasks"
}
```

`worktree_mode=reuse` can fail with guarded reasons such as:

- `reuse_guard_failed:worktree_missing`
- `reuse_guard_failed:worktree_not_clean`
- `reuse_guard_failed:parent_session_running`

## attach

Successful send:

```json
{
  "ok": true,
  "id": "20260308-120101-ab12cd",
  "sent": true
}
```

Task not running:

```json
{
  "ok": true,
  "id": "20260308-120101-ab12cd",
  "sent": false,
  "requires_confirmation": true,
  "reason": "task_not_running:stopped",
  "actions": [
    { "action": "spawn_followup_new_worktree", "recommended": true },
    { "action": "spawn_followup_reuse_worktree", "recommended": false }
  ]
}
```

## cancel

```json
{
  "ok": true,
  "id": "20260308-120101-ab12cd",
  "cancelled": true,
  "status": "stopped",
  "converged_reason": "user_cancelled:kill_session:manual_stop",
  "cancel": {
    "by_user": true,
    "method": "kill_session",
    "session_killed": true
  }
}
```

If task is already terminal:

```json
{
  "ok": true,
  "id": "20260308-120101-ab12cd",
  "cancelled": false,
  "already_terminal": true,
  "status": "success"
}
```

## status

```json
{
  "ok": true,
  "task": {
    "id": "20260308-120101-ab12cd",
    "status": "stopped",
    "dod": {
      "checked": true,
      "pass": false,
      "reason": "status_not_success:stopped"
    },
    "publish": { "ok": false },
    "pr": { "state": "manual_required" },
    "result_excerpt": "...",
    "next_step": "检查 session 与任务状态，必要时重试"
  }
}
```

## check

```json
{
  "ok": true,
  "registry": "/Users/youzai/.agents/agent-swarm/tasks",
  "changes_only": true,
  "changes": [
    {
      "id": "20260308-120101-ab12cd",
      "from": "running",
      "to": "stopped",
      "converged_reason": "user_cancelled:kill_session:manual_stop",
      "repo": "/path/repo-a",
      "worktree": "/Users/youzai/.agents/agent-swarm/worktree/repo-a/20260308-120101-ab12cd",
      "tmux_session": "swarm-20260308-120101-ab12cd",
      "dod": {
        "checked": true,
        "pass": false,
        "commit": false,
        "clean_worktree": false,
        "reason": "status_not_success:stopped"
      },
      "result_excerpt": "...",
      "publish_prompt": ""
    }
  ],
  "tasks": []
}
```

When `changes` is empty, heartbeat can skip user notification.

## list

```json
{
  "ok": true,
  "registry": "/Users/youzai/.agents/agent-swarm/tasks",
  "tasks": []
}
```

## publish

```json
{
  "ok": true,
  "id": "20260308-120101-ab12cd",
  "publish": {
    "ok": true,
    "remote": "origin",
    "remote_branch": "swarm/20260308-120101-ab12cd",
    "target_branch": "main",
    "forge": "github"
  },
  "pr": {
    "ok": false,
    "state": "manual_required",
    "manual_url": "https://.../compare/..."
  }
}
```

## create-pr

```json
{
  "ok": true,
  "id": "20260308-120101-ab12cd",
  "pr": {
    "ok": false,
    "state": "manual_required",
    "error": "no_supported_pr_cli",
    "manual_url": "https://..."
  }
}
```
