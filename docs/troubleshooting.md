# Troubleshooting

Common issues and solutions for OpenClaw Agent Swarm.

## 1. Task State Issues

### "Task state is stuck in `running` but the agent is not doing anything"
- **Reason**: The agent might be hung or waiting for a user prompt in a batch session.
- **Solution**: Check the task logs in `~/.agents/agent-swarm/logs/<task-id>.log`. You can also manually attach to the Tmux session to see the current state: `tmux attach -t <session_name>`.

### "Task status is `stopped` unexpectedly"
- **Reason**: The Tmux session might have crashed or been killed by a system restart.
- **Solution**: Re-run the task using `spawn-followup --session-mode reuse`.

## 2. Lock File Issues

### "Timeout acquiring task lock" or "timeout acquiring repo lock"
- **Reason**: A previous process may have crashed while holding a lock.
- **Solution**: The swarm has a built-in stale lock reaper (120s for tasks, 300s for repos). You can also manually delete the lock file if needed:
  - Task lock: `~/.agents/agent-swarm/tasks/<task-id>.json.lock`
  - Repo lock: `~/.agents/agent-swarm/repo-<repo-key>.lock`

## 3. Git Worktree Issues

### "Failed to create worktree: branch already exists"
- **Reason**: A previous task with the same name or ID might have left a stale branch.
- **Solution**: Manually delete the stale branch: `git branch -D swarm/<task-id>`.

### "Worktree missing"
- **Reason**: The `~/.agents/agent-swarm/worktree/` directory was manually deleted.
- **Solution**: Re-run the task with `spawn-followup --session-mode new`.

## 4. Permission & Environment Issues

### "Agent command not found"
- **Reason**: The agent CLI is not in your shell's `PATH`.
- **Solution**: Ensure your shell configuration (`.bashrc`, `.zshrc`, etc.) properly exports the path to the agent CLI.

### "Bypass permissions mode prompt in Tmux"
- **Reason**: Some agents (like Claude) require explicit permission to run in "dangerous" mode.
- **Solution**: The swarm attempts to handle these prompts automatically. If it fails, you can manually attach to the Tmux session and accept the prompt.
