# Scripts

- `build-skill.sh`: build `code/src/swarm.ts` and sync artifact to `skills/openclaw-agent-swarm/scripts/swarm.js`.
- `regression-swarm-concurrency.sh`: run concurrent regression tasks (`codex` + `claude` + `gemini`) in a temporary git repo, poll convergence, require DoD pass for all tasks, verify write-task commit checks, then clean up temp repo.

## Usage

```bash
./scripts/build-skill.sh
./scripts/regression-swarm-concurrency.sh
```
