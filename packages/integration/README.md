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

## Process-Crash Recovery Conformance (AB-270, extended to LMDB and the harder scenarios by AB-271)

`test/crash/` launches `fixture.ts` as a real, separate OS process against a
unique temporary persistent backend — SQLite or LMDB, `runCrashScenario`'s
`backend` option — `SIGKILL`s it at a named marker (`test/crash/protocol.ts`'s
`CrashMarker`), and launches a fresh process over the same backend path to
prove recovery, fencing, event continuity, idempotency, and final resource
release — the crash-recovery tier AB-92's test-tier matrix assigns its own
command:

```bash
# Full matrix (eleven scenarios, defined once in test/crash/scenarios.ts and
# driven identically against SQLite (sqlite.test.ts) and LMDB
# (lmdb.test.ts)) — the stable root command
bun run test:crash-conformance

# Smoke-only (the kill-vs-control honesty pair, over BOTH backends) — what
# `bun run test` here and CI's pull-request lane both run; the full matrix
# runs at tst-09e's cadence
bun test test/crash --test-name-pattern smoke
```

`test/crash/scenarios.ts` (AB-271) is the shared scenario list both backend
files consume — `sqlite.test.ts` and `lmdb.test.ts` are now thin `for`-loops
over it, so the two backends can never silently drift onto different marker
matrices. Seven scenarios are AB-270's original matrix (the `[smoke]` pair,
`ready`, `child-registered`, `effect-attempted`, `signal-parked`,
`cancellation-recorded`, `cleanup-completed`); four are AB-271's own scope —
nested children (two live children, cascade-aborted through this fixture's
own explicit `abortRun` loop, since Bureau exposes no native durable
parent→child cancellation), a schedule definition surviving a crash (the
schedule is registered via `bureau.createSchedule`, and its crash survival
is proven through `bureau.getSchedule` post-recovery; the root run's own
`perform-effect` step, unrelated to the schedule, separately re-proves the
existing exactly-once guarantee. This scenario does NOT drive an actual
schedule fire — Bureau's recurring poller cannot be driven deterministically
through any public surface — WFT-141, verified directly: a throwaway probe
repeatedly calling `bureau.runDurableMaintenance` against a registered
schedule never fired it. AB-97's "running schedule fire" acceptance
criterion is therefore only partially covered here; see the scenario's own
comment in `scenarios.ts` for the honest scope), a signal-parked resume with
a pre-kill signal delivery (proving no double-delivery), and the
AB-29 recovery-failure scenario (a second process missing the catalog agent
its recovered `bureau.run()` dispatch needs, observed failing through
`bureau.getDurableRun`'s `error`/`failureCategory` fields — never a bare
`null`). No LMDB-specific incapability was found for any of the eleven; the
full matrix runs unmodified on both backends. `harness.ts`'s
`CrashHarnessUnsupportedBehaviorError` stays exported as a typed escape
hatch for a future gap.

`test/crash/harness.ts` exports `runCrashScenario` (the parent driver) and
`test/crash/fixture.ts` is the child-process entry point; neither is part of
this package's own suite sequencing described above beyond the smoke
scenarios `scripts/run-tests.ts` includes.

`fixture.ts` also accepts an optional `--gateway` flag (AB-275): it starts a
real `Gateway` (a real `Bun.serve` loopback listener on an OS-assigned
ephemeral port) over the same bureau, sharing this fixture's own
`ManualRuntimeServices`, and reports the bound port as `detail.gatewayPort`
on its `'ready'` marker. `runCrashScenario`'s own `CrashScenarioOptions`
carries a matching `gateway?: boolean` to launch both processes with the
flag, and an `onMarker` hook — invoked for every marker either process
reports, before the harness decides how to answer it — so a caller can drive
out-of-band work (a real HTTP/SSE/WebSocket client against the fixture's
gateway) bracketed around one marker without re-implementing this file's own
stdin/stdout pacing loop. `packages/gateway/src/conformance/restart.test.ts`
(AB-275) is the one consumer today: it reaches these exports via a relative
import rather than a workspace dependency, since `gateway` depending on
`integration` would be circular (`integration` already depends on `gateway`
to start the fixture's own gateway).

## Project Role

Most packages prove their own behavior with unit tests. `integration` proves the larger Agent Bureau package graph: `armorer`, `conversationalist`, `operative`, and `@lostgradient/operative/store` must remain usable together after build output and runtime boundaries are involved.
