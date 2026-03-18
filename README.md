# OpenClaw Agent Swarm

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](skills/openclaw-agent-swarm/scripts/swarm.ts)

**OpenClaw Agent Swarm** is a robust execution layer for AI agents (Codex, Claude Code, Gemini). It enables agents to handle complex coding tasks in parallel with **physical isolation**, **persistence**, and **explicit state tracking**.

English | [简体中文](docs/README.zh-CN.md)

---

## 🚀 How It Works

```
1. Spawn → Creates isolated git worktree + starts agent in tmux
2. Check → Monitors status, reports only changes
3. Review → Validates Definition of Done (tests, clean worktree)
4. Publish → Pushes branch + creates PR automatically
```

Each task runs independently in its own worktree, so you can work on multiple features simultaneously without conflicts.

---

## 🏗️ Architecture & Design Philosophy

The swarm is built on three pillars to ensure that AI agents can work safely and effectively in a professional development environment.

![Architecture](docs/arch.svg)

### 1. Physical Isolation (Git Worktree)
Unlike simple file copying, the swarm uses `git worktree` to create a dedicated directory for every task.
*   **Why?** It ensures the agent has a full, clean Git context without interfering with your main workspace. You can keep coding while the agent runs tests or refactors code in its own isolated "sandbox".
*   **Constraint**: **Every task must be initiated within a valid Git repository.** The swarm will refuse to run in non-git directories.

### 2. Execution Persistence (Tmux)
Tasks are executed inside detached `tmux` sessions.
*   **Why?** This provides "immortality" to the task. Even if the coordinator agent or your terminal closes, the coding agent continues its work in the background. It also allows for the `attach` capability, where you can "jump" into the live session to provide real-time guidance.

### 3. Explicit State Machine
Every task follows a strict lifecycle: `running` → `pending` → `success` | `failed` | `stopped`.
*   **Visibility**: Status is tracked via local JSON files, allowing for incremental "heartbeat" checks that only report changes.

---

## 🛠️ Installation

### For Claude Code Users

Tell Claude to install the skill:

```
Install this skill: https://github.com/youzaiAGI/openclaw-agent-swarm-skills/tree/main/skills/openclaw-agent-swarm
```

### Prerequisites

Ensure these tools are installed:
- `git` (required)
- `tmux` (required)
- At least one AI agent CLI: `codex`, `claude`, or `gemini` (required)
- Optional: `gh` (GitHub CLI) or `glab` (GitLab CLI) for automatic PR creation

### Verify Installation

```bash
git --version
tmux -V
claude --version  # or codex --version, or gemini --version
```

---

## 📖 Quick Start

### 1. Spawn a Task

Tell Claude to start a background task in a git repository:

**Batch mode** (fire-and-forget):
```
In ~/projects/my-app, spawn a batch task to add error handling to the API endpoints.
Run 'npm test' to verify it works.
```

**Interactive mode** (you can send follow-up messages):
```
Start an interactive task in ~/projects/backend to investigate the memory leak.
Use codex and let me attach messages later.
```

### 2. Check Status

Monitor your tasks:
```
Check all agent swarm tasks and show me what changed.
```

Or check a specific task:
```
What's the status of task abc123?
```

### 3. Review and Publish

When a task completes successfully:
```
Publish task abc123 and create a PR automatically.
```

### 4. Handle Failures

If a task fails, spawn a follow-up:
```
Task xyz789 failed. Start a follow-up in the same worktree to fix the linter errors.
```

---

## 🎯 Definition of Done (DoD)

Tasks aren't considered complete until DoD validation passes. The swarm automatically checks:

1. **Status allowed by `dod_spec`** - Default allows `pending` and `success`
2. **Clean worktree** - No uncommitted changes (default enabled)
3. **CI commands pass** - All commands in `dod_spec.checks.ci_commands` must exit with code 0
4. **Optional commit-ahead check** - Require commits ahead of base branch
5. **`success`-only actions** - Execute `dod_spec.actions.push_command` / `dod_spec.actions.pr_command` if configured

**Custom DoD spec**: Use `skills/openclaw-agent-swarm/references/dod.json` as template and pass with `--dod-json` or `--dod-json-file`.
DoD JSON must use grouped fields under `checks` and `actions` (legacy flat keys are not supported).

Only tasks with `dod.status=pass` can be published.

---

## 🌟 Advanced Features

### Attach to Running Tasks
Send messages to interactive tasks in real-time:
```
Send a message to task abc123: "Use the v2 API endpoint instead"
```

### Cancel Tasks
Stop a running task immediately:
```
Cancel task xyz789 because the requirements changed
```

### Follow-up Tasks
Continue work in the same worktree after a task completes:

**New session** (fresh start, same code):
```
Spawn a follow-up for task abc123 with a new session to add unit tests
```

**Reuse session** (continues previous conversation):
```
Spawn a follow-up for task abc123 reusing the session to fix the remaining issues
```

---

## 🔧 Common Issues

**Task stuck in `pending`**
- Interactive tasks wait for input. Use `attach` to send a message or `cancel` to stop it.

**DoD fails with "worktree not clean"**
- The agent didn't commit changes. Check the log, then spawn a follow-up to commit them.

**"tmux session not found"**
- Session crashed. Check `~/.agents/agent-swarm/logs/<task_id>.log` for errors.

**Can't publish - "DoD not pass"**
- Run DoD `dod_spec.checks.ci_commands` manually in the worktree to see what's failing.
- Check `task.dod.result.checks` in the task JSON for details.

See [Troubleshooting Guide](docs/troubleshooting.md) for more solutions.

---

## 📂 Documentation

### User Guides
- [🏛️ Architecture Deep Dive](docs/architecture.md) - Detailed design of isolation and execution model
- [✅ Definition of Done Guide](docs/dod-workflow.md) - Built-in vs semantic DoD checks
- [🛠️ Troubleshooting](docs/troubleshooting.md) - Common issues and solutions

### Developer Reference
- [🏗️ Development Guide](docs/development.md) - Build and modify the source
- [📜 CLI Manual](docs/cli-reference.md) - Direct shell command reference
- [🤖 Agent Integration](docs/agent-integration.md) - How different AI CLIs are handled
- [⚙️ State Format](skills/openclaw-agent-swarm/references/state-format.md) - JSON schemas and storage

### Contributing
- [🤝 Contributing Guide](CONTRIBUTING.md) - Bug reports and code submissions

---

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.
