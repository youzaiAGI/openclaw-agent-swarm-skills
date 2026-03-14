# Agent Integration

OpenClaw Agent Swarm is designed to work with various AI coding agents. It currently supports Codex, Claude Code, and Gemini.

## 1. Prerequisites

Before using an agent, you must ensure its CLI is installed and configured in your shell environment.

- **Codex**: Ensure the `codex` command is available.
- **Claude**: Ensure the `claude` command is available.
- **Gemini**: Ensure the `gemini` command is available.

## 2. Selection during Spawn

You can specify the agent at task creation:

```bash
# Using Claude Code
node skills/openclaw-agent-swarm/scripts/swarm.js spawn \
  --agent claude \
  --task "Fix bug in API layer" \
  ...

# Using Codex
node skills/openclaw-agent-swarm/scripts/swarm.js spawn \
  --agent codex \
  --task "Implement feature Y" \
  ...
```

If no agent is specified, the swarm will attempt to detect available tools in this order: `codex` -> `claude` -> `gemini`.

## 3. Configuration & Permissions

Each agent may have its own set of safety flags or permission prompts. The swarm executor handles these by:
1. Passing **dangerously bypass** or **YOLO** flags where available to ensure non-interactive execution (in batch mode).
2. Handling **Tmux-specific startup prompts** (like "trust this folder") automatically.

## 4. Customizing Agent Prompts

The swarm generates a default system prompt for the agent, which includes:
- The **Task ID**.
- The **Worktree path**.
- The specific **User Task**.
- A set of **Rules** (e.g., "Operate only inside the worktree").

## 5. Heartbeat & Polling

The coordinator agent should use `check-agents.sh` or `swarm.js check --changes-only` to poll for status updates. This is crucial for long-running tasks.
