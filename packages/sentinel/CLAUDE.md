# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

This package lives in the `agent-bureau` monorepo under `packages/sentinel/`. Tasks are orchestrated via Turborepo from the monorepo root.

## Essential Commands

### From the monorepo root (preferred)

```bash
turbo run build --filter=sentinel        # Build this package
turbo run test --filter=sentinel         # Run tests
turbo run lint --filter=sentinel         # Lint
turbo run check-types --filter=sentinel  # Type-check
```

### Within this package directory

```bash
bun run build             # Build for production (outputs to dist/)
bun test                  # Run all tests
bun test --watch          # Watch mode
bun test --coverage       # Generate coverage report
bun run lint              # Check linting errors
bun run lint:fix          # Auto-fix linting errors
bun run check-types       # TypeScript type checking
bun run clean             # Clean build artifacts (dist/, coverage/)
```

## Architecture Overview

### Core Design Principles

1. **Redux-style store**: A single `createStore()` factory returns a `Store` that tracks all active and completed runs with an ordered action log and state snapshots.

2. **Observable integration**: Each registered `ActiveRun` is subscribed via `toObservable()`, which delivers all operative events plus forwarded `toolbox.*` and `conversation.*` events through a single stream.

3. **Snapshot capture**: `Conversation.snapshot()` is called on `step.completed` and `run.completed` events, capturing the full conversation tree state at key boundaries.

### Key Modules

- `src/types.ts` — All type definitions: `Store`, `StoreState`, `RunState`, `Action`, `RunStatus`
- `src/store.ts` — `createStore()` implementation
- `src/test/index.ts` — `createTestStore` utility for tests

### Workspace Relationships

- **operative**: Runtime dependency — provides `ActiveRun`, `toObservable()`, event types, `StepResult`, `RunResult`, `TokenUsage`, `FinishReason`
- **armorer**: DevDependency — provides `createTool`, `createToolbox` for tests
- **conversationalist**: DevDependency — provides `Conversation`, `ConversationSnapshot` for tests

### Subpath Exports

- `sentinel` — `createStore`, all types
- `sentinel/test` — `createTestStore` and test helpers

## Development Patterns

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Tests import from `../src/` directly (Bun native TypeScript execution — no build step required).
- ESLint rules are relaxed for test files (`*.test.ts`, `*.spec.ts`, `test/**`, `__tests__/**`).
- A separate `tsconfig.test.json` is available with relaxed TypeScript settings for tests.
