# Integration

`integration` is the workspace contract-test package. It is not part of the production runtime; it verifies that the packages can be built, imported, and used together the way downstream consumers will use them.

## What It Does

- Builds dependent packages before running integration checks.
- Verifies import boundaries for published package entry points.
- Exercises `operative` and `sentinel` through consumer-style tests.
- Runs a Node.js runtime test in addition to Bun tests.
- Catches package-shape and runtime compatibility regressions that package-local unit tests can miss.

## How It Works

The `transit` script builds the packages that the integration tests import from their distribution output. `scripts/run-tests.ts` then runs the Bun test files and locates a Node.js binary for `node --test test/runtime.test.mjs`.

This package intentionally tests from package boundaries instead of source internals. If an export map, build script, CommonJS output, or runtime assumption breaks consumers, the integration package is where that failure should surface.

## Project Role

Most packages prove their own behavior with unit tests. `integration` proves the larger Agent Bureau package graph: `armorer`, `conversationalist`, `operative`, and `sentinel` must remain usable together after build output and runtime boundaries are involved.

## Development

Run package checks from this directory:

```bash
bun run validate
```

From the repository root, the equivalent workspace gate is:

```bash
bun run integration
```
