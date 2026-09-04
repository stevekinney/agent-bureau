---
'@lostgradient/operative': minor
---

Move the canonical `ReproductionArtifact` declaration (AB-92 AC8) down into `@lostgradient/operative/test`, parameterized over `cleanupReport` (`ReproductionArtifact<TCleanupReport = ReproductionCleanupReport>`), so `bureau`'s widened variant — which adds `BureauShutdownReport` to the union — instantiates the shared shape instead of redeclaring it (AB-334).

`ReproductionCleanupReport` (`CleanupAcknowledgement | DeferredDrainReport`) is a new named export from `@lostgradient/operative/test`, giving a caller that widens `TCleanupReport` something to compose onto instead of repeating its members. `writeReproductionArtifact`, `readReproductionArtifact`, and `replayReproductionArtifact` are now generic over `TCleanupReport`; `readReproductionArtifact` returns `ReproductionArtifact<unknown>` since it does not validate that field's shape.

`bureau`'s own `ReproductionArtifact` and `ScriptedOutcome` interfaces are deleted; `bureau/test` now re-exports `ScriptedOutcome` from operative and exports `ReproductionArtifact` as a type alias instantiating operative's declaration with Bureau's own `cleanupReport` union. No behavior change: `assembleReproductionArtifact`'s signature and the committed fixture are unaffected.
