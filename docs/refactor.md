我现在有个新的想法，重新生成一个 skill，名字叫 agent-swarm,融合交互和非交互两种模式，支持同时生成交互和非交互两种模式的任务，统一管理

# 要求
1、之前的代码、skill、readme、docs 全部移动到 legacy 目录下，后续会删除
2、task.json、last-check.json 里面字段，需要区分任务是交互还是非交互模式的任务
3、通用的逻辑全部保留，比如判定必须是git仓库 、创建worktree、检查cli 命令是否有效（如claude --version）、任务目录在 ~/.agents/agent-swarm/等
4、你需要参考 swarm.ts 和 swarm-batch.ts 的部分模块实现，尤其是 一些bugfix，比如 send-keys 必须等待1s 再enter；进入claude 需要根据 bypass 和 trust 目录等选择不同执行方式等。但是业务流程会重构如下

# 业务流程重构
1、创建任务
  - 需要选择任务模式（交互或非交互），--mode interactive|batch 默认batch 模式。
  - 任务状态是 running；
  - 支持用户主动选择agent，默认codex 优先

  - 交互模式需要 waitForAgentReady + tmuxHandleStartupPrompts + tmuxSendText
  - 非交互模式直接传 -p 参数，不需要等待和处理 trust/bypass 提示
  - 不管什么模式，都需要 --dangerous 参数
  - 元信息保存在 task.json 文件中

2、交互模式下，任务执行过程中
  - agent执行过程中，需要把 tmux pipe-pane 过程信息输出到log文件
  - agent异常退出会有exit文件，包含状态和异常结果（正常情况下，agent不会退出，tmux session 死掉不会存在exit文件）

3、非交互模式下，任务执行过程中
  - agent执行过程中，stdout/stderr 重定向到 log 文件，但不使用 tmux pipe-pane；
  - agent执行结束后自动退出（tmux session 也会自动退出），会写入exit文件，包括状态和结果

4、交互模式下的用户操作：
  - 需要先判断任务状态是否进行中（查看task.json的状态 + tmux session 是否存在）
  - 如果任务状态进行中（task.json状态是 running、pending 且tmux session 存在）
    - 可以 attach（tmux send-keys + sleep 1 + enter），状态改为 running
    - 可以 cancel（直接kill-session）,状态改为 stopped
    - 可以 status 查询进展，这个地方需要强制查看tmux capture-pane + log tail + exit文件（如果有的话），更新 task.json 状态，再返回给用户

  - 如果任务状态结束（task.json状态是终态或tmux session 不存在）
    - attach直接拒绝
    - 可以 follow-up,逻辑看后面
    - 可以 status 查询进展，仅查看 task.json 返回即可

5、非交互模式下的用户操作
  - 需要先判断任务状态是否进行中（查看task.json的状态 + tmux session 是否存在）
  - 如果任务状态进行中（task.json状态是 running、pending 且tmux session 存在）
    - cancel（直接kill-session）,状态改为 stopped
    - 查询状态status, 查看 task.json + logtail + exit文件并更新task.json状态
    - attach 直接拒绝
  - 如果任务状态结束（task.json状态是终态或tmux session 不存在）
    - attach 直接拒绝
    - follow-up,逻辑看后面
    - 可以查询进展status，仅查看 task.json 返回即可

6、follow-up逻辑
   - 终态的任务（success、failed、stopped）如果用户需要补充信息，走follow-up逻辑，根据mode（new、reuse）判断是否新建worktree；但是task是新建的；
   - 交互模式的pendding状态任务，用户补充信息走attach，复用worktree和task，从 pending 恢复为 running

7、定时轮询
  - openclaw 会定时5分钟轮询，单例调用 check-agents.sh （使用 flock 锁定整个 check 动作）
  - check-agents.sh 里面调用 check --changes-only，维护一个 last-check.json文件，用于记录上次check的状态，可以只返回diff变化给用户
  - 需要把last-check.json 里面 24h以上的success、failed、stopped 终态任务去除掉，避免任务堆积

8、交互模式下，check的逻辑是：
  - 如果任务的 log 1分钟未更新，则触发检查和状态更新
    a、 如果任务 tmux session 已经死掉，直接改task.json 状态成 stopped
    b、 tmux session 还存在，则检查tmux capture-pane，没有 RUNNING marker（esc to interrupt）则改task.json 状态为pendding；
  - 如果任务 pendding 3h 未变化，需要返回下一步建议，openclaw会提醒用户去关闭任务session（cancel - 状态是stopped）

9、非交互模式下， check的逻辑是：
  - 如果任务存在 exit文件，则根据exit文件内容，修改task.json状态为success或failed；结果补充到task.json后，删除exit 文件
  - 如果任务不存在 exit文件，任务启动超过 3h ，需要查看log 返回下一步建议，openclaw会提醒用户去关闭任务session（cancel - 状态是stopped）

10、所有任务的状态，只有 running、pending、success、failed、stopped 状态，不能有其他状态
  - cancel的任务，需要修改task.json状态为stopped
  - 交互模式的任务，状态可能是 running、pending、stopped
  - 非交互模式的任务，状态可能是 running、success、failed、stopped

11、dod
  - 任务从 running、 pending 变成终态 success、failed、stopped 时，自动检查dod状态，补充到 task.json 返回给用户 
  - 单独在 skill 的 references 写一个 dod.md 文件，里面至少两部分，一个是提交任务的prompt里附带的(比如是否要求commit 、push、提交pr、执行某个测试脚本通过)；一个是bash脚本，自动检测是否dod的bash命令
  - dod.md 当前默认条件：
  任务状态 worktree 干净（已commit或未修改代码）；

12、提交push 和pr 
  - skill.md 里写清楚：如果任务结束并且dod 是完成的，openclaw 会建议用户去提交push 和 发布pr（如果是github的话）

13、四个文件
  - log 文件是交互模式的agent 自动追加写入；
  - exit 是非交互模式的agent 写入的，最后又定时check逻辑判定和删除；
  - task.json的更新的情况 ，定时check、用户cancel、attach；需要加任务级的文件锁
  - last-check.json文件，是check逻辑维护的，可以选择性加全局锁

---

任务文件说明

~/.agents/agent-swarm/
├── tasks/
│   ├── <taskId>.json          # 含 mode: "interactive" | "batch"
│   ├── <taskId>.json.lock     # 任务级文件锁
│   └── history/               # 归档
├── logs/
│   ├── <taskId>.log           # 两种模式都有，但来源不同
│   └── <taskId>.exit          # 交互模式仅在异常情况才出现
├── prompts/
│   └── <taskId>.txt ## attach的时候需要换行追加进来
├── worktree/
│   └── <repo-name>/<taskId>/
└── agent-swarm-last-check.json

---

历史逻辑保留（bugfix）

 - send-keys 后必须等 1s 再 enter（swarm.ts L313）：sleepMs(1000) 在 tmuxSendText 中
 - tmux startup prompts 处理（swarm.ts L331-370）：trust folder + bypass permissions
 - tmux new-session 环境变量传递 fallback（swarm.ts L384-397）：先带 -e 尝试，失败后不带 -e 重试
 - exit 文件先创建空文件再删除（swarm-batch.ts L413-414）：避免竞态
 - task 保存用 tmp+rename（swarm.ts L154-156）：原子写入
 - stale lock 自动清理（swarm.ts L97-103）：超过 120s 的锁自动移除
 - 交互模式下 ，log文件 需要处理 ANSI 清理和 tmux prompt 等杂乱信息。