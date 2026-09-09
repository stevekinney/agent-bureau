# Testing cadence

AB-92's Decision (2026-09-01) fixes six test tiers, from pure unit up through
process-crash recovery, real-runtime conformance, and packed-consumer
verification. AB-100 rules out running every tier's full matrix on every
pull request—the slowest lanes (a real process kill and restart, a real
Cloudflare workerd/Miniflare runtime boot) would push the pull-request
lane's wall-clock cost far past what a contributor should wait on for
feedback that is mostly redundant with a smoke-scale subset. This document
is AB-282's own acceptance criterion: which suite runs where, why, and what
release evidence each one provides, written down once instead of left for a
release reviewer to reverse-engineer from `.github/workflows/*.yml`.

## Where each suite runs

| Suite                                                           | Root command                                                                                               | Pull-request lane (`ci.yml`)                                                                                                   | Nightly lane (`nightly.yml`)                                        | Release evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, types, unit and package tests                     | `bun run validate`                                                                                         | `validate` job, every pull request                                                                                             | not repeated                                                        | Required on every merge to `main`; the baseline gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 100% line/function coverage (gated packages), minus `[nightly]` | `bun run coverage:check`                                                                                   | `coverage-and-package-shape` job, every pull request                                                                           | not repeated                                                        | Required on every merge; AB-13/AB-27 own this gate. `scripts/check-coverage.ts` invokes `bun test --coverage` per package directly rather than through a package's own filtered `test` script, so it applies `scripts/nightly-test-pattern.ts`'s shared `NIGHTLY_TEST_NAME_PATTERN` itself (AB-356)—the same TypeScript constant `packages/gateway/package.json`'s `test` script imports (via `scripts/run-tests-excluding-nightly.ts`), not a second copy of the pattern—so the coverage gate follows the pull-request lane's `[nightly]` tag filter and never separately re-executes gateway's restart-and-replay conformance scenario.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Package-shape and packed-consumer verification                  | `bun run check-package-shape`, `bun run test:consumer:operative`, `bun run verify:bureau:tarball-boundary` | `coverage-and-package-shape` job, every pull request                                                                           | not repeated                                                        | Required on every merge; AB-23 owns this gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Black-box lifecycle contract matrix (tst-05a)                   | `bun run integration`                                                                                      | `lifecycle-contract` job, every pull request                                                                                   | not repeated                                                        | Required on every merge; proves every adapter (direct, session, in-memory, durable, recovered Bureau) satisfies the shared lifecycle invariants AB-268 registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Gateway real-transport conformance, minus `[nightly]`           | `bun run test:gateway-conformance -- --test-name-pattern "^(?!.*\[nightly\])"`                             | `validate` job's own step, every pull request (AB-272 wired this in directly)                                                  | not repeated (the full lane below supersedes it)                    | Every scenario except the real-process restart lane runs on every pull request—every other scenario in this suite is small enough that no reduced subset was needed until AB-275 added one that boots two real OS processes. The exclusion is a negative-lookahead `--test-name-pattern`, the mirror image of the crash lane's own `smoke` inclusion pattern: keep everything whose test name does NOT contain `[nightly]`. `packages/gateway/package.json`'s own `test` script runs `scripts/run-tests-excluding-nightly.ts`, a thin `bun test` wrapper importing `scripts/nightly-test-pattern.ts`'s `NIGHTLY_TEST_NAME_PATTERN` constant (AB-356)—the same constant `scripts/check-coverage.ts` imports, so `turbo run test --filter=gateway` (part of `bun run validate`) and `bun run coverage:check` exclude it too from one TypeScript source. This row's own `ci.yml` step still carries the pattern as a literal string, because a workflow `run:` line cannot import a TypeScript constant; it is kept textually identical to the shared one, not a maintained-separately copy. |
| Gateway restart and durable-history replay (AB-275)             | `bun run test:gateway-conformance`                                                                         | not run (excluded by the row above's pattern)                                                                                  | `gateway-conformance-full` job, nightly (runs the lane unfiltered)  | Required release evidence: a real `SIGKILL`, a fresh process over the same SQLite backend, and the durable-history paging-to-tailing boundary proven gap-free and duplicate-free (by stable event identity, never a sequence number) over both SSE and WebSocket, honesty-checked by a deliberate off-by-one. The nightly run also re-executes every OTHER gateway scenario the row above already covers on every pull request—this row names only what is NEW to the nightly-only lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Process-crash recovery: single smoke scenario                   | `bun run test:crash-conformance -- --test-name-pattern smoke`                                              | `crash-conformance-smoke` job, every pull request                                                                              | not repeated (the full matrix below supersedes it)                  | Required on every merge; proves the harness's own honesty floor—a genuinely `SIGKILL`ed process recovers a committed effect at the `'checkpoint-committed'` marker, and a `'pre-dispatch'` control killed before `bureau.createRun` is even called never does (AB-361: `'run-started'` moved out of the control role once `createRun`'s durable branch began resolving only after the engine's initial workflow record commits, making a kill there recoverable by contract rather than a "nothing durable" control).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Process-crash recovery: full marker matrix, all backends        | `bun run test:crash-conformance`                                                                           | not run (AB-100 explicitly rules out every permutation on every pull request)                                                  | `crash-conformance-full` job, nightly                               | Required release evidence: every named marker (`ready`, `child-registered`, `checkpoint-committed`, `effect-attempted`, `signal-parked`, `cancellation-recorded`, `cleanup-completed`) recovers cleanly. **SQLite's full marker matrix; LMDB covers one scenario until AB-271 lands**—AB-335 added `packages/integration/test/crash/lmdb.test.ts` and the LMDB backend to `runCrashScenario`, but scoped to only the one scenario ("killed at child-registered") that exposed an LMDB-specific defect; AB-271 (concurrent children, schedule-fire, and recovery-failure scenarios, plus extracting a shared scenario list so every marker runs over both backends) is still Backlog on this baseline. `test:crash-conformance`'s `bun test packages/integration/test/crash` glob already covers both `sqlite.test.ts` and `lmdb.test.ts`—no workflow change needed as AB-271's matrix grows.                                                                                                                                                                                              |
| Cloudflare real-runtime conformance (workerd/Miniflare)         | `bun run test:cloudflare-conformance`                                                                      | not run                                                                                                                        | `cloudflare-conformance` job, nightly, Linux-only (`ubuntu-latest`) | Required release evidence: the real Durable Object SQLite, R2, and Vectorize-compatible bindings behave per AB-276's shared behavior contract, not only the fast Bun doubles the pull-request lane already exercises through `validate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Targeted lifecycle mutation check (tst-09g)                     | `bun run check-mutation`                                                                                   | not run (re-runs the covering tests once per candidate mutant, per target set; AB-100 rules this out of the pull-request lane) | `mutation-check` job, nightly                                       | Required release evidence: proves the four AB-284 target sets (lifecycle transition tables, cancellation propagation, terminal-event uniqueness, cleanup-ownership resolution) are covered by an assertion that fails when the branch's _effect_ is wrong, not merely that a test _ran_ the branch — line/function coverage alone cannot show this. A surviving-mutant count above `scripts/mutation-baseline.json`'s recorded value fails the job; the baseline only moves down via `bun run mutation:baseline`, never by excluding a mutant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Repository gate scripts folded into `bun run validate`

A handful of repository-wide gates run as `bun run validate` steps rather than
as their own pull-request-lane row above, because each is a fast, static scan
with no suite to reduce for a smoke subset:

- `bun run check-determinism` (AB-278) re-lints `packages/**` with the two
  `determinism/*` ESLint rules in an isolated configuration where inline
  `eslint-disable` cannot bypass them, catching a real clock, timer,
  identifier, or randomness call, or a global transport mutation, outside
  `scripts/determinism-manifest.json`'s declared exemptions.
- `bun run check-skip-manifest` (AB-279) parses every test file's AST and
  fails on an unmanifested `.skip`/`.todo`/conditional early return, or any
  `.only` at all, per `scripts/skip-manifest.json`.
- `bun run check-test-helper-parity` (AB-280, enforcing AB-92 AC6) parses
  every `packages/*/test/**/*.ts` and `packages/*/src/**/*.test.ts` file's
  imports and fails on a cross-package import that reaches a path a target
  package's `package.json` `exports` map does not declare, unless
  `scripts/adapter-suite-manifest.json` names the importing file as a
  labeled adapter suite with a real black-box test proving the same
  guarantee through that package's public surface. A same-package import is
  never reported — a package's own unit tests, and its `src/test/` helper
  subpath, legitimately reach their own internals.
- `bun run check-runtime-matrix` (AB-283) checks every published package's
  declared `engines.node` floor against the Node versions CI actually
  exercises.

Each of these is a static analysis over source text or package metadata, not
a suite that executes application code, so there is no slow real-process or
real-network scenario to defer to a nightly lane the way the rows above do —
the full check runs on every pull request at effectively no added wall-clock
cost.

## Why the reduced pull-request-lane subsets are honest, not weaker

- **Crash smoke is a real kill, not a mock.** The `[smoke]`-tagged scenario in
  `packages/integration/test/crash/sqlite.test.ts` still launches two real,
  separate OS processes and sends a real `SIGKILL`. It is a size reduction
  (one marker pair instead of seven-plus-backends), never a fidelity
  reduction—nothing about the pull-request-lane scenario is faked or
  stubbed relative to the nightly matrix.
- **The contract matrix runs in full on every pull request** because it is
  not expensive enough to need a reduced subset.
- **Gateway restart is a real kill too, same as crash smoke.** AB-275's
  `[nightly]`-tagged scenario boots two real OS processes over a real
  Bun `Gateway` and sends a real `SIGKILL`, same as the crash lane's own
  smoke scenario—the exclusion from the pull-request lane is a cost
  reduction (this is the one scenario in the suite that boots a process
  pair; every other gateway scenario stays in-process), never a fidelity
  one. Every OTHER gateway scenario still runs in full on every pull
  request, because none of them is expensive enough to need a reduced
  subset—nightly re-running the whole lane (restart included) is about
  schedule independence from pull-request volume, not about running
  something bigger.
- **Cloudflare conformance is nightly-only** because booting a real
  workerd/Miniflare runtime is the single most expensive lane in the
  repository (AB-276's own operational notes name this as the rollback
  trigger if it ever pushes past budget), and the fast Bun doubles already
  run on every pull request through the ordinary `validate` job.

## Reproduction-artifact contract

A CI job step in both the `lifecycle-contract` and `crash-conformance-smoke`
jobs uploads (`actions/upload-artifact@v4`, `if: failure()`,
`if-no-files-found: ignore`) whatever a failing scenario wrote to the
directory named by the `REPRODUCTION_ARTIFACT_DIR` environment variable
(`${{ github.workspace }}/reproduction-artifacts/` in both jobs — deliberately
not dot-prefixed, since `actions/upload-artifact@v4` excludes hidden files
by default and the proof branch that validated this contract hit exactly
that gap). No suite writes
to that directory automatically today—the writer
(`writeReproductionArtifact`, exported from `@lostgradient/operative/test`,
AB-267) already exists and is proven against the committed
`packages/integration/test/fixtures/reproduction/baseline.json` fixture on
every pull request via `test:replay-artifact`, but nothing calls it from
inside a live failing test yet. This step is the consumer side of that
contract: the day a scenario starts calling `writeReproductionArtifact(join(Bun.env.REPRODUCTION_ARTIFACT_DIR ?? '.', '<name>.json'), artifact)`
on failure, its output becomes downloadable from the run page with no
further workflow change. See the pull request that added this document for
a proof branch demonstrating both halves together: a deliberately failing
lifecycle fixture that both prints the full ownership tree (via
`BureauQuiescenceError`'s rendered `QuiescenceReport`, thrown by
`packages/bureau/src/test/quiescence.ts`—no CI wiring needed, since the
report is the thrown error's own message and `bun test` prints it) and
writes a reproduction artifact the upload step picks up.

## Nightly failure handling

`nightly.yml` opens no issue automatically on failure. A red run is visible
on the repository's own Actions page and is required release evidence: a
release must not proceed while the most recent scheduled (or manually
dispatched) nightly run is red. No job in either workflow retries a failed
step or raises a timeout relative to the existing `validate` and
`coverage-and-package-shape` jobs (neither of which sets `timeout-minutes`)—a flaky nightly job is a defect to root-cause, which AB-100 states as a
non-goal to hide behind retries, never a limit to widen.

## Triggering a lane on demand

`nightly.yml` also runs on `workflow_dispatch`, so a release reviewer can
trigger the full crash, gateway, Cloudflare, and mutation-check lanes
without waiting for the 09:00 UTC schedule:

```sh
gh workflow run nightly.yml
gh run list --workflow nightly.yml --limit 1
```
