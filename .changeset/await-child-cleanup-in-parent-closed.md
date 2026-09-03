---
'@lostgradient/operative': minor
---

A parent's `closed()` now awaits child cleanup (AB-211, extending AB-50's `ChildRunRegistry` and AB-204's `closed()`).

For an in-memory run started with `RunOptions.childRegistry` (`createActiveRun`, and `AgentRun`/`DiagnosticAgentRun` through it), `closed()` no longer resolves `{ status: 'completed' }` while any registered child's own `closed()` is still pending — not merely while the child's `result()` is unresolved. A run with no `childRegistry`, or one with zero registered children, behaves identically to before this change, with no added latency; aborting one child (`abortChild`) never affects an untouched sibling's own path to settlement.

`packages/operative/src/child-run.ts`'s `ChildRunRegistry` gains a new read method, `awaitChildrenClosed(): Promise<void>`, resolving once every currently-registered child's own `closed()` has settled (folding in a child registered while the call is already pending). `MutableChildRunRegistry` gains the matching registrar step, `attachClosed(id, closed)`, which `dispatchChildRun` now calls right after `agent.run()` returns, guarded by a runtime check that the returned handle actually implements `closed()` (mirroring the existing `attachLiveness`/`hasLivenessObservable` guard). Both are additive: `createChildRunRegistry()` implements them, `isMutableChildRunRegistry` checks for them, and neither changes `children()`, `abortChild()`, or any child lifecycle event.

Declared gap, not introduced by this change: the durable `ActiveRun` path (`createDurableActiveRun`/`reattachDurableActiveRun`) does not thread `RunOptions.childRegistry` through at all yet, so a durable parent's `closed()` does not await its children.
