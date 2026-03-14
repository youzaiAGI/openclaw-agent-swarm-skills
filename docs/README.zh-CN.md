# OpenClaw Agent Swarm

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](../code/src/swarm.ts)

**OpenClaw Agent Swarm** 是一个专为 AI Agent 设计的鲁棒执行层（如 Codex、Claude Code、Gemini）。它通过 **物理隔离**、**执行持久化** 和 **显式状态追踪**，让 Agent 能够安全、高效地在后台处理复杂的编程任务。

[English](../README.md) | 简体中文

---

## 🏗️ 架构与设计理念

Swarm 的设计立足于三大支柱，确保 AI Agent 在专业的开发环境中能够既安全又有效地工作。

![架构图](arch.svg)

### 1. 物理隔离 (Git Worktree)
与简单的文件拷贝不同，Swarm 利用 `git worktree` 为每个任务创建专属目录。
*   **为什么要这样做？** 它确保 Agent 拥有完整且干净的 Git 上下文，同时完全不干扰你当前的工作区。当 Agent 在它专属的“沙盒”中跑测试或重构代码时，你可以继续在主工程中编码。
*   **硬性约束**：**所有任务必须在有效的 Git 仓库目录中启动。** Swarm 会拒绝在非 Git 目录中运行。

### 2. 执行持久化 (Tmux)
所有任务均在后台分离的 `tmux` 会话中执行。
*   **为什么要这样做？** 这赋予了任务“永生性”。即使协调器 Agent 或是你的终端关闭，编程 Agent 仍会在后台继续工作。它还支持 `attach` 能力，让你能随时“跳进”正在运行的会话，提供实时的指令干预。

### 3. 显式状态机
每个任务都遵循严格的生命周期：`running`（运行中）→ `pending`（待处理）→ `success`（成功） | `failed`（失败） | `stopped`（已停止）。
*   **可见性**：状态通过本地 JSON 文件追踪，支持增量的“心跳”检查，确保系统只在上报状态变化时才打扰你。

---

## 🛠️ 快速安装

只需向你的 AI Agent 提供以下提示词：

> **“安装这个 skill: https://github.com/youzaiAGI/openclaw-agent-swarm-skills/tree/main/skills/openclaw-agent-swarm”**

*前置条件：请确保宿主机已安装 `git`、`tmux` 以及至少一个 Agent CLI (`codex`、`claude` 或 `gemini`)。*

---

## 📖 快速上手（自然语言交互指南）

### 1. 启动任务
你必须指定一个目标的 **Git 仓库目录**。

*   **对话示例**：“在 `/Users/me/projects/webapp` 仓库（这是一个 git 仓库）中启动一个批处理任务，实现 Stripe 支付集成。使用 Claude Agent 并通过 `npm test` 验证。”
*   **对话示例**：“使用 Codex Agent 交互式地排查 `/path/to/repo` 目录下的内存泄漏问题。”

### 2. 状态检查与心跳
*   **主动查询**：“列出所有正在运行的编程任务及其当前进度。”
*   **自动心跳检查**：Swarm 内置了 `check-agents.sh` 脚本。在 OpenClaw 等工具中，它会定期运行，并在**任务状态发生变化时**（例如“任务 A 刚刚执行成功”）主动通知你。

### 3. 定义任务完成 (DoD)
只有满足 **「完成定义 (Definition of Done, DoD)」**，任务才算真正结束。
*   **内置校验**：Swarm 会自动检查 Worktree 是否干净，以及指定的测试命令是否返回 0。
*   **语义化校验 (`docs/dod.md`)**：你可以让 Agent 校验仓库中 `docs/dod.md` 文件定义的复杂业务规则。

**`docs/dod.md` 示例：**
```markdown
## 语义化验收标准
- [ ] 所有新函数必须包含 JSDoc 注释。
- [ ] 代码中不得包含硬编码的 API 密钥。
- [ ] 必须更新 Worktree 中的 README 文件。
```

*   **对话示例**：“验证任务 `auth-fix` 的 DoD。如果测试通过且满足 `docs/dod.md` 中的标准，则发布该分支。”

---

## 🌟 进阶能力

*   **实时干预 (Attach)**：“给任务 #101 发条消息：‘请使用更新后的 API 端点’。”
*   **取消任务 (Cancel)**：“立即停止任务 `refactor-v1` 并关闭其会话。”
*   **后续任务 (Follow-up)**：“上一个任务失败了。在同一个 Worktree 中启动一个后续任务，修复 Linter 报错。”

---

## 📂 进阶文档索引

*   [🏗️ 开发指南](development.md) - 针对想要构建或修改源码的开发者。
*   [🤝 参与贡献](../CONTRIBUTING.md) - 报告 Bug 和提交代码的指南。
*   [🏛️ 架构深度解析](architecture.md) - 深入了解 Swarm 的隔离与执行模型设计。
*   [📜 CLI 命令行完全手册](cli-reference.md) - 针对高级用户和手动 Shell 执行。
*   [✅ DoD 工作流指南](dod-workflow.md) - 深入了解内置校验与语义化校验。
*   [🤖 Agent 集成指南](agent-integration.md) - 我们如何处理不同的 AI CLI 工具。
*   [🛠️ 问题排查手册](troubleshooting.md) - 解决文件锁、会话丢失等常见问题。
*   [📝 技术深度博文](blog-openclaw-agent-swarm.md) - 关于 Swarm 核心能力深度解析。
*   [⚙️ 状态协议 & JSON 格式](../skills/openclaw-agent-swarm/references/state-format.md) - 针对开发者的技术规范。
