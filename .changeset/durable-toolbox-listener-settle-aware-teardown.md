---
'@lostgradient/operative': patch
---

Regression coverage for the durable `ActiveRun`'s toolbox listener teardown (AB-317): both `createDurableActiveRun` and the reattached driver (`createRecoveredRunEventSurface` → `reattachDurableActiveRun`) already remove their `execute-start`/`settled`/`progress`/`policy-denied` toolbox listeners on the same settle-aware boundary the in-memory path uses — the run's own terminal settlement — never on the abort signal alone. New tests pin this down: aborting a durable run with an in-flight tool whose armorer `settled` event arrives on a later microtask than the synchronous `abort()` call still delivers that event to the adapter, for both drivers.
