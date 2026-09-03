---
'@lostgradient/operative': minor
---

Add `closed()` cleanup acknowledgement to `SessionHandle` and `AgentScheduleHandle` (AB-210, building on AB-204's `CleanupAcknowledgement` vocabulary).

`SessionHandle.closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>` is scoped to what the handle itself tracks: it resolves `{ status: 'not-required' }` immediately when no run is currently live on the handle, and otherwise delegates to the live run's own `AgentRun.closed()`, returning the identical `CleanupAcknowledgement` object by reference. This is deliberately not the full-run-history acknowledgement across every run a session has ever owned — `@lostgradient/operative` has no dependency on the Bureau session store, so that acknowledgement remains Bureau's responsibility.

`AgentScheduleHandle.closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>` mirrors `cancel()`'s own terminal-state semantics: it resolves `{ status: 'completed' }` once this handle's own `cancel()` call settles, and never resolves spontaneously for a schedule that has not been cancelled — even after a scheduled fire completes. It never waits on a separately-tracked in-flight fire: a fire dispatched before `cancel()` and still running is an ordinary run, reachable and awaitable through its own `closed()`, not through the schedule definition's handle. A `cancel()` call that itself rejects — the underlying engine call throws — resolves `closed()` as `{ status: 'failed', error }` rather than leaving it pending forever, since a failed cancellation attempt is a genuine, observed problem and not something to silently swallow into "stays pending".

`SessionHandle.sleep()` and `SessionHandle.monitor()` were verified (no code change) to already conform to AB-38's "cancel inter-attempt sleep and validation immediately" requirement.
