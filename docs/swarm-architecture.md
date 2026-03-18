# openclaw-agent-swarm 系统架构梳理


## 1. 系统总体框架（主 Agent 调度视角）

### 1.1 目标

`openclaw-agent-swarm` 是 OpenClaw 的并发任务执行层：
- 并发启动多个 coding agent（`codex` / `claude`）
- 每任务隔离在独立 `git worktree + branch + tmux session`
- 主会话异步返回，不阻塞对话
- heartbeat 增量轮询任务变化
- 支持运行中 `attach`，结束后 `spawn-followup`

### 1.2 关键组件

- 主控制器：`swarm.ts`（源码：`skills/openclaw-agent-swarm/scripts/swarm.ts`）
- 会话运行时：`tmux`
- 任务执行器：`codex` / `claude` CLI
- 状态存储：`~/.agents/agent-swarm/tasks/<task_id>.json`
- 心跳状态：`~/.agents/agent-swarm/agent-swarm-last-check.json`
- 日志与退出码：
  - `~/.agents/agent-swarm/logs/<task_id>.log`
  - `~/.agents/agent-swarm/logs/<task_id>.exit`

### 1.3 主 Agent 的 4 个触发入口

1. `spawn`（创建子 Agent 实例）  
主 Agent 根据用户需求生成任务，并选择 `codex`/`claude` 等执行器。每个任务对应独立 worktree + tmux session。

2. `status`（查询任务进度）  
主 Agent 需要拿到的不只是 `status`，还包括运行过程信息（如 `result_excerpt`、日志尾部、等待输入迹象），用于对用户解释“当前做到哪一步”。

3. `attach` / `cancel`（运行中干预）  
用户可中途补充信息（`attach`）或停止任务（`cancel`），主 Agent 将用户指令转为对应子命令执行。

4. heartbeat `check-agents.sh`（增量状态收敛）  
主 Agent 定时调用 `check --changes-only`，只捞取状态变更任务，并携带其明细（如成功摘要、失败原因、DoD 结果），再组织为用户可读回复。

## 2. 状态机与结束判定

### 2.1 任务状态

- 非终态：`running` / `awaiting_input` / `auto_closing`
- 终态：`success` / `failed` / `stopped` / `needs_human`

### 2.2 已结束判定（核心）

状态刷新发生在 `updateStatus`：
- 若 tmux 已结束：
  - 有 exit file：`exit_code=0 -> success`，否则 `failed`
  - 无 exit file：从运行态收敛为 `stopped`
- 若 tmux 仍在运行：
  - 可能进入 idle 自动收敛并触发关闭流程
  - 关闭后仍无 exit file 时，收敛为 `stopped`
  - 关闭失败时，收敛为 `needs_human`

## 3. 关闭触发条件

`tmuxCloseSession` 的直接触发入口有三类（对应上面的 1/3/4）：

1. `spawn` 启动失败清理（agent ready 失败且已有 exit file）
2. `updateStatus` 的 idle 自动收敛路径（被 `check/status/publish/create-pr` 间接触发）
3. `cancel` 用户主动取消

### 3.1 idle 自动收敛条件

`shouldAutoClose` 规则：
- 没有 running marker（当前 marker：`esc to interrupt`）且静默达到 `idle_without_running_marker_sec`
- 或有 running marker 且静默达到 `idle_with_running_marker_sec`

默认阈值：
- `idle_without_running_marker_sec = 30`
- `idle_with_running_marker_sec = 300`

`last_activity_at` 依据日志摘要变化更新，`attach` 成功也会更新。

## 4. 如何关闭：exit 还是 kill

### 4.1 `tmuxCloseSession` 两种模式

- `graceful_then_kill`
  - 发 `/exit`
  - `sleep 1s`
  - 发 `Enter`
  - 最多等待 30s 观察 exit file
  - 最后兜底 `kill-session`
- `kill_only`
  - 直接 `kill-session`

### 4.2 当前各入口的关闭策略矩阵

1. `spawn` 启动失败清理  
- 当前策略：`kill_only`（已改为默认直接 kill）

2. idle 自动收敛（heartbeat `check`、手动 `status`、以及 `publish/create-pr` 刷新状态时触发）  
- 当前默认：`graceful_then_kill`  
- 可通过 `--close-mode kill_only` 覆盖

3. `cancel`  
- 当前 CLI 默认 `--force=true`，因此默认走 `kill_only`
- 若显式 `--force=false`，则走 `close-mode`（默认 `graceful_then_kill`）

## 5. 主 Agent 可拿到的反馈信息

主 Agent 在对用户反馈时可使用以下信息源：
- `status --id/--query`：单任务当前状态 + `taskSummary`（含 `result_excerpt`、DoD、next_step）。该路径用于“用户主动查询”，要求实时优先。
- `check --changes-only`：仅返回状态有变化的任务，附带 `from/to`、`converged_reason`、`result_excerpt`、`dod`
- 任务明细文件：`~/.agents/agent-swarm/tasks/<task_id>.json`（包含分支、session、时间戳、publish/pr/cancel 信息）

这保证了“进度反馈”不仅是状态字面值，还能携带过程信息、失败原因、完成摘要。

## 6. 时效性要求（实时 vs 准实时）

1. 用户查询进度（`status`）  
- 目标：实时反馈。  
- 原则：优先刷新单任务最新状态与过程输出，保证用户“问到即看到当前进展”。

2. 定时轮询（heartbeat -> `check-agents.sh` -> `check --changes-only`）  
- 目标：快、可扩展、准实时。  
- 原则：以增量变化为主，允许轻微延迟，但要保证状态收敛与关键结果（成功摘要/失败原因）可及时被主 Agent 获取。

## 7. 与 `success/stopped` 的关系

当前实现下，`success` 的强条件是“可读到 exit file 且 exit code 为 0”。  
因此如果会话被关闭后没有产出 exit file，会进入 `stopped`，不会判定为 `success`。

这也是“任务已完成但最终状态是 `stopped`”的根本原因：系统目前没有“无 exit file 的 success 推断”逻辑。
