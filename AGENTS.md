# Agent Notes

- `skills/openclaw-agent-swarm/scripts/swarm.ts` is the executable source of truth.
- Run the skill with `${RUN_X}` (`bun` preferred, `npx -y tsx@4.20.6` fallback).

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

## Regression Failure Triage (Mandatory)

- For any regression failure case, do not conclude from task status alone.
- Always inspect all three artifacts for each failed/suspicious task:
- `~/.agents/agent-swarm/tasks/<task_id>.json` (status transitions, converged_reason, task text, dod)
- `~/.agents/agent-swarm/logs/<task_id>.log` (actual prompt/message delivered, runtime behavior)
- `~/.agents/agent-swarm/logs/<task_id>.exit` (exit code file existence/content/mtime for batch)
- Compare timestamps across `task.json` and `.exit` mtime before judging timeout vs status-sync issues.
- If `log` content mismatches `task.json.task` under concurrency, prioritize checking tmux input path for cross-task contamination.
