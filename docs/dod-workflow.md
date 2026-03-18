# DoD (Definition of Done) Workflow

The Definition of Done (DoD) ensures that every task completed by an agent meets the expected quality and correctness standards before it is promoted.

## 1. DoD Structure

A DoD check results in a `pass` or `fail` status, stored within the task's JSON metadata under the `dod` field.

### Status Transitions
- DoD is evaluated when a task transitions to `pending` or `success`.
- `pending` runs checks only; publish actions are skipped.
- `success` runs checks and then executes publish actions if configured.

## 2. Built-in Checks

The Swarm executor performs checks based on `task.dod_spec`:

1. **Allowed Status**: `task.status` must be included in `dod_spec.allowed_statuses` (default: `pending`, `success`).
2. **Worktree Cleanliness**: If `dod_spec.require_clean_worktree=true`, `git status --porcelain` must be empty.
3. **Ahead-of-Base Commits**: If `dod_spec.require_commits_ahead_base=true`, branch must have commits ahead of `base_branch`.
4. **CI Commands**: Each entry in `dod_spec.ci_commands` must exit with code `0`.
5. **Publish Actions** (`success` only): run `dod_spec.push_command` and `dod_spec.pr_command` when they are non-empty.

## 3. DoD Spec Input

`spawn` and `spawn-followup` accept DoD spec input:

- `--ci-commands "<cmd1,cmd2>"`
- `--dod-json '<json-object>'`
- `--dod-json-file <path>`

Example:

```json
{
  "allowed_statuses": ["pending", "success"],
  "require_clean_worktree": true,
  "require_commits_ahead_base": false,
  "ci_commands": ["npm run lint", "npm test -- --run"],
  "push_command": "",
  "pr_command": ""
}
```

## 4. `update-dod` Command

`update-dod` is still available for manual override or external semantic checks.

## 5. Implementation Notes

- If a system error occurs during DoD evaluation, it should be recorded in the `dod.result.error` field.
- The `publish` command requires a passing DoD status before it will allow code to be pushed to the remote.
