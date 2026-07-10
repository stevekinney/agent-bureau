# Integration

`integration` is the workspace contract-test package. It is not part of the production runtime; it verifies that the packages can be built, imported, and used together the way downstream consumers will use them.

## What It Does

- Builds dependent packages before running integration checks.
- Verifies import boundaries for published package entry points.
- Exercises `operative` and `operative/store` through consumer-style tests.
- Runs a Node.js runtime test in addition to Bun tests.
- Catches package-shape and runtime compatibility regressions that package-local unit tests can miss.

## How It Works

The `transit` script builds `armorer`, `conversationalist`, and `operative` from their source before the tests run—so every import resolves to real distribution output, not TypeScript source. `scripts/run-tests.ts` then sequences three Bun test files followed by a Node.js compatibility run.

This package intentionally tests from package boundaries instead of source internals. If an export map, build script, CommonJS output, or runtime assumption breaks consumers, the integration package is where that failure should surface.

## Running the Suite

### From this package directory

```bash
# Build dependencies, then run all integration tests (Bun + Node)
bun run validate
```

`validate` expands to:

```bash
bun run transit      # builds armorer, conversationalist, operative
bun run test         # runs scripts/run-tests.ts
bun run check-types  # TypeScript type-check
bun run lint         # ESLint
```

You can run individual steps in isolation:

```bash
# Rebuild just the dependency graph
bun run transit

# Run only the test files (requires transit to have run first)
bun run test

# Type-check without running tests
bun run check-types
```

### From the repository root

```bash
# Equivalent workspace gate—runs the full validate pipeline via Turborepo
bun run integration
```

## What `test` Runs

`scripts/run-tests.ts` executes these test files in order:

| File                                            | Runner  | What it checks                                                                     |
| ------------------------------------------------ | ------- | ----------------------------------------------------------------------------------- |
| `test/import-boundary.test.ts`                  | Bun     | Published entry points resolve and export the expected shapes                       |
| `test/operative.test.ts`                        | Bun     | `operative` consumer-style run behavior from dist output                            |
| `test/operative-store.test.ts`                  | Bun     | `operative/store` consumer-style store behavior from dist output                    |
| `test/sandbox-embedding.test.ts`                | Bun     | AB-97 single-file bundle + filesystem/network isolation, against a mock endpoint    |
| `test/tribunal-conformance.test.ts`             | Bun     | AB-99 Tribunal runner conformance: deny-gate, budget stop, cache-read observability |
| `test/tribunal-conformance-providers.test.ts`   | Bun     | AB-99 two-provider parity (Anthropic-mock / OpenAI-mock), same agent definition     |
| `test/tribunal-conformance-generality.test.ts`  | Bun     | AB-99 non-PR runs, per-role structured output, SIGTERM partial result               |
| `test/runtime.test.mjs`                         | Node.js | CommonJS/ESM compatibility and runtime assumptions under Node                       |

The Node.js binary is located automatically—`$NODE_BINARY`, `$NODE`, `Bun.which('node')`, and common install paths are all tried. The suite fails loudly if no Node binary is found.

## Project Role

Most packages prove their own behavior with unit tests. `integration` proves the larger Agent Bureau package graph: `armorer`, `conversationalist`, `operative`, and `operative/store` must remain usable together after build output and runtime boundaries are involved.
