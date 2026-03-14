# 告别“代码拆家”：OpenClaw Agent Swarm，为 AI Agent 穿上“束缚衣”与“助推器”


## 第一部分：愿景反差——从“盲盒开发”到“工业级编排”

以前，我们让 AI Agent 写代码，就像在开盲盒：你把需求丢给它，它在你的主目录里翻箱倒柜，改得面目全非，中途卡住了你只能干瞪眼，或者它写完了代码却跑不通。更糟糕的是，如果同时让多个 Agent 干活，你的本地 Git 仓库瞬间就会变成大型“拆家”现场。

现在，**OpenClaw Agent Swarm** 改变了这种局面。它不再是一个简单的脚本，而是一个专为 AI Agent 设计的**统一执行层 (Unified Execution Layer)**。它能让你的 Codex、Claude Code 或 Gemini 在相互隔离、可监控、可干预的环境中异步工作。简单来说，它给 AI Agent 配了一个“项目经理”，不仅管住它的手（隔离），还盯着它的进度（监控），甚至允许你随时“查岗”并补充需求（交互）。

---

## 第二部分：核心原理解析——它到底是个啥？

### 宏观定位：Agent 的“施工现场管理器”
在技术栈中，OpenClaw Agent Swarm 位于**协调型 Agent (Coordinator Agent)** 与 **执行型 Agent (Agent CLI)** 之间。它取代了过去那种“直接在 PWD 目录下调用命令行”的原始方式。

### 核心逻辑：绝妙的“工地”比喻
如果把 AI Agent 比作专业的**分包商 (Sub-contractors)**，那么 OpenClaw Agent Swarm 就是**总承包商 (General Contractor)**。
- **Git Worktree (工作树)** 就是为每个分包商开辟的**独立施工区**。分包商在里面怎么拆墙、垒砖，都不会影响到主楼（主代码库）。
- **Tmux (终端复用器)** 则是施工区的**闭路监控与对讲系统**。即使你关掉电脑，施工仍在后台继续，你随时可以接入对讲机（Attach）下达新指令。

### 价值兑现：解决“卡脖子”的隔离与可见性
它解决了 Agent 落地中最棘手的两个问题：**状态不可控**和**环境污染**。通过异步化（Async by default），它让开发者从“等待 Agent 输出”的焦虑中解脱出来，转而通过心跳检查来管理任务。

---

## 第三部分：手把手实操——让你的 Agent 跑起来

要体验这套系统，你需要准备好 **Node.js >= 18**、**Git** 和 **Tmux**。

### 1. 环境准备与构建
首先，我们需要从 TypeScript 源码编译出运行产物。

```bash
# 克隆仓库
git clone https://github.com/youzaiAGI/openclaw-agent-swarm-skills.git
cd openclaw-agent-swarm-skills

# 进入 code 目录安装依赖并构建
cd code
npm install
npm run build # 将 src/swarm.ts 编译为 scripts/swarm.js
cd ..

# 运行部署脚本
./scripts/build-skill.sh
```

### 2. 启动一个批处理任务 (Batch Mode)
假设你要修复一个内存泄漏的问题，你可以通过 `spawn` 命令创建一个后台任务：

```bash
# 定义 Skill 路径
SKILL_ROOT="skills/openclaw-agent-swarm"

# 启动任务
node "$SKILL_ROOT/scripts/swarm.js" spawn \
  --repo /path/to/your/git/repo \
  --task "Fix memory leak in buffer.ts" \
  --mode batch \
  --agent claude \
  --required-test "npm test"
```
> **注意：** `spawn` 命令会立即返回一个任务 ID，而 Agent 已经在后台的 Tmux 会话中开始工作了。

---

## 第四部分：硬核功能拆解——深度剖析 6 大核心能力

