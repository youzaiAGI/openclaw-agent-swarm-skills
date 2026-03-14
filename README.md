# OpenClaw Agent Swarm

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](code/src/swarm.ts)

**OpenClaw Agent Swarm** is a high-performance execution layer that enables AI agents to run coding tasks in isolated, asynchronous environments using **Git Worktrees** and **Tmux**.

English | [简体中文](docs/README.zh-CN.md)

---

## 🏗️ Architecture at a Glance

![Architecture](docs/arch.svg)

---

## 🛠️ Installation

Simply provide the following prompt to your AI agent (e.g., Gemini CLI, OpenClaw):

> **"Install this skill: https://github.com/youzaiAGI/openclaw-agent-swarm-skills/tree/main/skills/openclaw-agent-swarm"**

*Note: Ensure your local environment has `git`, `tmux`, and at least one agent CLI (`codex`, `claude`, or `gemini`) installed.*

---

## 📖 Quick Start (Natural Language Guide)

Once installed, you can control the swarm using plain English. Your agent will translate these intents into the appropriate underlying commands.

### 1. Starting a Task
You can ask your agent to start a task in **Batch** (background) or **Interactive** (attachable) mode.

*   **Prompt**: "Start a batch task to refactor the login service in `/path/to/repo`. Use Claude and ensure `npm test` passes."
*   **Prompt**: "Investigate the memory leak in the buffer module interactively. Use Codex."

### 2. Checking Status
There are two ways the swarm tracks progress:

*   **User Check**: You can ask at any time.
    *   **Prompt**: "Show me the status of my active coding tasks."
    *   **Prompt**: "What is the progress of the 'refactor-login' task?"
*   **Automatic Heartbeat (OpenClaw)**: The swarm includes a `check-agents.sh` script that the coordinator runs automatically in the background. It only reports tasks that have **changed state** (e.g., from `running` to `success`), ensuring you aren't overwhelmed by logs.

### 3. Defining Task Completion (DoD)
A task is only "Done" when it satisfies the **Definition of Done (DoD)**.

*   **CI Commands**: You can define strict gates when starting a task (as shown in the "Starting a Task" example). If `npm test` fails, the DoD fails.
*   **Semantic DoD (`dod.md`)**: For complex logic, the agent will check the `docs/dod.md` file in the worktree.
    *   **Prompt**: "Check the DoD for task A. If all semantic rules in `dod.md` are met, mark it as passed."
*   **Manual Intervention**:
    *   **Prompt**: "I've reviewed the code for task B. Manually update its DoD to 'pass'."

---

## 🌟 Advanced Capabilities

*   **Attach/Cancel**: Middle of a task? Use `Attach "Please also update the docs"` to send live instructions, or `Cancel` to stop immediately.
*   **Worktree Isolation**: Every task gets its own physical directory. No more "breaking" your main workspace while the agent works.
*   **Follow-up Tasks**: "The last task failed. Start a follow-up in the same worktree to fix the broken tests."

---

## 📂 Documentation Reference

*   [CLI Reference](docs/cli-reference.md) - For manual command usage.
*   [State & JSON Format](skills/openclaw-agent-swarm/references/state-format.md) - For developers integrating the swarm.
*   [Troubleshooting](docs/troubleshooting.md) - Dealing with locks, tmux sessions, and more.
