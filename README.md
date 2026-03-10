# openclaw-agent-swarm

Unified OpenClaw skill for running coding agents in isolated `git worktree + tmux` tasks.

This repository now ships a single implementation that supports both task modes:
- `interactive`: long-lived tmux session, supports `attach`
- `batch`: non-interactive agent run inside tmux, no `attach`

Chinese documentation is available at [docs/README.zh-CN.md](/Users/youzai/Desktop/openclaw-agent-swarm-skills/docs/README.zh-CN.md).

## Requirements

- macOS or Linux
- Node.js `>= 18`
- `git`
- `tmux`
- At least one agent CLI installed and available in `PATH`
- Supported agents: `codex`, `claude`

The target repository must already be a valid git repository. `agent-swarm` refuses to run outside git worktrees.

## Install

Clone from GitHub:

```bash
git clone https://github.com/<your-org>/openclaw-agent-swarm.git
cd openclaw-agent-swarm
```

Install build dependencies:

```bash
cd code
npm install
cd ..
```

Build the runtime artifact:

```bash
./scripts/build-skill.sh
```

Install the generated skill into your OpenClaw skills directory:

```bash
mkdir -p "$HOME/.openclaw/skills"
rm -rf "$HOME/.openclaw/skills/openclaw-agent-swarm"
cp -R skills/openclaw-agent-swarm "$HOME/.openclaw/skills/openclaw-agent-swarm"
```

## Runtime Layout

Generated skill payload:

- `skills/openclaw-agent-swarm/SKILL.md`
- `skills/openclaw-agent-swarm/scripts/swarm.js`
- `skills/openclaw-agent-swarm/scripts/check-agents.sh`

Runtime state on the local machine:

- `~/.agents/agent-swarm/tasks/<task-id>.json`
- `~/.agents/agent-swarm/tasks/history/<yyyy-mm-dd>/<task-id>.json`
- `~/.agents/agent-swarm/logs/<task-id>.log`
- `~/.agents/agent-swarm/logs/<task-id>.exit`
- `~/.agents/agent-swarm/prompts/<task-id>.txt`
- `~/.agents/agent-swarm/worktree/<repo-name>/<task-id>/`
- `~/.agents/agent-swarm/agent-swarm-last-check.json`

## Command Usage

Set the installed skill root:

```bash
SKILL_ROOT="$HOME/.openclaw/skills/openclaw-agent-swarm"
```

Main entrypoint:

```bash
node "$SKILL_ROOT/scripts/swarm.js" <command> ...
```

Create a batch task:

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn \
  --repo /path/to/repo \
  --mode batch \
  --task "Implement feature X" \
  --agent codex
```

Create an interactive task:

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn \
  --repo /path/to/repo \
  --mode interactive \
  --task "Investigate and patch bug Y" \
  --agent claude
```

Attach to a running interactive task:

```bash
node "$SKILL_ROOT/scripts/swarm.js" attach \
  --id <task-id> \
  --message "Narrow the scope to the API layer first"
```

Create a follow-up task from a terminal task:

```bash
node "$SKILL_ROOT/scripts/swarm.js" spawn-followup \
  --from <task-id> \
  --worktree-mode new \
  --task "Address review feedback"
```

Check status:

```bash
node "$SKILL_ROOT/scripts/swarm.js" status --id <task-id>
node "$SKILL_ROOT/scripts/swarm.js" check --changes-only
```

Cancel a task:

```bash
node "$SKILL_ROOT/scripts/swarm.js" cancel --id <task-id> --reason "manual stop"
```

Publish or create a PR:

```bash
node "$SKILL_ROOT/scripts/swarm.js" publish --id <task-id> --auto-pr
node "$SKILL_ROOT/scripts/swarm.js" create-pr --id <task-id>
```

## OpenClaw Integration

For periodic status convergence, configure OpenClaw heartbeat to call the skill-local wrapper:

```bash
bash "$HOME/.openclaw/skills/openclaw-agent-swarm/scripts/check-agents.sh"
```

This wrapper uses `flock` so only one check cycle runs at a time.

## Development

Source of truth:

- [swarm.ts](/Users/youzai/Desktop/openclaw-agent-swarm-skills/code/src/swarm.ts)
- [build-skill.sh](/Users/youzai/Desktop/openclaw-agent-swarm-skills/scripts/build-skill.sh)
- [SKILL.md](/Users/youzai/Desktop/openclaw-agent-swarm-skills/skills/openclaw-agent-swarm/SKILL.md)

Build:

```bash
./scripts/build-skill.sh
```

Type-check:

```bash
cd code
npm run check
```

Regression:

```bash
./scripts/regression-swarm-concurrency.sh
./scripts/regression-swarm-concurrency.sh 1200 20
```

## Project Conventions

- Do not edit generated `.js` artifacts directly.
- Make code changes under `code/src/*`.
- Rebuild artifacts with `./scripts/build-skill.sh`.
- `check-agents.sh` belongs to the shipped skill under `skills/openclaw-agent-swarm/scripts/`.
- Historical split-mode code and older docs are kept under `legacy/`.

## License

See [LICENSE](/Users/youzai/Desktop/openclaw-agent-swarm-skills/LICENSE).
