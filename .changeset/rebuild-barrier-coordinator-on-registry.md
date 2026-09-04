---
'@lostgradient/operative': minor
---

Rebuild the scripted doubles' internal `BarrierCoordinator` on `createBarrierRegistry` (AB-266) instead of a second, duplicate barrier implementation (AB-319).

`createScriptedGenerate`, `createScriptedTool`, and `createScriptedHook` now expose a new `barriers: BarrierRegistry` field: `reached`/`release` for a `block` step delegate to `barriers.barrier(name)`, so a test can obtain the exact same named `Barrier` a scripted double's block step arrives at and released through — `barrier.inspect()` and `barrier.reached()` observe the double's own coordination point directly, with no bridge required. Every previously public export is unchanged; `BarrierCoordinator` itself was never re-exported from `@lostgradient/operative/test` and remains an internal implementation detail shared between the scripted doubles.
