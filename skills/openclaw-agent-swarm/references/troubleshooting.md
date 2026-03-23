# Troubleshooting

## Common Issues

**"task DoD not pass"**
- Check DoD details: `"${RUN_X[@]}" "$SKILL_DIR/scripts/swarm.ts" status --id <task-id>`
- Look at `dod.result.reason` to see what failed
- Common causes: uncommitted changes, no commits ahead of base, CI/push/PR command failures
- Fix issues and spawn follow-up, or manually update DoD if appropriate

**"attach_not_supported_in_batch_mode"**
- Batch tasks can't receive messages after spawn
- Use `spawn-followup` instead to create a new task

**"reuse_guard_failed"**
- Parent worktree is missing or invalid
- Parent tmux session is still running
- Use `--session-mode new` instead, or cancel parent first

## Tips

1. **Use descriptive task descriptions** - The agent only sees your task description, so be specific.

2. **Batch mode for well-defined tasks** - If you can describe the task completely upfront, use batch mode.

3. **Interactive mode for exploration** - Use interactive when you want to guide the agent iteratively.

4. **Use `--ci-commands` to gate quality** - Specify CI commands so DoD can validate before completion.

5. **Check logs when things fail** - Full transcript in `~/.agents/agent-swarm/logs/<task-id>.log`

6. **Follow-ups reuse worktrees** - Efficient and preserves context, but ensure parent is terminal first.

7. **Use `status --id` for accurate refresh** - Plain `status` returns cached summaries.

## Limitations

- Requires git repository (refuses to run otherwise)
- Requires tmux (for background session management)
- Requires at least one agent CLI (codex, claude, or gemini)
- PR creation requires `gh` or `glab` CLI (falls back to manual URL)
- Tasks run with `--dangerously-bypass-approvals-and-sandbox` / `--yolo` flags
- Chinese language used in `next_step` summaries and some prompts