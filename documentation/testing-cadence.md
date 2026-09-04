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

| Suite                                                    | Root command                                                                                               | Pull-request lane (`ci.yml`)                                                  | Nightly lane (`nightly.yml`)                                        | Release evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, types, unit and package tests              | `bun run validate`                                                                                         | `validate` job, every pull request                                            | not repeated                                                        | Required on every merge to `main`; the baseline gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 100% line/function coverage (gated packages)             | `bun run coverage:check`                                                                                   | `coverage-and-package-shape` job, every pull request                          | not repeated                                                        | Required on every merge; AB-13/AB-27 own this gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Package-shape and packed-consumer verification           | `bun run check-package-shape`, `bun run test:consumer:operative`, `bun run verify:bureau:tarball-boundary` | `coverage-and-package-shape` job, every pull request                          | not repeated                                                        | Required on every merge; AB-23 owns this gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Black-box lifecycle contract matrix (tst-05a)            | `bun run integration`                                                                                      | `lifecycle-contract` job, every pull request                                  | not repeated                                                        | Required on every merge; proves every adapter (direct, session, in-memory, durable, recovered Bureau) satisfies the shared lifecycle invariants AB-268 registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Gateway real-transport conformance (full)                | `bun run test:gateway-conformance`                                                                         | `validate` job's own step, every pull request (AB-272 wired this in directly) | `gateway-conformance-full` job, nightly                             | Every pull request already runs the full lane—it is small enough that no reduced pull-request-lane subset exists. The nightly run re-executes the same full lane on a schedule independent of pull-request volume, so a flake that only reproduces under nightly's idle-runner conditions (no concurrent pull-request traffic contending for the loopback port range) still surfaces regularly even during a quiet week with few pull requests.                                                                                                                                                                                                                 |
| Process-crash recovery: single smoke scenario            | `bun run test:crash-conformance -- --test-name-pattern smoke`                                              | `crash-conformance-smoke` job, every pull request                             | not repeated (the full matrix below supersedes it)                  | Required on every merge; proves the harness's own honesty floor—a genuinely `SIGKILL`ed process recovers a committed effect at the `'checkpoint-committed'` marker, and a `'run-started'` control killed earlier never does.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Process-crash recovery: full marker matrix, all backends | `bun run test:crash-conformance`                                                                           | not run (AB-100 explicitly rules out every permutation on every pull request) | `crash-conformance-full` job, nightly                               | Required release evidence: every named marker (`ready`, `child-registered`, `checkpoint-committed`, `effect-attempted`, `signal-parked`, `cancellation-recorded`, `cleanup-completed`) recovers cleanly. **SQLite only until AB-271 lands**—AB-271 (LMDB, concurrent children, schedule-fire, and recovery-failure scenarios) is still Backlog on this baseline; `packages/integration/test/crash/` has no `lmdb.test.ts` yet, so `test:crash-conformance`'s `bun test packages/integration/test/crash` glob covers exactly the one file that exists. The LMDB lane joins this same root command automatically the day AB-271 merges—no workflow change needed. |
| Cloudflare real-runtime conformance (workerd/Miniflare)  | `bun run test:cloudflare-conformance`                                                                      | not run                                                                       | `cloudflare-conformance` job, nightly, Linux-only (`ubuntu-latest`) | Required release evidence: the real Durable Object SQLite, R2, and Vectorize-compatible bindings behave per AB-276's shared behavior contract, not only the fast Bun doubles the pull-request lane already exercises through `validate`.                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Why the reduced pull-request-lane subsets are honest, not weaker

- **Crash smoke is a real kill, not a mock.** The `[smoke]`-tagged scenario in
  `packages/integration/test/crash/sqlite.test.ts` still launches two real,
  separate OS processes and sends a real `SIGKILL`. It is a size reduction
  (one marker pair instead of seven-plus-backends), never a fidelity
  reduction—nothing about the pull-request-lane scenario is faked or
  stubbed relative to the nightly matrix.
- **The contract matrix and gateway lane run in full on every pull request**
  because neither is expensive enough to need a reduced subset. Nightly
  re-running gateway conformance is about schedule independence from
  pull-request volume, not about running something bigger.
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
(`${{ runner.temp }}/reproduction-artifacts/` in both jobs). No suite writes
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
trigger the full crash, gateway, and Cloudflare lanes without waiting for
the 09:00 UTC schedule:

```sh
gh workflow run nightly.yml
gh run list --workflow nightly.yml --limit 1
```
