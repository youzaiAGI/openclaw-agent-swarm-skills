# Advanced Usage

## Custom DoD with JSON Spec

```bash
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Implement user profile page" \
  --mode batch \
  --ci-commands "npm run lint,npm test -- --run,npm run type-check" \
  --dod-json-file "$SKILL_DIR/references/dod.json"
```

Each CI command must pass for DoD to succeed. Commands run with 5-minute timeout.

## Reusing Worktrees for Follow-ups

```bash
# Original task
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn \
  --repo ~/projects/myapp \
  --task "Add user authentication" \
  --mode interactive \
  --dod-json-file "$SKILL_DIR/references/dod.json"

# After it stops, continue in same worktree with conversation history
"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" spawn-followup \
  --from <task-id> \
  --task "Now add password reset functionality" \
  --session-mode reuse \
  --dod-json-file "$SKILL_DIR/references/dod.json"
```

**Session mode comparison:**
- `new`: Fresh agent session, same worktree (good for fixing failures)
- `reuse`: Continues conversation, same worktree (good for iterative work)

## Automatic Reminders

The `check` command tracks long-running tasks and emits reminders:

- **Interactive pending**: Reminder after 3 hours of inactivity
- **Batch running**: Reminder after 3 hours of execution
- Max 3 reminders per task, one per hour

Set up a cron to run `check-agents.sh` every 10-15 minutes for automatic notifications.