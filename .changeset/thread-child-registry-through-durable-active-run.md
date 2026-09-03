---
'@lostgradient/operative': patch
---

Thread `RunOptions.childRegistry` through the durable `ActiveRun` path (AB-304).

`createDurableActiveRun` and `reattachDurableActiveRun` (`packages/operative/src/durable/active-run-adapter.ts`) now accept and forward `childRegistry` — a `ChildRunRegistry` supplied via `RunOptions.childRegistry` for a fresh durable run, or via the reattach options for a recovered one. A durable parent's `closed()` folds `ChildRunRegistry.awaitChildrenClosed()` into its outcome alongside the AB-291 hook and cancel waits, and its `hasInFlightWork` treats a registered child as in-flight work — matching AB-211's in-memory `createActiveRun` behavior exactly, including for a child dispatched onto the same registry after a reattach/recovery. A durable run with no `childRegistry`, or zero registered children, behaves identically to before this change, with no added latency.
