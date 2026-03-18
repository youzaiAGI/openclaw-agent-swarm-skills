# CLI Reference

The primary entry point for OpenClaw Agent Swarm is the `swarm.ts` script. It supports several subcommands for managing the full lifecycle of a task.

## Common Entry Point

```bash
if command -v bun >/dev/null 2>&1; then RUN_X=(bun); elif command -v npx >/dev/null 2>&1; then RUN_X=(npx -y tsx@4.20.6); else echo "Install bun or npx first." >&2; exit 1; fi
"${RUN_X[@]}" skills/openclaw-agent-swarm/scripts/swarm.ts <command> [options]
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
- `--ci-commands "<cmd1,cmd2>"`: (Optional, repeatable) DoD CI command list (comma/newline separated).
- `--dod-json "<json>"`: (Optional) Inline DoD spec object.
- `--dod-json-file <path>`: (Optional) Path to DoD spec JSON file.

---

## 🔄 `spawn-followup`

Create a new task based on an existing terminal task.

### Options
- `--from <task_id>`: (Required) The ID of the parent task.
- `--task "<text>"`: (Required) Description of the follow-up task.
- `--session-mode <new|reuse>`: Follow-up session behavior on the reused parent worktree (`reuse` requires the parent session to be dead).
- `--agent <codex|claude|gemini>`: (Optional) Override the parent agent.
- `--ci-commands "<cmd1,cmd2>"`: (Optional, repeatable) Extra DoD CI command list.
- `--dod-json "<json>"`: (Optional) Inline DoD spec overrides.
- `--dod-json-file <path>`: (Optional) Path to DoD spec JSON file.

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
