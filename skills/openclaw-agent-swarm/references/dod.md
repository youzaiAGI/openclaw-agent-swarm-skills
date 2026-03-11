# DoD Guide

This file defines how OpenClaw evaluates Definition of Done (DoD) for a task.

## 1. Prompt-Level Requirements

When creating a task, OpenClaw may include explicit completion requirements, for example:

- must commit
- must push
- must open PR
- must pass specific test commands

These requirements should be mirrored into `required_tests` when they are command-checkable.

## 2. Command Checks

`scripts/swarm.js` supports strong command checks through repeated `--required-test` arguments at spawn.

Example:

```bash
node swarm.js spawn \
  --repo /path/to/repo \
  --mode batch \
  --task "Implement X" \
  --required-test "npm test -- run smoke" \
  --required-test "./scripts/e2e.sh"
```

Each command is executed and recorded in `task.dod.result.checks`.

## 3. Default Conditions

Default DoD pass conditions:

- task status is terminal (`success|failed|stopped`)
- worktree is clean

Default DoD does not require `success` and does not require commit count.

## 4. Writeback Contract

OpenClaw updates DoD via:

```bash
node swarm.js update-dod --id <task_id> --result-file <dod_result.json>
```

Result JSON must include:

- `status`: `pass|fail`
- `result`: object

If DoD check process fails (system error), write details into `result.error`.
