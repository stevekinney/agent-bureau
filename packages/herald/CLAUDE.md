# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

This package lives in the `agent-bureau` monorepo under `packages/herald/`. Tasks are orchestrated via Turborepo from the monorepo root.

## Essential Commands

### From the monorepo root (preferred)

```bash
turbo run build --filter=herald        # Build this package
turbo run test --filter=herald         # Run tests
turbo run lint --filter=herald         # Lint
turbo run check-types --filter=herald  # Type-check
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

1. **Factory functions, not classes**: Each provider exposes a single `create*Generate()` factory that returns a `GenerateFunction` from operative. No class hierarchies.

2. **Dynamic SDK imports**: SDKs are never imported at module level. When no `client` is provided, the factory dynamically imports the SDK. This means users only need to install the SDKs they actually use.

3. **Structural client interfaces**: Herald defines minimal interfaces for the SDK surface it calls. Tests inject mock clients directly — no module mocking required.

4. **Adapter delegation**: Herald does not convert messages or tools itself. It delegates to conversationalist adapters (for conversation) and armorer adapters (for tools and tool call parsing).

### Key Modules

- `src/anthropic.ts` — `createAnthropicGenerate` factory
- `src/openai.ts` — `createOpenAIGenerate` factory
- `src/gemini.ts` — `createGeminiGenerate` factory
- `src/types.ts` — All provider option interfaces and structural client types
- `src/errors.ts` — `HeraldError` class wrapping SDK errors
- `src/test/` — Mock clients, fixtures, and test helpers

### Workspace Relationships

- **operative**: DevDependency — provides `GenerateFunction`, `GenerateContext`, `GenerateResponse` types
- **armorer**: Runtime dependency — provides tool adapters (`toAnthropicTools`, `parseAnthropicToolCalls`, etc.)
- **conversationalist**: Runtime dependency — provides conversation adapters (`toAnthropicMessages`, `toOpenAIMessagesGrouped`, `toGeminiMessages`)
- **interoperability**: Runtime dependency — provides shared `ToolCallInput` types

### Subpath Exports

- `herald` — all three factories, `HeraldError`, types
- `herald/anthropic` — `createAnthropicGenerate` only
- `herald/openai` — `createOpenAIGenerate` only
- `herald/gemini` — `createGeminiGenerate` only
- `herald/test` — mock clients, fixtures, convenience helpers

## Development Patterns

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Tests import from `../src/` directly (Bun native TypeScript execution — no build step required).
- All provider tests inject mock clients — no real API calls.
- ESLint rules are relaxed for test files (`*.test.ts`, `*.spec.ts`, `test/**`, `__tests__/**`).
- A separate `tsconfig.test.json` is available with relaxed TypeScript settings for tests.

### Error Handling Pattern

All SDK errors are wrapped in `HeraldError` with:

- `provider` — which SDK threw
- `statusCode` — extracted from the error if available
- `retryable` — `true` for 429, 500, 503; integrates with operative's `retry.shouldRetry`
