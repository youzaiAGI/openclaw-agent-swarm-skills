# OpenClaw Agent Swarm

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](../code/src/swarm.ts)

**OpenClaw Agent Swarm** 是一个专为 AI Agent 设计的高性能执行层。它利用 **Git Worktree** 和 **Tmux**，让 Agent 在物理隔离且可随时介入的环境中异步执行编程任务。

[English](../README.md) | 简体中文

---

## 🏗️ 架构概览

![架构图](arch.svg)

---

## 🛠️ 快速安装

只需向你的 AI Agent（如 Gemini CLI、OpenClaw）提供以下提示词，它将自动完成安装：

> **“安装这个 skill: https://github.com/youzaiAGI/openclaw-agent-swarm-skills/tree/main/skills/openclaw-agent-swarm”**

*注意：请确保你的本地环境已预装 `git`, `tmux`, 以及至少一个 Agent CLI (`codex`, `claude` 或 `gemini`)。*

---

## 📖 快速上手（自然语言交互指南）

安装完成后，你可以直接用普通话与你的 Agent 对话来控制 Swarm，Agent 会自动将其转化为底层的 CLI 命令。

### 1. 启动任务
你可以启动 **批处理 (Batch)** 模式（后台静默执行）或 **交互 (Interactive)** 模式（可随时介入）。

*   **对话示例**: “在 `/path/to/repo` 启动一个批处理任务，重构登录服务。使用 Claude Agent 并确保 `npm test` 通过。”
*   **对话示例**: “以交互模式排查 buffer 模块的内存泄漏问题。使用 Codex Agent。”

### 2. 状态检查
Swarm 提供了两种方式来追踪进度：

*   **主动查询**: 你可以随时向 Agent 提问。
    *   **对话示例**: “帮我查一下当前正在运行的编程任务状态。”
    *   **对话示例**: “那个‘重构登录’的任务现在进度如何了？”
*   **自动心跳检查 (OpenClaw)**: Swarm 内置了 `check-agents.sh` 脚本。协调器（Coordinator）会在后台自动运行它，并**只回报状态发生变化的任务**（例如从 `running` 变为 `success`），确保你不会被冗余日志淹没。

### 3. 定义任务完成 (DoD)
任务只有在满足 **「完成定义 (Definition of Done, DoD)」** 时才会被标记为真正完成。

*   **CI 命令校验**: 在启动任务时，你可以直接定义“门禁”（如上述示例中的 `npm test`）。如果命令执行失败，则任务不通过。
*   **语义化 DoD (`dod.md`)**: 对于复杂的业务逻辑，Agent 会检查 Worktree 中的 `docs/dod.md` 文件。
    *   **对话示例**: “检查任务 A 的 DoD。如果 `dod.md` 中的所有语义规则都已满足，则将其标记为已完成。”
*   **人工干预**:
    *   **对话示例**: “我刚人工审核了任务 B 的代码。将它的 DoD 手动更新为‘通过’。”

---

## 🌟 进阶能力

*   **中途干预/取消**: 任务运行中想改主意？直接说“向任务发送补充要求：也要更新文档”或“取消这个任务”，Swarm 会立即执行。
*   **物理隔离隔离 (Worktree Isolation)**: 每个任务都有自己的物理目录。Agent 干活时，你可以继续在主工程里编码，互不干扰。
*   **任务继承 (Follow-up)**: “上个任务失败了，在同一个 Worktree 里启动一个后续任务，修复那个报错的测试用例。”

---

## 📂 进阶文档索引

*   [CLI 命令行参考](cli-reference.md) - 手动执行 Shell 命令的完整手册。
*   [状态协议 & JSON 格式](../skills/openclaw-agent-swarm/references/state-format.md) - 开发者对接 Swarm 时的技术细节。
*   [问题排查](troubleshooting.md) - 处理文件锁、Tmux 会话丢失等异常情况。
