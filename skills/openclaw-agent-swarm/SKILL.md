---
name: openclaw-agent-swarm
description: Unified swarm skill for interactive and batch coding tasks with git worktree + tmux, incremental check, and DoD updates.
---

# Agent Swarm

Use this skill to run coding tasks asynchronously in isolated worktrees.

## Hard Rules

1. Refuse execution when target path is not a git repository.
2. Require local tools before spawn: `git`, `tmux`, and at least one of `codex` / `claude` / `gemini`.
3. Default mode is `batch`; mode can be `interactive` or `batch`.
4. `attach` is only allowed for non-terminal `interactive` tasks.
5. Task status set is fixed: `running | pending | success | failed | stopped`.
6. `check --changes-only` must only return changed tasks.
7. `check/status` must include fallback: if task is non-terminal but tmux session is gone, converge task to `stopped`.
8. DoD is checked after task reaches terminal status and can be updated by the caller agent/runtime.

## Script Directory

**Agent Execution**: Determine this SKILL.md directory as `SKILL_DIR`

| Script | Purpose |
|--------|---------|
| `$SKILL_DIR/scripts/swarm.js` | Main entry point |
| `$SKILL_DIR/scripts/check-agents.sh` | check script |
| `$SKILL_DIR/scripts/check-agents.sh` | check script |

## DoD Workflow

References:
- `$SKILL_DIR/references/dod.md`

Status model (must treat as two independent axes):
- `task.status` is execution lifecycle state: `running | pending | success | failed | stopped`.
- `task.dod.status` is acceptance state: `pass | fail` (or missing before evaluation/writeback).
- DoD changes do not rewrite `task.status`; execution status changes do not imply DoD pass.

Operational rules (must follow):
- Prefer `status --id <task_id>` for accurate single-task refresh; plain `status` only returns latest summaries.
- Default DoD is triggered only on specific terminal status transitions, not on every `check/status` call.
- `update-dod` only updates `task.dod`; it does not update `task.status`.
- `publish` requires `task.dod.status=pass` and mode-allowed status (`batch=success`, `interactive=stopped`).
- `spawn-followup new|reuse` both reuse parent worktree.
- use `--session-mode new|reuse` for follow-up behavior.
- `spawn-followup`: mode always follows parent task mode; do not rely on `--mode`.
- `spawn-followup` agent rules: `new` can specify agent (default parent agent), `reuse` must match parent agent.
- `attach` is only for non-terminal interactive tasks; successful attach writes `task.status=running`.
- Default DoD includes: mode-allowed terminal status, worktree clean, and all `required_tests` passing (each test has timeout).


How to evaluate DoD:
- Spawn/spawn-followup does not evaluate DoD; default `task.dod` is empty `{}`.
- Interactive mode: evaluate default DoD only when task transitions to `stopped`.
- Batch mode: evaluate default DoD only when task transitions to `success`.
- Batch mode: if task transitions to `failed` or `stopped`, set DoD to failed directly.
- Other `updateStatus` cases do not evaluate DoD.
- Default DoD checks are: allowed terminal status + worktree clean + all `required_tests` pass.
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
node "$SKILL_DIR/scripts/swarm.js" <subcommand> ...
```

## Quick Examples

Spawn a new batch task:

```bash
node "$SKILL_DIR/scripts/swarm.js" spawn \
  --repo /path/to/repo \
  --mode batch \
  --agent codex \
  --task "Implement feature X and commit" \
  --required-test "npm test"
```

Spawn a new interactive task:

```bash
node "$SKILL_DIR/scripts/swarm.js" spawn \
  --repo /path/to/repo \
  --mode interactive \
  --agent claude \
  --task "Investigate bug Y and keep session open"
```

Prefer single-task status refresh:

```bash
node "$SKILL_DIR/scripts/swarm.js" status --id <task_id>
```

Attach instructions to a running interactive task:

```bash
node "$SKILL_DIR/scripts/swarm.js" attach \
  --id <task_id> \
  --message "Prioritize API layer first, then update tests"
```

Cancel a running task:

```bash
node "$SKILL_DIR/scripts/swarm.js" cancel \
  --id <task_id> \
  --reason "manual stop"
```

Follow-up from a terminal task (both modes reuse parent worktree):

```bash
node "$SKILL_DIR/scripts/swarm.js" spawn-followup \
  --from <task_id> \
  --session-mode new \
  --task "Address review comments"
```

```bash
node "$SKILL_DIR/scripts/swarm.js" spawn-followup \
  --from <task_id> \
  --session-mode reuse \
  --task "Continue with previous conversation context"
```

Write back DoD from external `dod.md` validation:

```bash
node "$SKILL_DIR/scripts/swarm.js" update-dod \
  --id <task_id> \
  --status pass \
  --result '{"summary":"dod.md checks passed","error":""}'
```

Publish only when mode/status is allowed and DoD is pass:

```bash
node "$SKILL_DIR/scripts/swarm.js" publish --id <task_id> --auto-pr
```

Spawn:

```bash
node "$SKILL_DIR/scripts/swarm.js" spawn \
  --repo <git_repo_path> \
  --task "<task>" \
  [--mode interactive|batch] \
  [--agent codex|claude|gemini] \
  [--required-test "<cmd>"]...
```

Spawn follow-up:

```bash
node "$SKILL_DIR/scripts/swarm.js" spawn-followup \
  --from <task_id> \
  --task "<task>" \
  --session-mode new|reuse \
  [--agent codex|claude|gemini] \
  [--required-test "<cmd>"]...
```

Follow-up behavior:
- both `new` and `reuse` reuse parent worktree (no new worktree is created)
- mode always follows parent task mode
- `new`: starts a new session without conversation resume; agent defaults to parent agent if not specified
- `reuse`: starts a new session with conversation resume; agent must match parent agent

Attach:

```bash
node "$SKILL_DIR/scripts/swarm.js" attach --id <task_id> --message "<message>"
```

Behavior:
- if task status in `task.json` is terminal, reject attach immediately
- if task status is non-terminal, send message and set status to `running`

Cancel:

```bash
node "$SKILL_DIR/scripts/swarm.js" cancel --id <task_id> [--reason "<reason>"]
```

Check, status, and list:

```bash
node "$SKILL_DIR/scripts/swarm.js" check --changes-only
node "$SKILL_DIR/scripts/swarm.js" status --id <task_id>
node "$SKILL_DIR/scripts/swarm.js" list
```

Update DoD:

```bash
node "$SKILL_DIR/scripts/swarm.js" update-dod \
  --id <task_id> \
  --status pass \
  --result '{"summary":"dod.md checks passed","error":""}'
```

Publish and PR:

```bash
node "$SKILL_DIR/scripts/swarm.js" publish --id <task_id> [--auto-pr]
node "$SKILL_DIR/scripts/swarm.js" create-pr --id <task_id>
```

Heartbeat wrapper:

```bash
bash "$SKILL_DIR/scripts/check-agents.sh"
```

If your runtime uses a `HEARTBEAT.md`, ensure it includes:

```bash
bash "$SKILL_DIR/scripts/check-agents.sh"
```
