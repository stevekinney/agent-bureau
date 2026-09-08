---
'@lostgradient/operative': patch
---

Fix `createScheduler`'s idle-delay gate misreading a task completion at monotonic clock zero as "no task has ever completed" (AB-357, decided by AB-92).

`create-scheduler.ts` tracked the timestamp of the most recently completed task in `lastTaskCompletedAt`, a plain `number` initialized to `0` and doubling as its own "never completed" sentinel (`lastTaskCompletedAt > 0`). Against a real wall clock this is never ambiguous, but a manual runtime's monotonic clock (used in tests, and by any `RuntimeServices` implementation that starts its clock at `0`) can stamp a completely legitimate first completion at exactly `0`, which the strictly-positive check misread as "never completed" — silently skipping the idle-delay gate for the very next task instead of applying it. `lastTaskCompletedAt` is now typed `number | undefined`, with `undefined` as the explicit "no task has completed yet" sentinel, so a completion timestamp of `0` is treated identically to any other completion.
