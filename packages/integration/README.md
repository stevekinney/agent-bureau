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
# Full matrix (twelve scenarios, defined once in test/crash/scenarios.ts and
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
`null`). The twelfth, `killed at run-started` (AB-361), is a positive
recovery scenario rather than a control: once `bureau.createRun`'s durable
branch resolves only after the engine's initial workflow record commits, a
kill at `run-started` always has a durable record to recover, so it proves
the SAME run resumes and its effect happens exactly once rather than
proving nothing durable exists. No LMDB-specific incapability was found for
any of the twelve; the full matrix runs unmodified on both backends.
`harness.ts`'s `CrashHarnessUnsupportedBehaviorError` stays exported as a
typed escape hatch for a future gap.

### Deterministic kill points: the parent→child hold (AB-354)

A `CrashMarker` kill point is only a fixed point in the child's execution if
the child cannot advance past it while the parent's `SIGKILL` is still in
flight. `child.kill('SIGKILL')` has real delivery latency under CPU
contention, and a fast child that keeps running after reporting a marker can
race ahead of a signal that has not yet landed — this is exactly how the
`[smoke]` pair's control scenario used to flake (AB-335 measured it at ~2 in
30 runs): the killed control sometimes showed progress past its kill marker
because the SIGKILL simply arrived late, not because anything was wrong with
recovery.

The fix holds the child at the marker instead of racing the signal.
`fixture.ts`'s `reportMarker` writes the marker line to stdout and then
`await`s the parent's next command on stdin before returning — the fixture's
own control flow cannot proceed past a marker without that acknowledgement.
`harness.ts`'s `driveProcess` acknowledges every marker before
`killAtMarker` with `{ type: 'proceed' }` (or `{ type: 'cancel' }` for
`signal-parked`, unless resuming), but for the `killAtMarker` marker itself
it normally sends no acknowledgement at all and issues `SIGKILL`
immediately: the child is left parked on its own `await
stdin.nextCommand()` with nothing ever arriving to resolve it, so it cannot
execute one more line of its own logic before the kill lands. The one
deliberate exception is `deliverSignalBeforeKill` (the `signal-parked
resume` scenario, AB-271): there, `driveProcess` writes and flushes
`{ type: 'proceed' }` at the kill marker itself before still issuing
`SIGKILL`, simulating a signal that was in flight the instant the process
died — the harness never confirms the dying child actually read or applied
that write before `SIGKILL` landed (`scenarios.ts`'s own comment allows for
either outcome), so this proves the write was in flight at the moment of
death, not that a consumed command is safe from replay. The scenario's own
assertions assume the unconsumed case — `report.first` shows exactly one
`signal-parked` marker and never reaches `cancellation-recorded`, and
recovery is asserted to reach a fresh `signal-parked` of its own before the
recovery assertions send a second `proceed` — so this scenario proves no
double-delivery for a write that was in flight but not yet applied when the
process died, not for every possible timing of that write. Outside that one
case, the control proves nothing
happened past the marker because the child was physically held there — not
because the signal happened to win a race.

This stdin hold is sufficient for `pre-dispatch` (AB-361): it is a marker
`fixture.ts` reports immediately after `ready` and strictly before
`bureau.createRun` is called, for every scenario kind that dispatches its
root run through `bureau.createRun` — which is every kind except
`recovery-failure`, whose root run instead goes through the catalog dispatch
path (`bureau.run()`/`harness.startRun`) and so never reports `pre-dispatch`
at all. A child held at `pre-dispatch` cannot have called `createRun` —
there is no path to reach the call after the marker report returns, because
the hold never lets that report return before the kill. Killing there is
therefore a genuine "nothing durable can exist" control, independent of how
fast or slow `SIGKILL` is actually delivered, because nothing but
`main()`'s own driver loop is running yet.

`killed at run-started` needs a second, narrower hold, because by that point
something else IS running: once `bureau.createRun`'s `durablyStarted`
settles, Weft's own durable engine can dispatch the root run's step-0
`generate` call on its own promise chain — independent of whether `main()`
has gotten around to reporting `'run-started'` and blocking on the stdin
hold above. Under scheduling contention the engine can reach
`register-child`/`register-children`/`register-schedule` (all of which run
before the `reportLock`-serialized `child-registered` write) before
`SIGKILL` lands, which recovery would see as a started-but-incomplete
idempotency claim — exactly the race the 2026-09-04 coordinator ruling on
this issue characterized once AB-361 made `run-started` itself durably
recoverable. `createFixtureGenerate`'s `waitForRunStartedRelease` gate
closes it from the child's side too: the root run's step-0 `generate` call
awaits the SAME hold `main()` releases only after `'run-started'`'s own
acknowledgement lands (or immediately, unconditionally, on every mode/kind
that never reports that marker at all — recovery mode, and the
`recovery-failure` kind's catalog path — so a recovered process replaying
step 0 never parks forever). A process killed at `run-started` therefore
keeps its engine parked before its very first tool dispatch for the rest of
its short life, no matter how long `SIGKILL` takes to land.

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
