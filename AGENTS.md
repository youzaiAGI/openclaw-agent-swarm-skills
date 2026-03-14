# Agent Notes

- `skills/openclaw-agent-swarm/scripts/swarm.js` is a build artifact.
- Do not edit generated `.js` files directly.
- Make changes in `code/src/*` and sync artifacts via `scripts/build-skill.sh`.

## Regression Checklist (Swarm)

- Use script: `scripts/regression-swarm-concurrency.sh`
- The script creates a temporary empty git repository under `/tmp`, runs regression, then removes the temp repository automatically.
- Fixed workload: 12 concurrent tasks (`codex` + `claude` + `gemini`, each with `batch/interactive` x `read-only/write`).
- The script validates:
- spawn phase has no concurrency/lock conflict failure
- all batch tasks converge to `success`, all interactive tasks converge to `stopped`
- all tasks have DoD status `pass`
- all write tasks have at least one extra commit on top of repo init commit
- batch write samples include file + expected commit message verification for all supported agents
- Run command:
- `./scripts/regression-swarm-concurrency.sh`
