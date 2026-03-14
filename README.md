# OpenClaw Agent Swarm

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](code/src/swarm.ts)

**OpenClaw Agent Swarm** is a unified execution layer for orchestrating AI coding agents (such as Codex, Claude Code, and Gemini) in isolated, asynchronous environments.

English | [简体中文](docs/README.zh-CN.md)

---

## 🚀 Key Features

- **Isolated Execution**: Automatically creates a dedicated Git Worktree and Branch for every task, ensuring zero interference.
- **Asynchronous Scheduling**: Supports long-running background tasks (Batch mode) or real-time human-in-the-loop interaction (Interactive mode).
- **Incremental Monitoring**: Provides a heartbeat polling mechanism that only reports changed task states.
- **DoD Driven**: Built-in and extensible "Definition of Done" (DoD) checks to ensure high-quality code changes.
- **Multi-Agent Support**: A unified CLI interface for Codex, Claude Code, and Gemini.

---

## 🏗️ Architecture at a Glance

The swarm ensures safe and controllable execution through multiple layers of isolation:

![Architecture](docs/arch.svg)

---

## 🛠️ Quick Setup

### Prerequisites
- **OS**: macOS or Linux
- **Node.js**: >= 18
- **Dependencies**: `git`, `tmux`, and at least one agent CLI (`codex`, `claude`, or `gemini`).

### Installation
```bash
# Clone the repository
git clone https://github.com/youzaiAGI/openclaw-agent-swarm-skills.git
cd openclaw-agent-swarm-skills

# Build from source
cd code && npm install && npm run build
cd ..

# Deploy the skill payload
./scripts/build-skill.sh
```

---

## 📖 Documentation Index

For detailed guides and references, please explore our documentation:

### 🏁 [Getting Started](docs/getting-started.md)
Step-by-step instructions for installation, configuration, and running your first task.

### 🏛️ [Architecture](docs/architecture.md)
In-depth look at how the swarm uses Git Worktree, Tmux, and local state for isolation and execution.

### 📜 [CLI Reference](docs/cli-reference.md)
Complete manual for every subcommand and option available in the `swarm.js` tool.

### ✅ [DoD Workflow](docs/dod-workflow.md)
Explanation of the "Definition of Done" process, including automated tests and semantic checks.

### 🤖 [Agent Integration](docs/agent-integration.md)
Guidelines for configuring and using different AI coding agents within the swarm.

### 🛠️ [Troubleshooting](docs/troubleshooting.md)
Common issues, error messages, and their corresponding solutions.

---

## 🤝 Contributing

Contributions are welcome! If you're modifying the core logic, please remember:
1. Edit the TypeScript source in `code/src/swarm.ts`.
2. Run `npm run build` to synchronize the compiled JavaScript.
3. Verify your changes using the provided regression scripts in `scripts/`.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
