# CLI Reference

The primary entry point for OpenClaw Agent Swarm is the `swarm.js` script. It supports several subcommands for managing the full lifecycle of a task.

## Common Entry Point

```bash
node skills/openclaw-agent-swarm/scripts/swarm.js <command> [options]
```

---

## 🚀 `spawn`

Create a new task in a new isolated Git worktree and branch.

### Options
- `--repo <path>`: (Required) Absolute path to the target Git repository.
- `--task "<text>"`: (Required) Description of the task to be performed by the agent.
- `--mode <batch|interactive>`: Execution mode. Defaults to `batch`.
- `--agent <codex|claude|gemini>`: Specify which agent CLI to use.
- `--name <task_id>`: (Optional) A custom name for the task.
- `--required-test "<cmd>"`: (Optional, repeatable) Shell command(s) that must exit 0 for the task to pass DoD.

---

## 🔄 `spawn-followup`

Create a new task based on an existing terminal task.

### Options
- `--from <task_id>`: (Required) The ID of the parent task.
- `--task "<text>"`: (Required) Description of the follow-up task.
- `--worktree-mode <new|reuse>`: Whether to create a new worktree or reuse the parent's (`reuse` requires the parent session to be dead).
- `--agent <codex|claude|gemini>`: (Optional) Override the parent agent.
- `--required-test "<cmd>"`: (Optional, repeatable) New/overridden test commands.

---

## 💬 `attach`

Send a message to a running interactive task.

### Options
- `--id <task_id>`: (Required) The target task ID.
- `--message "<text>"`: (Required) Message to send into the live Tmux session.

*Note: Fails if the task is already in a terminal state or in batch mode.*

---

## 🛑 `cancel`

Manually stop a running task.

### Options
- `--id <task_id>`: (Required) The target task ID.
- `--reason "<text>"`: (Optional) Reason for cancellation.

---

## 🔍 `status` & `check`

Monitor task progress and state transitions.

### `status` Options
- `--id <task_id>`: Show detailed summary for a specific task.
- `--query <keyword>`: Search for tasks by ID, branch, or task description.

### `check` Options
- `--changes-only`: Only report tasks that have transitioned states since the last check. Useful for polling and heartbeats.

---

## ✅ `update-dod`

Update the Definition of Done (DoD) status for a task.

### Options
- `--id <task_id>`: (Required) The target task ID.
- `--status <pass|fail>`: (Required) The resulting DoD status.
- `--result <json_string>`: (Optional) Additional result metadata.

---

## 🚢 `publish` & `create-pr`

Manage code promotion after task completion.

### `publish` Options
- `--id <task_id>`: (Required) The target task ID.
- `--remote <name>`: Git remote name (defaults to `origin`).
- `--target-branch <branch>`: The base branch for the PR (defaults to `task.base_branch`).
- `--auto-pr`: Automatically attempt to create a PR/MR using available CLIs (`gh` or `glab`).

### `create-pr` Options
- `--id <task_id>`: (Required) The target task ID.
- `--title <text>`: (Optional) PR title.
- `--body <text>`: (Optional) PR body description.
