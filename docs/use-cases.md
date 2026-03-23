# Use Cases & Scenarios

Real-world scenarios where Agent Swarm shines. Copy these prompts and adapt to your needs.

---

## 🎯 Feature Development

### Parallel Feature Implementation
```
Spawn 3 batch tasks in ~/my-saas-app:
1. Add dark mode toggle to the settings page
2. Implement user avatar upload with crop functionality
3. Add export to CSV for the reports module
```

**Why it works:** Each task gets its own worktree, so no merge conflicts. Work on your main branch while agents code in parallel.

### Incremental Feature Addition
```
In ~/backend-api, spawn a batch task to add rate limiting to all public endpoints.
Run 'npm test' to verify. Commit when done.
```

---

## 🐛 Bug Fixing

### Parallel Bug Fixes
```
Spawn 3 batch tasks in ~/web-app:
1. Fix the memory leak in the WebSocket connection handler
2. Resolve the race condition in the cart checkout flow
3. Fix the accessibility issue in the navigation menu
```

### Investigation + Fix Workflow
```
Step 1 (Interactive): "In ~/mobile-app, start an interactive task to investigate why push notifications are delayed on iOS"
Step 2 (After review): "Spawn a follow-up with new session to implement the fix"
```

---

## 🔧 Code Quality

### Refactoring Sprint
```
Spawn 4 batch tasks in ~/legacy-codebase:
1. Refactor the authentication module to use async/await
2. Convert the user service from callbacks to Promises
3. Update the database layer to use prepared statements
4. Add TypeScript types to the payment processing module
```

### Test Coverage Improvement
```
In ~/api-service, spawn tasks to add tests for:
1. User registration endpoint
2. Password reset flow
3. Subscription renewal logic
Run 'npm test' after each task.
```

---

## 📝 Documentation

### Documentation Generation
```
Spawn 3 batch tasks in ~/my-library:
1. Generate JSDoc comments for all exported functions in src/utils/
2. Update the README API reference section
3. Add inline comments explaining the algorithm in src/core/processor.ts
```

---

## 🔄 Maintenance Tasks

### Dependency Updates
```
In ~/project, spawn a batch task to:
1. Update all dependencies to their latest stable versions
2. Run 'npm test' to verify compatibility
3. Fix any breaking changes
```

### Codebase Cleanup
```
Spawn batch tasks to clean up ~/repo:
1. Remove unused imports across all TypeScript files
2. Delete commented-out code blocks
3. Standardize quote style to single quotes
```

---

## 🧪 Testing & CI

### Smoke Test Implementation
```
In ~/web-app, spawn a batch task to add smoke tests for:
- User login flow
- Product search
- Checkout process
Use Playwright for browser testing.
```

### Performance Benchmark
```
Spawn an interactive task in ~/api to:
1. Set up performance benchmarking for the top 10 endpoints
2. Run benchmarks and collect baseline metrics
3. Save results to benchmarks/ folder
```

---

## 🏗️ Project Setup

### New Project Bootstrap
```
In ~/new-saas, spawn parallel tasks to:
1. Set up ESLint + Prettier with TypeScript rules
2. Configure Husky pre-commit hooks
3. Add GitHub Actions CI/CD workflow
4. Create Docker Compose for local development
```

---

## 🔐 Security

### Security Audit Fixes
```
Spawn batch tasks to fix security issues in ~/app:
1. Update vulnerable dependencies flagged by npm audit
2. Implement input sanitization for all user inputs
3. Add CSRF tokens to all forms
```

---

## 📊 Data & Analytics

### Dashboard Feature
```
In ~/admin-panel, spawn a batch task to:
1. Create a new analytics dashboard page
2. Add charts for daily active users, revenue, conversion rate
3. Implement date range filter
4. Add export to PDF functionality
```

---

## 🌍 Internationalization

### i18n Implementation
```
Spawn batch tasks in ~/web-app:
1. Extract all hardcoded strings to i18n keys
2. Add Chinese translations
3. Add Japanese translations
4. Implement language switcher component
```

---

## 💡 Pro Tips

### 1. Combine with CI Commands
```
Spawn a batch task in ~/project to add a new feature.
Run 'npm run lint && npm test && npm run build' for DoD.
```

### 2. Use Follow-ups for Iteration
```
First task: "Implement basic search functionality"
Follow-up: "Add fuzzy matching and pagination to the search"
Follow-up: "Add search result highlighting"
```

### 3. Interactive for Exploration
```
Start an interactive task to explore the codebase and suggest improvements.
After review, spawn a batch follow-up to implement approved changes.
```

---

## 📋 Template

Copy and adapt:

```
In <project-path>, spawn <count> batch task(s):
1. <task-description-1>
2. <task-description-2>
3. <task-description-3>

Run '<ci-command>' to verify.
```

---

Have a great use case? [Share it with us!](https://github.com/youzaiAGI/openclaw-agent-swarm-skills/discussions)