### 1. Git Worktree 物理隔离：真正的“安全屋”
传统的 Agent 往往直接操作当前目录。Swarm 强制使用 **Git 工作树 (Git Worktree)** 隔离。
- **技术细节**：每个任务都会在 `~/.agents/agent-swarm/worktree/<repo-name>/<task_id>` 下创建一个全新的工作区，并自动签出一个任务分支 `swarm/<task_id>`。
- **深度解读**：这种做法比简单的文件夹拷贝高明得多。它保留了完整的 Git 上下文，同时由于是物理隔离，你可以在主分支继续编码，而 Agent 在另一个 Worktree 里跑测试，互不干扰。

### 2. Batch 与 Interactive：双模并行
Swarm 并不是一种模式走到黑，它支持 **批处理 (Batch)** 和 **交互 (Interactive)** 两种模式。
- **技术细节**：`batch` 模式是非交互执行，主要依据退出文件 (`exit_file`) 来判定胜负；`interactive` 模式则维持一个长驻的 Tmux 会话。
- **深度解读**：对于确定的任务（如“格式化所有代码”），用 `batch`；对于需要探索的任务（如“排查一个诡异的 Bug”），用 `interactive`。这意味着你可以在 Agent 思考的过程中，随时介入。

### 3. Attach：中途下达“锦囊妙计”
这是 Swarm 最令开发者兴奋的能力——**挂载交互 (Attach)**。
- **技术细节**：通过 `node swarm.js attach --id <task_id> --message "<message>"`，你可以向正在运行的 `interactive` 任务发送文本。
- **原理**：Swarm 利用 Tmux 的 `send-keys` 将你的指令实时“粘贴”到 Agent 的输入流中。
- **注意点**：如果任务已经进入终态（Success/Failed），Attach 会被拒绝。

### 4. 任务状态定时检查：心跳 (Heartbeat) 机制
为了不让协调器被海量日志淹没，Swarm 引入了 **增量检查 (Incremental Check)**。
- **技术细节**：执行 `node swarm.js check --changes-only`，系统会对比 `last-check.json`，只上报状态发生变化的 Task。
- **深度解读**：这对于构建“任务大盘”非常有用。它甚至支持“休眠检测”，如果一个交互任务长时间没有输出，状态会自动转为 `pending` 并触发提醒。

### 5. 自定义 DoD：严苛的“完工验收单”
**完成定义 (Definition of Done, DoD)** 是 Swarm 的质量灵魂。
- **技术细节**：内置 DoD 要求任务必须达到终态、Worktree 必须 Clean，且所有 `--required-test` 命令必须返回 0。
- **回写机制**：支持手动或通过脚本调用 `update-dod --status pass|fail`。
- **价值**：它确保了 Agent 不会带着一堆未提交的脏代码或失败的测试用例就告诉你“我做完了”。

### 6. 任务继承 (Follow-up)：平滑的任务接力
当一个任务结束，但你需要基于它的成果继续修改时，`spawn-followup` 就派上用场了。
- **技术细节**：你可以选择 `new`（新工作区）或 `reuse`（复用原工作区）。
- **深度解读**：`reuse` 模式非常巧妙，它会检查原 Worktree 是否干净、分支是否可解析，并在原有的基础上继续对话，完美保留了上下文。

---

## 第五部分：高互动收尾

OpenClaw Agent Swarm 的出现，标志着 Agent 已经从“玩具时代”迈向了“工程时代”。通过将晦涩的 Git 指令和 Tmux 管理封装成一套标准的 JSON 状态机，它让大规模 Agent 协作成为可能。

**一句话总结：它是 Agent 时代的“操作系统内核”，负责资源隔离与进程调度。**

> **开放话题讨论：**
> 你觉得在本地开发中，这种基于 Worktree 的 Agent 协作模式，是否会成为未来 IDE 的标配功能？它能彻底替代目前那种“在一个对话框里修修补补”的模式吗？

欢迎在评论区分享你的看法，或者直接在 [GitHub 仓库](https://github.com/youzaiAGI/openclaw-agent-swarm-skills) 提交你的 PR！
