# OpenClaw Agent Swarm Batch Architecture

## 1. Overview

`openclaw-agent-swarm-batch` is a non-interactive task orchestrator for coding agents.

Core model:
- OpenClaw issues commands (`spawn`, `check`, `cancel`, `spawn-followup`, `publish`).
- Each task runs in an isolated `git worktree` and a detached `tmux` session.
- Sub-agent command is non-interactive and exits naturally:
  - `codex exec --dangerously-bypass-approvals-and-sandbox "<prompt>"`
  - `claude --dangerously-skip-permissions -p "<prompt>"`
- Status converges from process/session state plus `exit_file`.

Design intent:
- Keep OpenClaw chat non-blocking.
- Keep task execution isolated and reproducible.
- Keep monitoring incremental (`check --changes-only`).
- Remove interactive complexity (`send-keys`, in-session `/exit`, mid-task attach).

## 2. Scope and Non-Goals

In scope:
- Parallel background execution.
- Follow-up continuation (`new` or `reuse` worktree).
- User cancel.
- Publish and PR/MR creation.
- Heartbeat-driven incremental reporting.

Out of scope:
- Mid-task instruction injection into a running process (`attach`).
- Automatic forced cancellation for long-running tasks.

## 3. Runtime Components

Control-plane:
- OpenClaw main agent.
- `swarm-batch.js` command entry.

Execution-plane:
- `tmux` detached sessions (one session per task).
- `codex` or `claude` non-interactive CLI process.
- `git worktree` per task.

State-plane:
- Global state root: `~/.agents/agent-swarm-batch/`
- Task registry: `tasks/*.json`
- Heartbeat cache: `agent-swarm-batch-last-check.json`
- Logs/prompts/exit artifacts in `logs/` and `prompts/`.

## 4. Command Contract

Supported commands:
- `spawn`
- `spawn-followup`
- `attach` (returns unsupported confirmation payload)
- `cancel`
- `check`
- `status`
- `list`
- `publish`
- `create-pr`

Attach behavior:
- Always returns:
  - `sent: false`
  - `requires_confirmation: true`
  - `reason: attach_not_supported_in_batch_mode`
  - actions for follow-up (`new` or `reuse`)

## 5. End-to-End Task Flow

### 5.1 Spawn

1. Validate repo and required tools (`git`, `tmux`, agent CLI).
2. Allocate task id.
3. Create worktree branch `swarm/<task_id>`.
4. Materialize prompt file.
5. Start detached `tmux` session in worktree with a shell command that:
   - reads prompt from file,
   - runs agent non-interactively,
   - writes process exit code into `exit_file`.
6. Persist task record with `status=running`.
7. Return immediately.

### 5.2 Check / Status Refresh

Refresh inputs:
- `tmux` session alive or not.
- `exit_file` exists or not.
- log tail diff.

Convergence:
- `exit_file` with code `0` => `success`.
- `exit_file` with non-zero => `failed`.
- `tmux` dead with no `exit_file` => `failed` (abnormal end).

Long-running policy:
- Default threshold: 3 hours (`10800s`).
- If still running beyond threshold:
  - keep `status=running`,
  - set task flags for user confirmation prompt,
  - do not auto-cancel.

### 5.3 Cancel

Cancel is kill-only in batch mode:
- kill task tmux session directly,
- mark task as terminal `failed`,
- set `converged_reason` with `user_cancelled:*`.

### 5.4 Follow-up

`spawn-followup --worktree-mode new`:
- create fresh worktree and branch.

`spawn-followup --worktree-mode reuse`:
- reuse parent worktree only if all guards pass:
  - worktree exists and is git,
  - worktree clean,
  - parent session not alive,
  - branch resolvable.

## 6. State Machine

Batch state set:
- `running`
- `success`
- `failed`

Transitions:
- `running -> success`
  - `exit_file` exists, exit code is `0`.
- `running -> failed`
  - `exit_file` exists, exit code is non-zero.
  - tmux session died without `exit_file`.
  - user cancel.
- `running -> running` (long task)
  - exceeds confirmation threshold, emits timeout confirmation metadata only.

Terminal states:
- `success`
- `failed`

## 7. Fallback and Guardrail Strategy

Process/session mismatch:
- Session alive + exit file exists:
  - read exit code,
  - converge state,
  - best-effort kill session for cleanup.

Session dead + no exit file:
- fail-safe to `failed` with reason `tmux_not_alive_no_exit_file`.

Long-running task:
- no implicit kill,
- set confirmation fields and emit `timeout_prompt` in check changes.

Ambiguous query in `status --query`:
- return `requires_confirmation=true` with candidates.

Publish guard:
- only allowed on `success` and DoD pass.

## 8. File Layout and Format Definitions

State root:
- `~/.agents/agent-swarm-batch/`

Subpaths:
- `tasks/<task_id>.json`
- `tasks/history/<YYYY-MM-DD>/<task_id>.json`
- `logs/<task_id>.log`
- `logs/<task_id>.exit`
- `prompts/<task_id>.txt`
- `worktree/<repo-name>/<task_id>/`
- `agent-swarm-batch-last-check.json`

