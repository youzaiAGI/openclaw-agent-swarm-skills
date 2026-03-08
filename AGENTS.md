# Agent Notes

- `skills/openclaw-agent-swarm/scripts/swarm.js` is a build artifact.
- Do not edit generated `.js` files directly.
- Make changes in `code/src/*` and sync artifacts via `scripts/build-skill.sh`.

## Regression Checklist (Swarm)

- Use script: `scripts/regression-swarm-concurrency.sh`
- The script creates a temporary empty git repository under `/tmp`, runs regression, then removes the temp repository automatically.
- Fixed workload: 20 concurrent tasks (`codex` 10 + `claude` 10), mixed read-only and write tasks.
- The script validates:
- spawn phase has no concurrency/lock conflict failure
- all 20 tasks converge from `running` to terminal status (`stopped`/`success`/`failed`/`needs_human`)
- write-task samples include file + expected commit verification for both agents
- Run command:
- `./scripts/regression-swarm-concurrency.sh`
- Optional timeout (seconds), default `900`:
- `./scripts/regression-swarm-concurrency.sh 1200`
