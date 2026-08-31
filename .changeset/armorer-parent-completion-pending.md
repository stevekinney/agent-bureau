---
'armorer': patch
---

Keep a toolbox execution unfinished while its tool callback is still running. A request deadline arms two independent timers for the same instant — one on the toolbox's parent execution and one on the tool's own execution — and when the tool's timer won the race the parent was never marked `abort-requested`, so the toolbox settled it from the raced timeout result while a cancellation-ignoring callback was still in flight. `whenIdle()` and `shutdown({ policy: 'drain' })` could therefore report drained while a tool callback was still executing. The toolbox now tracks the callback itself rather than inferring it from the parent's abort state.
