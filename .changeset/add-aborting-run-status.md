---
'@lostgradient/operative': minor
---

Add `'aborting'` as a fifth `RunStatus` (AB-37, implemented by AB-205) — the transitional status a caller observes between an abort being requested and the run's own terminal event actually settling.

`RunStatus` (`packages/operative/src/store/types.ts`) widens from `'running' | 'completed' | 'error' | 'aborted'` to `'running' | 'aborting' | 'completed' | 'error' | 'aborted'`. `operative`'s own `Store`/`RunState` never write this value — the store still only ever transitions `'running'` directly to a terminal status when the run's own terminal event fires — so this change is additive and non-breaking for any code narrowing `RunStatus` today: `'aborting'` is surfaced by `bureau`'s `Bureau.abortRun` (AB-205), which now reports it synchronously while cleanup is in flight instead of fabricating a terminal `'aborted'` result before teardown has actually started.
