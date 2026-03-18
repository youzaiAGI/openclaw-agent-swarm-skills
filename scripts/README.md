# Scripts

- `regression-swarm.sh`: unified regression entrypoint. Runs `concurrency + dod-json` by default, supports `--suite` and `--agents`.
- `regression-swarm-concurrency.sh`: run concurrent regression tasks (`codex` + `claude` + `gemini`) in a temporary git repo, poll convergence, require DoD pass for all tasks, verify write-task commit checks, then clean up temp repo.
- `regression-swarm-dod-json.sh`: DoD JSON regression cases (ci_commands, pending check-only behavior, success-stage push/pr action execution, commit-ahead-base checks).

## Usage

```bash
./scripts/regression-swarm.sh
./scripts/regression-swarm.sh --suite concurrency --agents codex,gemini
./scripts/regression-swarm.sh --suite dod-json --agents claude
```
