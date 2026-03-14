# OpenClaw Agent Swarm

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](code/src/swarm.ts)

**OpenClaw Agent Swarm** is a robust execution layer designed for AI agents (e.g., Codex, Claude Code, Gemini). It enables agents to handle complex coding tasks in the background with **physical isolation**, **persistence**, and **explicit state tracking**.

English | [简体中文](docs/README.zh-CN.md)

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

Simply provide the following prompt to your AI agent:

> **"Install this skill: https://github.com/youzaiAGI/openclaw-agent-swarm-skills/tree/main/skills/openclaw-agent-swarm"**

*Prerequisites: Ensure `git`, `tmux`, and at least one agent CLI (`codex`, `claude`, or `gemini`) are installed on your host.*

---

## 📖 Quick Start (Natural Language Guide)

### 1. Starting a Task
You must specify a target **Git repository directory**.

*   **Prompt**: "In the `/Users/me/projects/webapp` repository (a git repo), start a batch task to implement the Stripe integration. Use Claude and verify with `npm test`."
*   **Prompt**: "Investigate the memory leak in `/path/to/repo` interactively using Codex."

### 2. Monitoring & Heartbeat
*   **User Check**: "List all active coding tasks and their current progress."
*   **Automatic Heartbeat**: The swarm includes a `check-agents.sh` script. In tools like OpenClaw, this runs periodically to notify you **only when a task's status changes** (e.g., "Task A just finished successfully").

### 3. Definition of Done (DoD)
A task isn't finished until the DoD is satisfied.
*   **Built-in**: Swarm checks if the worktree is clean and if the specified test commands exit with code 0.
*   **Semantic (`dod.md`)**: You can ask the agent to verify complex rules defined in a `dod.md` file within the repository.
*   **Prompt**: "Verify the DoD for task `auth-fix`. If tests pass and `dod.md` criteria are met, publish the branch."

---

## 🌟 Advanced Features

*   **Attach**: "Send a message to task #101: 'Please use the newer API endpoint'."
*   **Cancel**: "Stop task `refactor-v1` immediately and kill its session."
*   **Follow-up**: "The previous task failed. Start a follow-up in the same worktree to address the linter errors."

---

## 📂 Documentation Reference

*   [CLI Full Manual](docs/cli-reference.md) - For advanced users and manual Shell execution.
*   [Definition of Done Guide](docs/dod-workflow.md) - Deep dive into built-in vs semantic checks.
*   [Agent Integration](docs/agent-integration.md) - How we handle different AI CLI tools.
*   [Troubleshooting](docs/troubleshooting.md) - Solving common issues (locks, sessions, etc.).
*   [State & JSON Format](skills/openclaw-agent-swarm/references/state-format.md) - Technical spec for developers.
