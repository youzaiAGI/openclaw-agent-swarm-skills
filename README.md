# openclaw-agent-swarm

English | [简体中文](./README.zh-CN.md)

An OpenClaw skill for orchestrating multiple coding agents in parallel:
- Run Codex and Claude Code tasks concurrently
- Isolate each task with its own git worktree + tmux session
- Support mid-task redirection via `attach`
- Track incremental status via heartbeat polling (`check --changes-only`)
- Continue finished tasks through follow-up flows (new or reused worktree)
- Let users explicitly choose `codex` or `claude` per task

## 0. Terminology

`DoD` means `Definition of Done`: the objective completion criteria a task must satisfy.
In this project, DoD is checked automatically and includes:
- task status is `success`
- task branch has commits ahead of base branch
- worktree has no uncommitted changes

## 1. Goal

This skill provides a controllable execution layer when OpenClaw needs to drive multiple engineering tasks in parallel.

Design goals:
- Async by default: `spawn` returns immediately
- Isolation: one task, one worktree, one branch, one tmux session
- Human-in-the-loop: send follow-up instructions while task is running
- Deterministic monitoring: heartbeat checks and reports only changes
- Continuation support: finished tasks can continue via guarded follow-up

## 2. Architecture

```mermaid
flowchart LR
    U[User] --> OC[OpenClaw Main Agent]
    OC --> S[openclaw-agent-swarm\nskills/openclaw-agent-swarm/SKILL.md + skills/openclaw-agent-swarm/scripts/swarm.js]

    S --> T1[tmux session A]
    S --> T2[tmux session B]
    S --> T3[tmux session N]

    T1 --> C1[Codex CLI]
    T2 --> C2[Claude CLI]
    T3 --> C3[Codex or Claude]

    C1 --> W1[git worktree A]
    C2 --> W2[git worktree B]
    C3 --> W3[git worktree N]

    S --> R[(~/.openclaw/agent-swarm/\nagent-swarm-tasks.json)]
    S --> L[(logs / prompts / exit files)]

    HB[OpenClaw HEARTBEAT] --> CK[check-agents.sh]
    CK --> S
    S --> R
```

## 3. End-to-End Flow

```mermaid
sequenceDiagram
    participant User
    participant OpenClaw
    participant Swarm as swarm.js
    participant Tmux
    participant Agent as Codex/Claude
    participant Registry as task registry

    User->>OpenClaw: "Create task A/B in parallel"
    OpenClaw->>Swarm: spawn --repo ... --task ...
    Swarm->>Swarm: create worktree + branch
    Swarm->>Tmux: new-session (per task)
    Tmux->>Agent: start interactive CLI
    Swarm->>Registry: write running task
    Swarm-->>OpenClaw: return task id/session/worktree
    OpenClaw-->>User: immediate async response

    loop heartbeat tick
        OpenClaw->>Swarm: check --changes-only
        Swarm->>Registry: update changed states
        Swarm-->>OpenClaw: changed tasks only
    end

    User->>OpenClaw: "Adjust task A: API first"
    OpenClaw->>Swarm: attach --id A --message ...
    Swarm->>Tmux: send-keys

    User->>OpenClaw: "Continue task A with follow-up"
    OpenClaw->>Swarm: spawn-followup --from A --worktree-mode new|reuse
```

## 4. Repository Layout

```text
.
├── code/                        # Source of truth (development)
│   ├── src/swarm.ts             # TypeScript implementation
│   ├── legacy/swarm.py          # Python baseline for parity checks
│   ├── scripts/parity-check.ts  # Python/TS behavior parity tests
│   └── package.json             # Build toolchain
├── scripts/                     # Repo automation scripts
│   ├── build-skill.sh           # Build TS and sync runtime artifact
│   └── regression-swarm-concurrency.sh
├── skills/openclaw-agent-swarm/ # Ship-ready skill payload
│   ├── SKILL.md
│   ├── scripts/swarm.js
│   ├── scripts/check-agents.sh
│   └── references/state-format.md
```

Build flow: `code/src/swarm.ts` -> `code/dist/src/swarm.js` -> `skills/openclaw-agent-swarm/scripts/swarm.js`

## 5. Core Behavior

### 5.1 Task Model

Tasks are stored in:
- `~/.openclaw/agent-swarm/agent-swarm-tasks.json`

Key fields:
- `id`, `agent`, `status`
- `repo`, `worktree`, `branch`, `base_branch`
- `tmux_session`
- `log`, `exit_file`
- `created_at`, `updated_at`, `last_activity_at`
- `dod` (default definition-of-done result)

