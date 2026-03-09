# 我为什么用 OpenClaw 调度 Codex / Claude：并发、低阻塞与更可控的工程流

如果你已经在用 Codex 或 Claude 写代码，很容易遇到一个瓶颈：

- 单会话虽然强，但串行；
- 一边写代码一边和人交互，会被上下文不断打断；
- 同时推进多个需求时，状态管理、结果回收、任务取消都很痛苦。

我这段时间在用一个组合：**OpenClaw + openclaw-agent-swarm + Codex/Claude CLI**。核心思路很简单：

- `Codex / Claude` 专注做 coding；
- `OpenClaw` 专注做人机交互与编排；
- `swarm` 负责把每个任务放到独立 worktree + tmux session 里并发跑。

这篇文章讲清楚 4 件事：

1. 为什么这套分工比“单一大模型会话”更实用；
2. 为什么在同类任务下，这样做通常更省 token；
3. 我的真实使用场景（多仓库并发、中途补充、取消、异步状态回传）；
4. 和 Claude Subagents / Agent Teams 的关键差异与边界。

---

## 1. 分工的优势：让专业 CLI 做专业的事

在这个项目里，OpenClaw 不是去替代 Codex/Claude，而是做“调度层”。

从实现上看，`openclaw-agent-swarm` 的几个关键点是：

- `spawn` 异步返回，不阻塞主会话；
- 每个任务独立 `git worktree + branch + tmux session`；
- 运行中可 `attach` 给单任务补充要求；
- heartbeat 触发 `check --changes-only`，只回传有变化的任务；
- 对结束任务走 follow-up（`new/reuse worktree`），避免脏续写。

这意味着你得到的是一个“可并发、可干预、可回溯”的执行层，而不是把所有事情都塞进同一个上下文窗口里硬扛。

---

## 2. 为什么同样需求下常常更省 token

先给结论：**把 coding 子任务下沉到 Codex/Claude CLI，再由 OpenClaw 做轻交互与状态编排，通常更省主会话 token**。

原因有三层：

- 上下文隔离：每个任务在独立会话和独立工作目录内运行，主会话不必反复携带长代码上下文；
- 增量回传：heartbeat 只返回状态变化和摘要，不需要每轮都重放完整执行过程；
- 角色分离：OpenClaw 只处理“派单/改单/收单”，coding 细节在子 agent 内部消化。

对比 Claude 官方文档里对 Agent Teams 的说明也能侧面印证：

- Agent Teams 明确是“每个 teammate 各自上下文窗口”，并且官方直接提示 token 使用会随成员数上升；
- 官方同时建议：串行任务、同文件冲突任务，用单会话或 subagents 更合适。

所以我的经验是：

- 需要多人并发式探索时，token 上升是可接受成本；
- 需要日常工程推进时，把主会话做“控制面”，把执行面下沉到专用 coding CLI，性价比更高。

---

## 3. 我的真实场景：并发、多仓库、可插话、可取消、异步回传

### 场景 A：同时发起多个任务（一个仓库或多个仓库）

我经常一次开 3~10 个任务：

- 同仓库不同模块并发；
- 多仓库并发（比如后端仓库 + 前端仓库 + 工具仓库）。

`swarm` 的隔离模型（每任务独立 worktree/session）非常适合这种“互不依赖”的任务流，不会互相污染 git 状态。

### 场景 B：任务独立推进，中途只给某个任务加需求

运行中我会经常出现这种指令：

- “只改任务 T3：先做 API，UI 延后”；
- “任务 T7 额外补一个回归测试”；
- “任务 T2 改成小步提交”。

这时直接 `attach --id <task> --message "..."`，只影响目标任务，不影响其他并发任务。

### 场景 C：我可能要取消某个任务

在当前实现里，`swarm.js` 没有单独暴露 `cancel` 子命令；实践上通常通过终止该任务对应的 tmux session 来停止执行。状态收敛逻辑会在后续 `check` 中把该任务归并到终态（典型为 `stopped`）。

这个行为非常关键：你不需要等所有任务结束，随时可以止损某个跑偏任务。

### 场景 D：OpenClaw 定时 check 并回传“有变化”的状态

这是你提到的第三点，也是这套架构最像“生产系统”的地方。

- OpenClaw 定时触发 `check-agents.sh`；
- 实际调用 `swarm check --changes-only`；
- 只拿到“状态有变化”的任务（完成摘要、失败原因、DoD 结果等）；
- 再把这些变化消息推给用户（IM 里就能看到）。

好处是：

- 主对话不被轮询噪声淹没；
- 用户不必盯着终端等待；
- 可在 IM 里随时补充、改派、停止。

---

## 4. 与 Claude Subagents / Agent Teams 的区别

这块最容易混淆，我按“控制边界”来讲。

### 4.1 OpenClaw Swarm vs Claude Subagents

Subagents（官方定义）更像“**同一 Claude 会话内的专长分工**”：

- 子 agent 在独立上下文完成任务，再把结果返回主会话；
- 适合输出可摘要、任务自包含的子问题；
- 官方也强调它有助于上下文管理和成本控制。

而 OpenClaw Swarm 是“**会话外编排**”：

- 子任务在外部 CLI 进程（Codex/Claude）+ tmux + worktree 中运行；
- OpenClaw 主会话只保留控制语义，不吞执行细节；
- 更接近工程调度器，而不是会话内 delegation。

一句话：**Subagents 偏“同会话内多角色”，Swarm 偏“跨会话跨进程任务编排”。**

### 4.2 OpenClaw Swarm vs Claude Agent Teams

Agent Teams（官方文档）是 Claude 原生的多会话协作机制，特点是：

- lead + teammates；
- teammate 之间可直接通信；
- 有共享任务列表与协作机制；
- 但官方明确：实验特性、默认关闭、且 token 成本更高。

OpenClaw Swarm 的定位不同：

- 不追求 agent 内部“自由协作讨论”，而是追求“任务隔离 + 异步执行 + 人可控介入”；
- 通过 IM 做统一人机入口，适合移动端/碎片化操作；
- 更强调工程可运维性（状态收敛、DoD、日志与 worktree 可追踪）。

如果你的任务是“多个独立工程单元并发推进”，Swarm 往往更直接；
如果你的任务是“多 agent 互相辩论/共同推理”，Agent Teams 机制更原生。

---

## 5. 一个实用决策表

- 任务独立、可拆分、希望随时从 IM 介入：用 **OpenClaw Swarm**。
- 需要在 Claude 内部做角色化分工、结果回主会话：用 **Subagents**。
- 需要多个 Claude 会话互相通信协作：用 **Agent Teams**（接受更高 token 与实验特性约束）。

---

## 6. 我当前的默认工作流

1. 在 OpenClaw 发起多个 `spawn`（按任务指定 `codex` 或 `claude`）。
2. OpenClaw heartbeat 定时跑 `check-agents.sh`，只回传变化。
3. 我在 IM 里对单任务 `attach` 补需求，必要时终止跑偏任务。
4. 任务 `success + DoD pass` 后再人工确认是否 `publish/create-pr`。

这套流的核心不是“谁更聪明”，而是：**把交互面、执行面、回收面分开**。

当你开始同时推进多个需求时，这种分层会比“一个会话硬顶到底”稳定得多。

---

## 参考资料

- OpenClaw Agent Swarm 项目说明：`README.zh-CN.md`（本仓库）
- Claude Code Docs - Subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code Docs - Agent Teams: https://code.claude.com/docs/en/agent-teams