### 8.1 Task File (`tasks/<task_id>.json`)

Current format is flexible JSON object (not strict-schema-enforced).

Representative shape:

```json
{
  "id": "20260309-192814-3514-codex-write1",
  "status": "success",
  "agent": "codex",
  "repo": "/tmp/swarm-batch-regrepo-66Zcm8",
  "worktree": "/Users/youzai/.agents/agent-swarm-batch/worktree/swarm-batch-regrepo-66Zcm8/...",
  "branch": "swarm/20260309-...",
  "base_branch": "master",
  "tmux_session": "swarm-batch-20260309-...",
  "task": "写任务：...",
  "parent_task_id": "",
  "worktree_mode": "new",
  "created_at": "2026-03-09T11:28:14.123Z",
  "updated_at": "2026-03-09T11:30:03.456Z",
  "last_activity_at": "2026-03-09T11:29:57.890Z",
  "converged_at": "2026-03-09T11:30:03.456Z",
  "converged_reason": "exit_file_code:0",
  "log": "/Users/youzai/.agents/agent-swarm-batch/logs/....log",
  "exit_file": "/Users/youzai/.agents/agent-swarm-batch/logs/....exit",
  "exit_code": 0,
  "result_excerpt": "...",
  "dod": {
    "checked": true,
    "pass": true,
    "commit": true,
    "clean_worktree": true,
    "reason": "ok"
  },
  "timeout_confirmation_needed": false,
  "timeout_confirmation_at": "",
  "timeout_confirmation_sec": 10800,
  "cancel": {
    "at": "",
    "by_user": true,
    "force": true,
    "method": "kill_only",
    "session_killed": true,
    "reason": ""
  },
  "publish": {},
  "pr": {}
}
```

Notes:
- Additional fields may appear over time.
- Unknown fields are tolerated by loaders.

### 8.2 Exit File (`logs/<task_id>.exit`)

Current format:
- plain text integer process exit code.

Examples:
- success: `0`
- failure: `1`
- cancelled timeout style: `124`

### 8.3 Prompt File (`prompts/<task_id>.txt`)

Plain text task prompt assembled by orchestrator:
- task id
- parent id (if follow-up)
- worktree path
- user task
- operating rules

### 8.4 Lock Format

Current lock implementation uses lock directories, not JSON lock files.

Task file lock:
- path: `tasks/<task_id>.json.lock` (directory)
- acquisition via `mkdir` (atomic), with stale cleanup.

Repo lock:
- path: `<state>/repo-<base64_repo_path>.lock` (directory)
- acquisition via `mkdir` (atomic), with stale cleanup.

Lock defaults:
- task lock wait timeout: 30s
- task lock stale: 120s
- repo lock wait timeout: 60s
- repo lock stale: 300s

## 9. Heartbeat and Incremental Reporting

Heartbeat wrapper:
- `skills/openclaw-agent-swarm-batch/scripts/check-agents.sh`
- runs `check --changes-only`.

`check --changes-only` output:
- `changes[]` contains only status-key changes.
- status-key includes timeout confirmation bit:
  - `<status>|timeout_confirm=0|1`

This allows long-running prompt events to be emitted once even when status remains `running`.

Prompt fields:
- `publish_prompt`
- `timeout_prompt` (when long-running threshold reached)

## 10. Timeout and Retention Defaults

Task running confirmation threshold:
- default: `10800s` (3h)
- CLI option: `--idle-without-running-marker-sec N`
- behavior: ask user, no auto-kill.

Refresh throttling:
- `checkRefreshLogQuietSec` default `60s`.

Archive retention:
- `archiveAgeSec` default `86400s` (1 day).

## 11. DoD Semantics

Built-in DoD passes only when:
- `status=success`
- branch has commits ahead of base
- worktree clean

Implication:
- read-only tasks intentionally have no commits and will fail default DoD.
- regression scripts should evaluate read-only expectations separately.

## 12. Regression Coverage (Batch)

Script:
- `scripts/regression-swarm-batch-concurrency.sh`

Covers:
- configurable concurrency and timeout.
- mixed read/write workload across `codex` and `claude`.
- spawn phase + convergence.
- strict baseline success criteria for main concurrent tasks.
- write/read semantic verification.
- attach unsupported contract.
- user cancel contract (`failed` expected).
- follow-up `new` and `reuse` end-to-end verification.

PASS condition:
- all assertions pass; any violation exits non-zero.

## 13. Operational Notes

1. Because agent commands run with dangerous permission flags, this mode assumes trusted repositories and explicit user intent.
2. Keep heartbeat enabled; otherwise `running` tasks may appear stale even after completion.
3. For extremely long tasks, prefer user confirmation workflow instead of automatic kill to avoid losing progress.

## 14. Appendix: JSON Schema (Draft)

This appendix provides draft schemas for downstream consumers (UI, integrations, validators).
They reflect current runtime behavior and are intentionally permissive for forward compatibility.

