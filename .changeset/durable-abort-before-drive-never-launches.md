---
'@lostgradient/operative': patch
---

Fix a durable `ActiveRun` reporting a false, unrecoverable cleanup leak when `abort()` is called before its deferred drive microtask fires (AB-339).

`createDurableActiveRun`'s deferred start unconditionally called `context.engine.start(...)` — durably launching the workflow — even when the run had already been aborted before that microtask ran. A caller (or Bureau's own catalog dispatch path) that aborted this early raced the just-launched workflow against any concurrent teardown of the durable engine; if the engine was disposed first, `closed()` classified the run `{ status: 'unresolved', reason: 'unreachable' }` instead of a clean `{ status: 'completed' }`, even though the run never did anything durable.

`drive()` now snapshots whether the combined abort signal was already aborted in the same synchronous step that flips `driveStarted` true, and skips `context.engine.start` entirely when it was — firing the same `run.started`/`onRunStart`/`run.aborted`/`onRunAbort` lifecycle a normal abort produces, but through a write-free path. `resolveDurableOutcome` recognizes this case (`neverLaunched`) and reports `{ status: 'completed' }` directly, without attempting an `engine.cancel`/`engine.get` re-read against a workflow the engine never saw.
