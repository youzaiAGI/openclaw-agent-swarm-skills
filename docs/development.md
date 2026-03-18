# Development Guide

This guide is for developers who want to modify the source code or contribute to OpenClaw Agent Swarm.

## 1. Prerequisites

To build and test from source, you need:

- **Node.js**: >= 18
- **npm**: (or yarn/pnpm)
- **TypeScript**: The logic is written in `skills/openclaw-agent-swarm/scripts/swarm.ts`.
- **Runtime**: `bun` (preferred) or `npx` (fallback to `npx -y bun`).

## 2. Project Structure

- `skills/openclaw-agent-swarm/scripts/swarm.ts`: The source of truth (TypeScript, executable).
- `skills/openclaw-agent-swarm/scripts/check-agents.sh`: Polling wrapper script.

## 3. Local Development Workflow

1.  **Resolve runtime**:
    ```bash
    if command -v bun >/dev/null 2>&1; then
      BUN_X=(bun)
    elif command -v npx >/dev/null 2>&1; then
      BUN_X=(npx -y bun)
    else
      echo "Install bun first: https://bun.sh/" >&2
      exit 1
    fi
    ```

2.  **Make changes**:
    Modify `skills/openclaw-agent-swarm/scripts/swarm.ts`.

3.  **Run directly**:
    From the project root:
    ```bash
    "${BUN_X[@]}" skills/openclaw-agent-swarm/scripts/swarm.ts list
    ```

4.  **Regression Testing**:
    Run the provided test script to ensure concurrency and state logic are still sound:
    ```bash
    ./scripts/regression-swarm-concurrency.sh
    ```

## 4. Contributing

Please refer to the [CONTRIBUTING.md](../CONTRIBUTING.md) file for our contribution guidelines and code of conduct.