### 14.1 Task File Schema (`tasks/<task_id>.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://openclaw.local/schemas/swarm-batch-task.json",
  "title": "SwarmBatchTask",
  "type": "object",
  "required": ["id", "status", "agent", "repo", "worktree", "branch", "base_branch", "tmux_session", "log", "exit_file"],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "status": { "type": "string", "enum": ["running", "success", "failed"] },
    "agent": { "type": "string", "enum": ["codex", "claude"] },
    "repo": { "type": "string", "minLength": 1 },
    "worktree": { "type": "string", "minLength": 1 },
    "branch": { "type": "string", "minLength": 1 },
    "base_branch": { "type": "string", "minLength": 1 },
    "tmux_session": { "type": "string", "minLength": 1 },
    "task": { "type": "string" },
    "parent_task_id": { "type": "string" },
    "worktree_mode": { "type": "string", "enum": ["new", "reuse"] },
    "created_at": { "type": "string", "format": "date-time" },
    "updated_at": { "type": "string", "format": "date-time" },
    "last_activity_at": { "type": "string", "format": "date-time" },
    "converged_at": { "type": "string", "format": "date-time" },
    "converged_reason": { "type": "string" },
    "log": { "type": "string", "minLength": 1 },
    "exit_file": { "type": "string", "minLength": 1 },
    "exit_code": { "type": "integer" },
    "result_excerpt": { "type": "string" },
    "timeout_confirmation_needed": { "type": "boolean" },
    "timeout_confirmation_at": { "type": "string", "format": "date-time" },
    "timeout_confirmation_sec": { "type": "integer", "minimum": 1 },
    "dod": {
      "type": "object",
      "properties": {
        "checked": { "type": "boolean" },
        "pass": { "type": "boolean" },
        "commit": { "type": "boolean" },
        "clean_worktree": { "type": "boolean" },
        "reason": { "type": "string" }
      },
      "additionalProperties": true
    },
    "cancel": {
      "type": "object",
      "properties": {
        "at": { "type": "string", "format": "date-time" },
        "by_user": { "type": "boolean" },
        "force": { "type": "boolean" },
        "method": { "type": "string", "enum": ["kill_only"] },
        "session_killed": { "type": "boolean" },
        "reason": { "type": "string" }
      },
      "additionalProperties": true
    },
    "publish": { "type": "object" },
    "pr": { "type": "object" }
  },
  "additionalProperties": true
}
```

### 14.2 Exit File Schema (`logs/<task_id>.exit`)

Current implementation stores plain text integer, not JSON.  
Draft target schema (for future JSON exit file migration):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://openclaw.local/schemas/swarm-batch-exit.json",
  "title": "SwarmBatchExit",
  "type": "object",
  "required": ["task_id", "exit_code", "finished_at"],
  "properties": {
    "task_id": { "type": "string", "minLength": 1 },
    "exit_code": { "type": "integer" },
    "finished_at": { "type": "string", "format": "date-time" },
    "duration_ms": { "type": "integer", "minimum": 0 },
    "agent": { "type": "string", "enum": ["codex", "claude"] }
  },
  "additionalProperties": false
}
```

### 14.3 `check --changes-only` Response Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://openclaw.local/schemas/swarm-batch-check-changes.json",
  "title": "SwarmBatchCheckChangesResponse",
  "type": "object",
  "required": ["ok", "changes_only", "changes", "tasks"],
  "properties": {
    "ok": { "type": "boolean" },
    "registry": { "type": "string" },
    "changes_only": { "type": "boolean" },
    "changes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "to"],
        "properties": {
          "id": { "type": "string" },
          "repo": { "type": "string" },
          "worktree": { "type": "string" },
          "tmux_session": { "type": "string" },
          "from": { "type": "string" },
          "to": { "type": "string", "enum": ["running", "success", "failed"] },
          "converged_reason": { "type": "string" },
          "result_excerpt": { "type": "string" },
          "timeout_prompt": { "type": "string" },
          "publish_prompt": { "type": "string" },
          "dod": { "type": "object" }
        },
        "additionalProperties": true
      }
    },
    "tasks": {
      "type": "array",
      "items": { "type": "object" }
    }
  },
  "additionalProperties": true
}
```

### 14.4 `status` Response Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://openclaw.local/schemas/swarm-batch-status.json",
  "title": "SwarmBatchStatusResponse",
  "type": "object",
  "required": ["ok"],
  "properties": {
    "ok": { "type": "boolean" },
    "task": {
      "type": ["object", "null"],
      "properties": {
        "id": { "type": "string" },
        "agent": { "type": "string", "enum": ["codex", "claude"] },
        "repo": { "type": "string" },
        "worktree": { "type": "string" },
        "branch": { "type": "string" },
        "tmux_session": { "type": "string" },
        "status": { "type": "string", "enum": ["running", "success", "failed"] },
        "dod": { "type": "object" },
        "publish": { "type": "object" },
        "pr": { "type": "object" },
        "result_excerpt": { "type": "string" },
        "next_step": { "type": "string" }
      },
      "additionalProperties": true
    },
    "tasks": {
      "type": "array",
      "items": { "type": "object" }
    },
    "message": { "type": "string" }
  },
  "additionalProperties": true
}
```
