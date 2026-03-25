# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

This package lives in the `agent-bureau` monorepo under `packages/operative/`. Tasks are orchestrated via Turborepo from the monorepo root.

## Essential Commands

### From the monorepo root (preferred)

```bash
turbo run build --filter=operative        # Build this package
turbo run test --filter=operative         # Run tests
turbo run lint --filter=operative         # Lint
turbo run check-types --filter=operative  # Type-check
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

1. **Function-based and composable**: Uses a Vercel AI SDK-style functional API, not class-based. The user provides their own `generate` function — operative never imports an LLM SDK.

2. **Composes Armorer + Conversationalist**: Wires together a `Toolbox` (from armorer) and a `Conversation` (from conversationalist) into the standard agentic loop cycle.

3. **Event-emission surface**: `createRun()` returns an `ActiveRun` with the full event-emission API (`addEventListener`, `on`, `once`, `subscribe`, `events`, `toObservable`, `complete`, `abort`, `[Symbol.dispose]`).

### Key Modules

- `src/loop.ts` — Core loop logic shared by `run()` and `createRun()`
- `src/run.ts` — `run()` fire-and-forget entry point (no events)
- `src/create-run.ts` — `createRun()` with event emission + abort()
- `src/streaming.ts` — `withStreaming()` helper
- `src/create-context-compactor.ts` — Reusable `onCompact` factory for context window management
- `src/conditions/` — Composable stop condition predicates
- `src/test/` — Test utilities (createMockGenerate, createRunRecorder)

### Workspace Relationships

- **armorer**: Runtime dependency — provides `Toolbox` and `ToolExecutionResult`
- **conversationalist**: Runtime dependency — provides `Conversation` and `ConversationHistory`
- **interoperability**: Runtime dependency — provides shared `ToolCall`, `ToolCallInput` types
- **event-emission**: Runtime dependency — provides event target for `ActiveRun`

## Development Patterns

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Tests import from `../src/` directly (Bun native TypeScript execution — no build step required).
- ESLint rules are relaxed for test files (`*.test.ts`, `*.spec.ts`, `test/**`, `__tests__/**`).
- A separate `tsconfig.test.json` is available with relaxed TypeScript settings for tests.
