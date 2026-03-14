# Getting Started

Follow these steps to set up and run OpenClaw Agent Swarm in your local environment.

## 1. Prerequisites

Before installing, ensure your system has the following tools:

- **OS**: macOS or Linux (support for `flock` is required for safe concurrent checks).
- **Node.js**: Version 18 or higher.
- **Git**: Installed and configured.
- **Tmux**: Required for persistent background execution.
- **Agent CLIs**: At least one of the following must be in your `PATH`:
  - `codex`
  - `claude`
  - `gemini`

## 2. Installation

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/youzaiAGI/openclaw-agent-swarm-skills.git
   cd openclaw-agent-swarm-skills
   ```

2. **Build the Source**:
   The logic is written in TypeScript and needs to be compiled to JavaScript for execution.
   ```bash
   cd code
   npm install
   npm run build
   cd ..
   ```

3. **Deploy the Skill**:
   Use the provided build script to sync the compiled JS into the skill payload directory.
   ```bash
   ./scripts/build-skill.sh
   ```

## 3. Configuration

OpenClaw Agent Swarm maintains its state in `~/.agents/agent-swarm/`. You don't need to manually configure this, but it's good to know where your logs and task data are stored.

## 4. Your First Task

To start a simple batch task that checks out a repository and runs a command:

```bash
# Define the skill entry point
SWARM_JS="skills/openclaw-agent-swarm/scripts/swarm.js"

# Spawn a task
node "$SWARM_JS" spawn \
  --repo /path/to/your/git/repo \
  --task "Run a simple code cleanup" \
  --mode batch \
  --agent claude
```

## 5. Next Steps

- Explore [CLI Reference](cli-reference.md) for more commands.
- Learn about the [Architecture](architecture.md).
- Understand the [DoD Workflow](dod-workflow.md).
