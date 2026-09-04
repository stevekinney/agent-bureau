# Integration

`integration` is the workspace contract-test package. It is not part of the production runtime; it verifies that the packages can be built, imported, and used together the way downstream consumers will use them.

## What It Does

- Builds dependent packages before running integration checks.
- Verifies import boundaries for published package entry points.
- Exercises `operative` and `@lostgradient/operative/store` through consumer-style tests.
- Runs a Node.js runtime test in addition to Bun tests.
- Catches package-shape and runtime compatibility regressions that package-local unit tests can miss.

## How It Works

The `transit` script builds `armorer`, `conversationalist`, and `operative` from their source before the tests run—so every import resolves to real distribution output, not TypeScript source. `scripts/run-tests.ts` then sequences the Bun test files and directories listed below, followed by a Node.js compatibility run.

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

| File                                           | Runner  | What it checks                                                                                                |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `test/import-boundary.test.ts`                 | Bun     | Published entry points resolve and export the expected shapes                                                 |
| `test/operative.test.ts`                       | Bun     | `operative` consumer-style run behavior from dist output                                                      |
| `test/operative-store.test.ts`                 | Bun     | `@lostgradient/operative/store` consumer-style store behavior from dist output                                |
| `test/sandbox-embedding.test.ts`               | Bun     | AB-97 single-file bundle + filesystem/network isolation, against a mock endpoint                              |
| `test/tribunal-conformance.test.ts`            | Bun     | AB-99 Tribunal runner conformance: deny-gate, budget stop, cache-read observability                           |
| `test/tribunal-conformance-providers.test.ts`  | Bun     | AB-99 two-provider parity (Anthropic-mock / OpenAI-mock), same agent definition                               |
| `test/tribunal-conformance-generality.test.ts` | Bun     | AB-99 non-PR runs, per-role structured output, SIGTERM partial result                                         |
| `test/bureau-agent-definitions.test.ts`        | Bun     | AB-23 Bureau's typed `AgentDefinitions` catalog: direct, barrel, dynamic, and lazy-generate agents            |
| `test/anthropic-interop.test.ts`               | Bun     | Anthropic SDK adapter interoperability: tool-call parsing and message conversion against real SDK types       |
| `test/model-selection-contract.test.ts`        | Bun     | AB-251 cross-mode selection-plan replay and delegated-child attenuation contract, six entry points normalized |
| `test/readme-test-sequencing.test.ts`          | Bun     | AB-283 asserts every file this table registers also appears as a row in this table                            |
| `test/lifecycle-contract/`                     | Bun     | AB-268 shared lifecycle-invariant matrix over the direct, `AgentRun`, session, and Bureau in-memory adapters  |
| `test/crash/sqlite.test.ts` (smoke scenario)   | Bun     | AB-270 process-crash recovery smoke check (see below)                                                         |
| `test/runtime.test.mjs`                        | Node.js | CommonJS/ESM compatibility and runtime assumptions under Node                                                 |

The Node.js binary is located automatically—`$NODE_BINARY`, `$NODE`, `Bun.which('node')`, and common install paths are all tried. The suite fails loudly if no Node binary is found.

## Process-Crash Recovery Conformance (AB-270, LMDB backend AB-335)

`test/crash/` launches `fixture.ts` as a real, separate OS process against a
unique temporary persistent backend — SQLite or LMDB, `runCrashScenario`'s
`backend` option — `SIGKILL`s it at a named marker (`test/crash/protocol.ts`'s
`CrashMarker`), and launches a fresh process over the same backend path to
prove recovery, fencing, event continuity, idempotency, and final resource
release — the crash-recovery tier AB-92's test-tier matrix assigns its own
command:

```bash
# Full matrix (SQLite's 7-scenario marker matrix in sqlite.test.ts, plus
# LMDB's 1-scenario lmdb.test.ts) — the stable root command
bun run test:crash-conformance

# Smoke-only (1 SQLite scenario) — what `bun run test` here and CI's
# pull-request lane both run; the full matrix runs at tst-09e's cadence
bun test test/crash/sqlite.test.ts --test-name-pattern smoke
```

`test/crash/lmdb.test.ts` (AB-335) covers only the one scenario that exposed
an LMDB-specific defect ("killed at child-registered") — extracting a shared
scenario list so every marker in the matrix runs over both backends is
AB-271's scope.

`test/crash/harness.ts` exports `runCrashScenario` (the parent driver) and
`test/crash/fixture.ts` is the child-process entry point; neither is part of
this package's own suite sequencing described above beyond the one smoke
scenario `scripts/run-tests.ts` includes.

## Project Role

Most packages prove their own behavior with unit tests. `integration` proves the larger Agent Bureau package graph: `armorer`, `conversationalist`, `operative`, and `@lostgradient/operative/store` must remain usable together after build output and runtime boundaries are involved.
