---
name: openclaw-agent-swarm
description: Unified swarm skill for interactive and batch coding tasks with git worktree + tmux, incremental check, and DoD updates.
---

# Agent Swarm

Use this skill to run coding tasks asynchronously in isolated worktrees.

## Hard Rules

1. Refuse execution when target path is not a git repository.
2. Require local tools before spawn: `git`, `tmux`, and at least one of `codex` / `claude`.
3. Default mode is `batch`; mode can be `interactive` or `batch`.
4. `attach` is only allowed for running `interactive` tasks.
5. Task status set is fixed: `running | pending | success | failed | stopped`.
6. `check --changes-only` must only return changed tasks.
7. DoD is checked after task reaches terminal status and can be updated by the caller agent/runtime.

## DoD Workflow

References:
- `references/dod.md`

How to evaluate DoD:
- Default DoD (from `swarm.ts`): task status must be `success` or `stopped`, and worktree must be clean.
- Extra DoD method 1: put semantic acceptance rules in `references/dod.md` (for example: must push, must have new commits).
- Extra DoD method 2: pass repeated `--required-test "<cmd>"` at `spawn`; all commands must exit with code `0`.
- Each required test result is recorded in `task.dod.result.checks`.

How to update `task.json` DoD:
- Caller runtime writes DoD back by calling `update-dod`.
- Writeback target is `task.dod` in `~/.agents/agent-swarm/tasks/<task_id>.json`.
- Payload schema is `status: pass|fail` and `result` object.
- If DoD checking fails due to system exception, write details into `result.error`.

## Global State

- `~/.agents/agent-swarm/tasks/<task_id>.json`
- `~/.agents/agent-swarm/agent-swarm-last-check.json`
- `~/.agents/agent-swarm/logs/<task_id>.log`
- `~/.agents/agent-swarm/logs/<task_id>.exit`
- `~/.agents/agent-swarm/prompts/<task_id>.txt`
- `~/.agents/agent-swarm/worktree/<repo-name>/<task_id>`

## Commands

```bash
SKILL_ROOT="<path-to-installed-skill>/openclaw-agent-swarm"
node "$SKILL_ROOT/scripts/swarm.js" <subcommand> ...
```

Spawn:

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn \
  --repo <git_repo_path> \
  --task "<task>" \
  [--mode interactive|batch] \
  [--agent codex|claude] \
  [--required-test "<cmd>"]...
```

Spawn follow-up:

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn-followup \
  --from <task_id> \
  --task "<task>" \
  --worktree-mode new|reuse \
  [--mode interactive|batch] \
  [--required-test "<cmd>"]...
```

Attach:

```bash
node "$SKILL_ROOT/scripts/swarm.js" attach --id <task_id> --message "<message>"
```

Cancel:

```bash
node "$SKILL_ROOT/scripts/swarm.js" cancel --id <task_id> [--reason "<reason>"]
```

Check, status, and list:

```bash
node "$SKILL_ROOT/scripts/swarm.js" check --changes-only
node "$SKILL_ROOT/scripts/swarm.js" status --id <task_id>
node "$SKILL_ROOT/scripts/swarm.js" list
```

Update DoD:

```bash
node "$SKILL_ROOT/scripts/swarm.js" update-dod \
  --id <task_id> \
  --status pass \
  --result '{"summary":"dod.md checks passed","error":""}'
```

Publish and PR:

```bash
node "$SKILL_ROOT/scripts/swarm.js" publish --id <task_id> [--auto-pr]
node "$SKILL_ROOT/scripts/swarm.js" create-pr --id <task_id>
```

Heartbeat wrapper:

```bash
bash "$SKILL_ROOT/scripts/check-agents.sh"
```

If your runtime uses a `HEARTBEAT.md`, ensure it includes:

```bash
bash "$SKILL_ROOT/scripts/check-agents.sh"
```
