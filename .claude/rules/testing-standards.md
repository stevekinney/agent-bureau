---
description: Testing patterns, conventions, and tooling for all packages
globs: "**/*.ts"
---

# Testing Standards

## Test Runner

Bun's built-in test runner. No imports needed for `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `mock`.

```bash
bun test                    # Run all tests in current package
bun test src/utilities      # Run tests in a specific directory
bun test --coverage         # Generate coverage report
turbo run test              # Run all tests across the monorepo
```

## Test Location

- Tests live in `test/` directories alongside source, or as `*.test.ts` files.
- Each package may have a `tsconfig.test.json` with relaxed settings.
- ESLint rules are relaxed in test files (see `eslint.config.base.ts` `testOverrides`).

## Testing Pattern: Factory Functions and Mock Injection

This project uses factory functions with dependency injection for testability. Do not use module mocking.

```typescript
// Production: real dependencies injected at call site
const generate = createAnthropicGenerate({ client: realClient });

// Test: mock dependencies injected directly
const generate = createMockGenerate({ responses: [mockResponse] });
```

## Before Writing Tests

- Check if the package has a `src/test/` directory with existing test helpers (e.g., `createMockGenerate`, `createRunRecorder`).
- Extend existing test files when adding coverage for existing modules rather than creating new test files.
- Follow the naming and structure patterns already established in the package's test directory.

## Test Quality

- Test behavior, not implementation details.
- Each test should have a clear, descriptive name explaining the expected behavior.
- Prefer `it('returns an empty array when no tools match the query')` over `it('works')`.
