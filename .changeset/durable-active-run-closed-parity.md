---
'@lostgradient/operative': patch
---

Fix three `closed()` cleanup-acknowledgement gaps on the durable `ActiveRun` path (`createDurableActiveRun`) left open when AB-204 fixed them on the in-memory path (AB-291):

- `closed()` now awaits every run-owned hook's (`onRunStart`/`onRunAbort`/`onRunError`/`onRunComplete`) fire-and-forget promise before reporting `completed`, matching the in-memory loop's `pendingHookPromises` tracking.
- The caller-signal (`RunOptions.signal`) abort listener is now removed once the run reaches terminal state, so a long-lived signal a caller reuses across many runs no longer re-triggers `engine.cancel()` for an already-terminal durable workflow.
- A rejected `engine.cancel()` against a workflow genuinely parked in `ctx.sleep`/`ctx.waitForSignal` now resolves `closed()` with `{ status: 'failed', error }` instead of leaving it (and any caller awaiting it with no `signal` bound) hanging forever — the durable workflow's own `result` still reflects reality (it stays pending), but `closed()`'s own gate no longer depends solely on it.
