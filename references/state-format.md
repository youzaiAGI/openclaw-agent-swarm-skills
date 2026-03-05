# State Format

`swarm.py` prints JSON to stdout.

## Registry

Global task summary file (cross-repo):

`~/.openclaw/agent-swarm/agent-swarm-tasks.json`

## spawn

```json
{
  "ok": true,
  "task": {
    "id": "20260304-204400-ab12cd",
    "agent": "codex",
    "status": "running",
    "repo": "/path/repo-a",
    "worktree": "/path/repo-a-worktrees/20260304-204400-ab12cd",
    "branch": "swarm/20260304-204400-ab12cd",
    "tmux_session": "swarm-20260304-204400-ab12cd"
  },
  "registry": "/root/.openclaw/workspace/.clawdbot/agent-swarm-tasks.json"
}
```

## attach

```json
{
  "ok": true,
  "id": "20260304-204400-ab12cd",
  "sent": true
}
```

When task is not running/alive:

```json
{
  "ok": true,
  "id": "20260304-204400-ab12cd",
  "sent": false,
  "requires_confirmation": true,
  "reason": "task_not_running:success",
  "actions": [
    {"action": "spawn_followup_new_worktree", "recommended": true},
    {"action": "spawn_followup_reuse_worktree", "recommended": false}
  ]
}
```

## spawn-followup

```json
{
  "ok": true,
  "parent_id": "20260304-204400-ab12cd",
  "task": {
    "id": "20260304-220101-ef56aa",
    "status": "running",
    "worktree_mode": "new"
  }
}
```

`worktree_mode=reuse` is guarded and can fail with errors like:
- `reuse_guard_failed:worktree_missing`
- `reuse_guard_failed:worktree_not_clean`
- `reuse_guard_failed:parent_session_running`

## status

```json
{
  "ok": true,
  "task": {
    "id": "20260304-204400-ab12cd",
    "status": "running",
    "dod": {"pass": false, "reason": "status_not_success:running"},
    "next_step": "attach 补充要求，或等待 heartbeat 下次轮询"
  }
}
```

## check

```json
{
  "ok": true,
  "changes_only": true,
  "changes": [
    {
      "id": "...",
      "from": "running",
      "to": "success",
      "repo": "/path/repo-a",
      "worktree": "~/.openclaw/agent-swarm/worktree/repo-a/...",
      "tmux_session": "swarm-...",
      "dod": {
        "checked": true,
        "pass": true,
        "commit": true,
        "clean_worktree": true,
        "reason": "ok"
      },
      "result_excerpt": "..."
    }
  ],
  "tasks": []
}
```

When `changes` is empty, heartbeat can skip user notification.
