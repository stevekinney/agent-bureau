---
'@lostgradient/operative': patch
---

Fixes `createActiveRunLiveness`'s `beginWait`/`endWait` reading the real wall clock for `lastTransitionAt` instead of the injected `RuntimeServices.clock` (AB-336 regression, caught when AB-325 collapsed the determinism gate's `packages/operative/src/**/*.test.ts` glob to the full `packages/operative/src/**`, which now also scans production source). Every other status transition (`setStatus`, `settle`) already derived `lastTransitionAt` from `runtime.clock.nowISO()`; `beginWait`/`endWait` now match, so a run's `lastTransitionAt` stays deterministic under a manual runtime through a declared wait and its resolution, the same as every other transition.
