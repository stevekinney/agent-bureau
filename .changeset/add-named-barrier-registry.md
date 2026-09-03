---
'@lostgradient/operative': minor
---

Add the named barrier registry (`createBarrierRegistry`, `Barrier`, `BarrierRegistry`, `BarrierState`) to `@lostgradient/operative/test` (AB-266). A `Barrier` replaces a wall-clock sleep in a deterministic suite: the guarded operation calls `arrive()` and suspends until the test calls `release()`/`reject()`; the test calls `reached()` to know arrival happened without hanging on a late subscription, and `inspect()` to read arrival/release counts. `assertNoPending()` fails, naming every still-blocked barrier, when a test ends with an arrival nobody released. Every arrival, release, and rejection is recorded as a `CausalTraceEntry` (resource `barrier:<name>`, event `barrier.reached`/`barrier.released`/`barrier.rejected`) when an `EventRecorder` is supplied to `createBarrierRegistry(recorder?)`.
