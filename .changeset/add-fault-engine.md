---
'@lostgradient/operative': minor
---

Add the fault engine (AB-265) to `@lostgradient/operative/test`: `createFaultEngine(plan, runtime)` returns a `FaultEngine` exposing `wrapGenerate`, `wrapToolbox`, `wrapHooks`, `wrapStorage`, `fired()`, and `assertAllFired()`, which apply a `FaultPlan` (AB-92's decision, AB-257's vocabulary) at the model, tool, hook, and storage boundaries.

Eleven concrete effects are supported, each mapped onto exactly one `FaultBoundary`: `block` and `delay` (both `before-work`, suspending until release or until the injected `RuntimeServices` clock advances past the delay), `reject-before-work` (`before-work`), `fail-after-effect` (`after-effect`), `fail-before-commit` (`before-commit`), `fail-after-commit` (`after-commit`), `stale-read` (`stale-read`), `corrupt-payload` (`corrupt-payload`), `duplicate-delivery` (`duplicate-delivery`), `drop-acknowledgement` (`lost-acknowledgement`), and `ignore-abort` (`ignored-abort`). `process-death` is rejected at plan construction with a new `UnsupportedFaultBoundaryError`, naming AB-97 as that boundary's owner. `FaultOccurrence`'s three kinds (`nth`, `every`, `after-sequence`) are honored precisely against each matched operation. New exports from `@lostgradient/operative/test`: `createFaultEngine`, `FaultEngine`, `FaultEffect` and its eleven member interfaces, `FAULT_BOUNDARY_EFFECT_KINDS`, and `UnsupportedFaultBoundaryError`.

This is reusable test-kit surface only — no production code path changes behavior because a `FaultPlan` exists.
