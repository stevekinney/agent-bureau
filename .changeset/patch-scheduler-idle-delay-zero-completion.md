---
'@lostgradient/operative': patch
---

Fix the scheduler's idle-delay gate reading a task completion stamped at manual clock zero as "never completed". `lastTaskCompletedAt` is now `number | undefined`, with `undefined` as the never-completed sentinel, instead of gating on `lastTaskCompletedAt > 0`.
