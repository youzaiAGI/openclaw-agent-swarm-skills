# Scripts

- `regression-swarm-concurrency.sh`: run concurrent regression tasks (`codex` + `claude` + `gemini`) in a temporary git repo, poll convergence, require DoD pass for all tasks, verify write-task commit checks, then clean up temp repo.

## Usage

```bash
./scripts/regression-swarm-concurrency.sh
```
