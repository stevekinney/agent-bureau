---
'@lostgradient/operative': minor
---

Add the bounded interleaving runner and the reproduction-artifact writer, reader, and replay core to `@lostgradient/operative/test` (AB-267).

`runBoundedSchedules(options)` enumerates every ordering of two or three named parties' barrier releases, deterministically sequenced by a seed, and stops at the first schedule whose scenario fails — never retrying, never running past `maximumSchedules`, never touching a real timer. `Schedule`, `BoundedScheduleOptions`, and `BoundedScheduleReport` carry the enumeration's shape; `InvalidPartyCountError` and `UnsupportedScenarioError` are the two typed failure modes (a bad party count, and a lifecycle scenario whose product surface does not yet exist on this baseline).

`writeReproductionArtifact`/`readReproductionArtifact` write and read AB-92's `ReproductionArtifact` shape as stable, fixed-key-order JSON — writing the same artifact twice produces byte-identical files. `replayReproductionArtifact` reconstructs a `ManualRuntimeServices` from an artifact's own `clockOrigin`/`identifierSeed`/`randomSeed`, re-runs the fixed baseline replay case, and asserts the replayed `firedFaults` and normalized `causalTrace` match the artifact's own, throwing `ReproductionArtifactMismatchError` naming the first mismatching entry. `assembleBaselineArtifact` and `runBaselineReplayCase` are exported so the fixture-generation recipe and the replay path share one case.

A new root command, `bun run test:replay-artifact -- <path>`, replays a committed artifact through `scripts/replay-reproduction-artifact.ts`; a committed fixture at `packages/integration/test/fixtures/reproduction/baseline.json` exercises it on every pull request via a new CI step.
