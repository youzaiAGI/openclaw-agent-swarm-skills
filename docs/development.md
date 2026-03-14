# Development Guide

This guide is for developers who want to modify the source code or contribute to OpenClaw Agent Swarm.

## 1. Prerequisites

To build and test from source, you need:

- **Node.js**: >= 18
- **npm**: (or yarn/pnpm)
- **TypeScript**: The logic is written in `code/src/swarm.ts`.

## 2. Project Structure

- `code/src/swarm.ts`: The source of truth (TypeScript).
- `skills/openclaw-agent-swarm/scripts/swarm.js`: The compiled production script (DO NOT EDIT DIRECTLY).
- `scripts/build-skill.sh`: Synchronizes the compiled JS to the skill directory.

## 3. Local Development Workflow

1.  **Install dependencies**:
    ```bash
    cd code
    npm install
    ```

2.  **Make changes**:
    Modify `code/src/swarm.ts`.

3.  **Build and Sync**:
    From the project root:
    ```bash
    cd code && npm run build
    cd ..
    ./scripts/build-skill.sh
    ```

4.  **Regression Testing**:
    Run the provided test script to ensure concurrency and state logic are still sound:
    ```bash
    ./scripts/regression-swarm-concurrency.sh
    ```

## 4. Contributing

Please refer to the [CONTRIBUTING.md](../CONTRIBUTING.md) file for our contribution guidelines and code of conduct.
