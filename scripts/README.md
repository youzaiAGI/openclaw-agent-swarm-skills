# Scripts

- `build-skill.sh`: build `code/src/swarm.ts` and sync artifact to `skills/openclaw-agent-swarm/scripts/swarm.js`.
- `regression-swarm-concurrency.sh`: run concurrent regression tasks (`codex` + `claude`) in a temporary git repo, poll convergence, verify write-task samples, then clean up temp repo.

## Usage

```bash
./scripts/build-skill.sh
./scripts/regression-swarm-concurrency.sh
./scripts/regression-swarm-concurrency.sh 1200
./scripts/regression-swarm-concurrency.sh 1200 10
```