### 5.2 State Machine

States:
- `running`
- `awaiting_input`
- `auto_closing`
- `success`
- `failed`
- `stopped`
- `needs_human`

Rules:
- tmux alive does not mean task still in progress
- completion is inferred from multiple signals (log semantics, idle time, exit file, process state)
- auto-close attempts to release tmux session
- unresolved close conditions escalate to `needs_human`

### 5.3 Default DoD

A task passes DoD only if:
- status is `success`
- task branch has at least one commit ahead of base branch
- worktree is clean (`git status --porcelain` empty)

### 5.4 Follow-up and Worktree Reuse

For follow-up on finished tasks:
- do not silently `attach`
- return `requires_confirmation`
- user chooses:
  - `new` (recommended): create new worktree/branch
  - `reuse`: continue on existing worktree with guardrails

Reuse guardrails:
- worktree exists and is a git worktree
- worktree is clean
- parent tmux session is not running
- branch is resolvable

## 6. CLI Usage

Set skill root:

```bash
SKILL_ROOT="$HOME/.openclaw/skills/openclaw-agent-swarm"
```

Preferred runtime (Node 18+, no npm runtime dependency):

```bash
node "$SKILL_ROOT/scripts/swarm.js" <subcommand> ...
```

Build/update skill runtime artifact from source:

```bash
./scripts/build-skill.sh
```

Spawn:

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn \
  --repo /path/to/repo \
  --task "Implement custom template feature" \
  --agent codex

node "$SKILL_ROOT/scripts/swarm.js" spawn \
  --repo /path/to/repo \
  --task "Implement custom template feature" \
  --agent claude
```

Attach:

```bash
node "$SKILL_ROOT/scripts/swarm.js" attach \
  --id 20260305-123456-ab12cd \
  --message "Prioritize API layer first"
```

Status:

```bash
node "$SKILL_ROOT/scripts/swarm.js" status --id 20260305-123456-ab12cd
node "$SKILL_ROOT/scripts/swarm.js" status --query templates
```

Follow-up:

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn-followup \
  --from 20260305-123456-ab12cd \
  --task "Address review feedback" \
  --worktree-mode new
```

Heartbeat check:

```bash
node "$SKILL_ROOT/scripts/swarm.js" check --changes-only
bash "$SKILL_ROOT/scripts/check-agents.sh"
```

Publish branch and optionally create PR/MR:

```bash
node "$SKILL_ROOT/scripts/swarm.js" publish \
  --id 20260305-123456-ab12cd \
  --auto-pr
```

Create PR/MR manually:

```bash
node "$SKILL_ROOT/scripts/swarm.js" create-pr \
  --id 20260305-123456-ab12cd
```

## 7. Heartbeat Integration (Required)

This repository does not ship a local `HEARTBEAT.md`.
Configure polling in OpenClaw's built-in `HEARTBEAT.md`:

```bash
bash "$HOME/.openclaw/skills/openclaw-agent-swarm/scripts/check-agents.sh"
```

Recommended interval: every 5-10 minutes.

## 8. Natural Language Mapping (OpenClaw)

Suggested intent mapping:
- "Create tasks in parallel" -> `spawn`
- "Check progress/status" -> `status`
- "Add new instruction to this task" -> `attach`
- "Continue this finished task" -> `spawn-followup`
- "Check changes only" -> `check --changes-only`
- "Push this finished task and open PR/MR" -> `publish --auto-pr`
- "Create PR/MR for this task" -> `create-pr`

Agent selection in chat is supported now:
- "Use codex for this task" -> `spawn --agent codex`
- "Use claude for this task" -> `spawn --agent claude`

For ambiguous task queries, return candidate tasks and ask user to pick one.

When `check` reports a task moved to `success` with DoD pass, OpenClaw should ask:
- "Task is done. Do you want to push and create PR/MR now?"
- Default policy is manual confirmation (no auto publish on heartbeat).

## 9. Requirements

- `python3`
- `git` (required)
- `tmux` (required)
- at least one of `codex` or `claude`

## 10. Safety Notes

- Agent CLIs run with dangerous/non-interrupting flags by default to avoid blocking background execution.
- This design is for trusted local development environments.
- Logs may contain code and context; apply your own retention/cleanup policy.

## 11. Roadmap

Potential extensions:
- PR + CI integration via `gh`
- auto-retry policies with retry caps
- pluggable context enrichment hooks
- finer-grained alert policies (human-actionable only)
