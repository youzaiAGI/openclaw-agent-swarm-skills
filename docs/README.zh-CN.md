# OpenClaw Agent Swarm

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-blue.svg)](../skills/openclaw-agent-swarm/scripts/swarm.ts)

**OpenClaw Agent Swarm** 是一个为 AI Agent（如 Codex、Claude Code、Gemini）设计的鲁棒执行层。它通过 **物理隔离**、**执行持久化** 和 **显式状态追踪**，使 Agent 能够并行处理复杂的编程任务。

[English](../README.md) | 简体中文

---

## 🚀 工作原理

```
1. 启动 (Spawn) → 创建隔离的 Git Worktree + 在 Tmux 中启动 Agent
2. 检查 (Check) → 监控状态，仅报告变更内容
3. 复核 (Review) → 验证完成定义 (DoD)（状态/CI/Worktree 校验）
4. 发布 (Publish) → 自动推送分支并创建 PR
```

每个任务都在独立的 Worktree 中运行，因此你可以同时进行多个功能的开发而不会产生冲突。

---

## 🏗️ 架构与设计理念

Swarm 构建于三大支柱之上，确保 AI Agent 在专业的开发环境中能够既安全又有效地工作。

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
*   **可见性**：状态通过本地 JSON 文件追踪，支持增量的“心跳”检查，仅在上报状态变化时才产生输出。

---

## 🛠️ 安装指南

### Claude Code 用户

直接告诉 Claude 安装该 Skill：

```
安装这个 skill: https://github.com/youzaiAGI/openclaw-agent-swarm-skills/tree/main/skills/openclaw-agent-swarm
```

### 环境要求

请确保已安装以下工具：
- `git`（必须）
- `tmux`（必须）
- 至少一个 Agent CLI：`codex`、`claude` 或 `gemini`（必须）
- 可选：`gh` (GitHub CLI) 或 `glab` (GitLab CLI) 用于自动创建 PR

### 验证安装

```bash
git --version
tmux -V
claude --version  # 或 codex --version, 或 gemini --version
```

---

## 📖 快速上手

### 1. 启动任务

告诉 Claude 在 Git 仓库中启动一个后台任务：

**批处理模式**（运行后即不管）：
```
在 ~/projects/my-app 中启动一个批处理任务，为 API 端点添加错误处理。
运行 'npm test' 验证是否正常工作。
```

**交互模式**（你可以发送后续消息）：
```
在 ~/projects/backend 中启动一个交互式任务来排查内存泄漏。
使用 codex，并允许我稍后发送消息。
```

### 2. 检查状态

监控你的任务：
```
检查所有 agent swarm 任务并显示变更。
```

或者检查特定任务：
```
任务 abc123 的状态是什么？
```

### 3. 复核与发布

当任务成功完成时：
```
发布任务 abc123 并自动创建 PR。
```

### 4. 处理失败

如果任务失败，启动一个后续任务：
```
任务 xyz789 失败了。在同一个 worktree 中启动一个后续任务来修复 linter 错误。
```

---

## 🎯 完成定义 (DoD)

任务只有在通过 DoD 验证后才被视为完成。Swarm 会自动检查：

1. **状态允许** - `task.status` 必须命中 `dod_spec.allowed_statuses`（默认 `pending/success`）。
2. **Worktree 干净** - 默认要求无未提交变更。
3. **CI 命令通过** - `dod_spec.ci_commands` 中所有命令必须返回 0。
4. **可选 ahead 校验** - 可要求相对 base 分支存在新增 commit。
5. **success 阶段动作** - 可执行 `push_command` / `pr_command`（为空则跳过）。

**DoD 规格模板**：参考 `skills/openclaw-agent-swarm/references/dod.json`，通过 `--dod-json` 或 `--dod-json-file` 传入。

只有 `dod.status=pass` 的任务才可以被发布。

---

## 🌟 进阶能力

### 接入正在运行的任务
实时向交互式任务发送消息：
```
给任务 abc123 发条消息：“请改用 v2 版本的 API 端点”
```

### 取消任务
立即停止正在运行的任务：
```
取消任务 xyz789，因为需求发生了变化
```

### 后续任务 (Follow-up)
在任务结束后，继续在同一个 Worktree 中工作：

**新会话**（代码相同，对话重新开始）：
```
为任务 abc123 启动一个带有新会话的后续任务，以添加单元测试
```

**复用会话**（延续之前的对话）：
```
为任务 abc123 启动一个复用会话的后续任务，以修复剩余问题
```

---

## 🔧 常见问题

**任务卡在 `pending` 状态**
- 交互式任务正在等待输入。使用 `attach` 发送消息或使用 `cancel` 停止它。

**DoD 失败，提示 "worktree not clean"**
- Agent 没有提交变更。检查日志，然后启动一个后续任务来提交它们。

**"tmux session not found"**
- 会话崩溃了。检查 `~/.agents/agent-swarm/logs/<task_id>.log` 以获取错误信息。

**无法发布 - "DoD not pass"**
- 在 Worktree 中手动运行 `ci_commands`，查看失败原因。
- 检查任务 JSON 中的 `task.dod.result.checks` 获取详细信息。

更多解决方案请参阅 [问题排查手册](troubleshooting.md)。

---

## 📂 文档索引

### 用户指南
- [🏛️ 架构深度解析](architecture.md) - 深入了解隔离与执行模型的设计
- [✅ DoD 工作流指南](dod-workflow.md) - 内置校验与语义化校验详解
- [🛠️ 问题排查手册](troubleshooting.md) - 常见问题及解决方案

### 开发者参考
- [🏗️ 开发指南](development.md) - 构建与修改源码
- [📜 CLI 命令行手册](cli-reference.md) - 直接使用 Shell 命令的参考
- [🤖 Agent 集成指南](agent-integration.md) - 如何处理不同的 AI CLI 工具
- [⚙️ 状态协议 & JSON 格式](../skills/openclaw-agent-swarm/references/state-format.md) - JSON Schema 与存储规范

### 参与贡献
- [🤝 参与贡献](../CONTRIBUTING.md) - 报告 Bug 和提交代码的指南

---

## 📝 开源协议

MIT License - 详见 [LICENSE](../LICENSE) 文件。
