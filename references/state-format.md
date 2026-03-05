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