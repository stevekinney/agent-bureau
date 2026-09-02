---
'@lostgradient/operative': minor
---

Add `closed()` cleanup acknowledgement to `ActiveRun`, `AgentRun`, and `DiagnosticAgentRun` (AB-37, delivered by AB-204).

`closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>` lets a caller holding any of these three handles await a truthful cleanup result instead of only firing `abort()` and hoping. It never rejects and is idempotent — once the underlying cleanup has genuinely settled, a repeated call returns the identical cached `CleanupAcknowledgement` object by reference. `AgentRun.closed()` and `DiagnosticAgentRun.closed()` delegate to the wrapped `ActiveRun.closed()`; `DiagnosticAgentRun` downgrades a wrapped `completed` outcome to `unresolved`/`unknown-effect` (durability is undeterminable from a recovered wrapper — AB-88 owns handle identity) and passes every other outcome through unchanged.

`createDurableActiveRun(...).closed()` withholds `completed` until the post-cancel re-read of the durable engine's own record observes the committed `cancelled` transition, never merely because `engine.cancel` resolved without rejecting. `reattachDurableActiveRun(...).closed()` classifies an `EngineDisposedError` rejection of a pending `result()` waiter as `unresolved`/`unreachable`, never `failed`.

New public types: `CleanupAcknowledgement`, `CleanupAcknowledgementReason`, `ClosedOptions`.
