# DoD (Definition of Done) Workflow

The Definition of Done (DoD) ensures that every task completed by an agent meets the expected quality and correctness standards before it is promoted.

## 1. DoD Structure

A DoD check results in a `pass` or `fail` status, stored within the task's JSON metadata under the `dod` field.

### Status Transitions
- **Interactive Mode**: DoD is evaluated when a task transitions to `stopped`.
- **Batch Mode**: DoD is evaluated when a task transitions to `success`.
- **Failure Cases**: If a task enters a terminal `failed` or `stopped` state (in batch mode), it is marked as `fail` by default.

## 2. Built-in Checks

The Swarm executor performs the following automated checks:

1. **Terminal Status**: The task must have reached a final status.
2. **Worktree Cleanliness**: The `git status --porcelain` command must return an empty output, ensuring all changes are committed.
3. **Required Tests**: If `--required-test` was passed during `spawn`, each command must exit with code `0`.

## 3. Custom Semantic Checks

Beyond built-in checks, you can define higher-level semantic rules. These rules are typically validated by the coordinator (the agent driving the swarm).

### Example Rules
- "The changes must follow the project's naming conventions."
- "The documentation must be updated accordingly."
- "There must be at least one new test file."

## 4. `update-dod` Command

Once semantic validation is complete, the coordinator should use the `update-dod` command to record the result.

```bash
if command -v bun >/dev/null 2>&1; then BUN_X=(bun); elif command -v npx >/dev/null 2>&1; then BUN_X=(npx -y bun); else echo "Install bun: https://bun.sh/" >&2; exit 1; fi
"${BUN_X[@]}" skills/openclaw-agent-swarm/scripts/swarm.ts update-dod \
  --id <task-id> \
  --status pass \
  --result '{"summary":"All semantic checks and required tests passed","error":""}'
```

## 5. Implementation Notes

- If a system error occurs during DoD evaluation, it should be recorded in the `dod.result.error` field.
- The `publish` command requires a passing DoD status before it will allow code to be pushed to the remote.
