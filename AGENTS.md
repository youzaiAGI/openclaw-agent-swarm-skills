# Agent Notes

- `skills/openclaw-agent-swarm/scripts/swarm.ts` is the executable source of truth.
- Run the skill with `${BUN_X}` (`bun` preferred, `npx -y bun` fallback).

## Regression Checklist (Swarm)

- Use unified script: `scripts/regression-swarm.sh` (default suite: `all`, default agents: `codex,claude,gemini`).
- You can filter agents with `--agents`, for example `--agents codex,gemini`.
- Concurrency suite creates a temporary empty git repository under `/tmp`, runs regression, then removes the temp repository automatically.
- Default concurrency workload: 12 concurrent tasks (`codex` + `claude` + `gemini`, each with `batch/interactive` x `read-only/write`).
- Concurrency suite validates:
- spawn phase has no concurrency/lock conflict failure
- all batch tasks converge to `success`, all interactive tasks converge to `success` (after scripted cancel flow)
- all tasks have DoD status `pass`
- all write tasks have at least one extra commit on top of repo init commit
- batch write samples include file + expected commit message verification for all supported agents
- DoD JSON suite validates `ci_commands`, `pending` stage check-only behavior, `success` stage push/pr execution, and commit-ahead-base checks.
- Run commands:
- `./scripts/regression-swarm.sh`
- `./scripts/regression-swarm.sh --suite concurrency --agents codex,claude,gemini`
- `./scripts/regression-swarm.sh --suite dod-json --agents codex`
