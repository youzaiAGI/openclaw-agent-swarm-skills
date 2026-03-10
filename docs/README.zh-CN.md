# openclaw-agent-swarm

用于 OpenClaw 的统一任务编排 skill，基于 `git worktree + tmux` 运行多个隔离的 coding agent 任务。

当前仓库只保留一个实现，同时支持两种任务模式：
- `interactive`：长驻 tmux 会话，可 `attach`
- `batch`：非交互执行，不支持 `attach`

英文主文档见 [README.md](../README.md)。

## 环境要求

- macOS 或 Linux
- Node.js `>= 18`
- `git`
- `tmux`
- 至少安装一个 agent CLI，并且在 `PATH` 中可用
- 当前支持：`codex`、`claude`

目标目录必须已经是 git 仓库，否则 `agent-swarm` 会拒绝执行。

## 安装

从 GitHub 克隆：

```bash
git clone https://github.com/<your-org>/openclaw-agent-swarm.git
cd openclaw-agent-swarm
```

安装构建依赖：

```bash
cd code
npm install
cd ..
```

构建运行产物：

```bash
./scripts/build-skill.sh
```

把生成后的 skill 安装到 OpenClaw 目录：

```bash
mkdir -p "$HOME/.openclaw/skills"
rm -rf "$HOME/.openclaw/skills/openclaw-agent-swarm"
cp -R skills/openclaw-agent-swarm "$HOME/.openclaw/skills/openclaw-agent-swarm"
```

## 运行目录

生成的 skill 目录：

- `skills/openclaw-agent-swarm/SKILL.md`
- `skills/openclaw-agent-swarm/scripts/swarm.js`
- `skills/openclaw-agent-swarm/scripts/check-agents.sh`

本地运行时状态目录：

- `~/.agents/agent-swarm/tasks/<task-id>.json`
- `~/.agents/agent-swarm/tasks/history/<yyyy-mm-dd>/<task-id>.json`
- `~/.agents/agent-swarm/logs/<task-id>.log`
- `~/.agents/agent-swarm/logs/<task-id>.exit`
- `~/.agents/agent-swarm/prompts/<task-id>.txt`
- `~/.agents/agent-swarm/worktree/<repo-name>/<task-id>/`
- `~/.agents/agent-swarm/agent-swarm-last-check.json`

## 命令用法

先设置安装后的 skill 根目录：

```bash
SKILL_ROOT="$HOME/.openclaw/skills/openclaw-agent-swarm"
```

主入口：

```bash
node "$SKILL_ROOT/scripts/swarm.js" <command> ...
```

创建 batch 任务：

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn \
  --repo /path/to/repo \
  --mode batch \
  --task "实现功能 X" \
  --agent codex
```

创建 interactive 任务：

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn \
  --repo /path/to/repo \
  --mode interactive \
  --task "排查并修复问题 Y" \
  --agent claude
```

给运行中的 interactive 任务补充要求：

```bash
node "$SKILL_ROOT/scripts/swarm.js" attach \
  --id <task-id> \
  --message "先收敛 API 层，不处理 UI"
```

对已结束任务创建 follow-up：

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn-followup \
  --from <task-id> \
  --worktree-mode new \
  --task "根据 review 意见继续修改"
```

检查状态：

```bash
node "$SKILL_ROOT/scripts/swarm.js" status --id <task-id>
node "$SKILL_ROOT/scripts/swarm.js" check --changes-only
```

取消任务：

```bash
node "$SKILL_ROOT/scripts/swarm.js" cancel --id <task-id> --reason "手动停止"
```

发布或创建 PR：

```bash
node "$SKILL_ROOT/scripts/swarm.js" publish --id <task-id> --auto-pr
node "$SKILL_ROOT/scripts/swarm.js" create-pr --id <task-id>
```

## OpenClaw 集成

如果你需要周期性收敛任务状态，请在 OpenClaw heartbeat 中调用 skill 内脚本：

```bash
bash "$HOME/.openclaw/skills/openclaw-agent-swarm/scripts/check-agents.sh"
```

这个脚本使用 `flock` 保证同一时刻只运行一个检查周期。

## 开发约定

- 不要直接修改生成出来的 `.js` 文件
- 源码修改只放在 `code/src/*`
- 修改后通过 `./scripts/build-skill.sh` 同步产物
- `check-agents.sh` 属于 skill 运行目录：`skills/openclaw-agent-swarm/scripts/`
- 旧的分离式实现和历史文档保留在 `legacy/`

## 开发命令

构建：

```bash
./scripts/build-skill.sh
```

类型检查：

```bash
cd code
npm run check
```

并发回归：

```bash
./scripts/regression-swarm-concurrency.sh
./scripts/regression-swarm-concurrency.sh 1200 20
```
