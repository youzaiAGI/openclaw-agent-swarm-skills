# Contributing to OpenClaw Agent Swarm

Thank you for your interest in contributing to the project! We welcome contributions of all kinds, from reporting bugs to suggesting new features.

## How to Contribute

1.  **Report Bugs**: Open an issue describing the problem and how to reproduce it.
2.  **Suggest Features**: Share your ideas for new functionalities.
3.  **Code Contributions**:
    - **Fork and Clone**: Fork the repository and clone it to your local machine.
    - **Edit TypeScript**: All logic lives in `code/src/swarm.ts`.
    - **Build and Sync**: Run `cd code && npm run build` and then `./scripts/build-skill.sh` to update the production JavaScript.
    - **Run Tests**: Use `./scripts/regression-swarm-concurrency.sh` to verify your changes.
    - **Submit a Pull Request**: Provide a clear description of your changes and why they are beneficial.

## Code of Conduct

- Be respectful and professional.
- Use clear and concise commit messages.
- Ensure your changes follow existing project style and conventions.
- If you're fixing a bug, include a clear reproduction scenario or a test case.

## Important Note

The `skills/openclaw-agent-swarm/scripts/swarm.js` file is **generated**. Any changes made directly to this file will be lost upon the next build. Always modify `code/src/swarm.ts`.

---

Let's build a more intelligent and reliable agent execution layer together!
