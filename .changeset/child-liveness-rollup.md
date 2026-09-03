---
'@lostgradient/operative': minor
---

Adds AB-216's (obs-03) child-liveness rollup: `LivenessSnapshot` gains an optional `worstChildAssessment?: LivenessAssessment` field — the most severe assessment among a run's non-terminal children, most severe first (`unreachable` > `alive-but-stalled` > `aborting` > `cleaning-up` > `legitimately-waiting` > `healthy`), or absent when there are no children or every child is terminal.

The rollup is opt-in and registry-driven, matching `children()`/`abortChild()`'s own opt-in pattern (AB-50): a run supplied a `ChildRunRegistry` via `RunOptions.childRegistry` folds that registry's live children on every child-side liveness change. `dispatchChildRun` now attaches each dispatched child's own `LivenessObservable` to the registry (`ChildRunRegistry.attachLiveness`), which keeps the new `ChildRunDescriptor.assessment` field current and notifies the parent's rollup (`ChildRunRegistry.subscribeLiveness`) — recomputed from the registry's full current child set every time, never incrementally. The parent's own `revision` advances whenever the folded value changes, even when none of the parent's own dimensions did.

A stalled or unreachable child never changes the parent's own `reachability`/`progress`/`status` — only `worstChildAssessment` reflects it. A child's own `StallPolicy` selection, cadence, and watchdog instance are never read, overridden, or substituted by the parent's aggregation: each child is classified exclusively by its own `createStallWatchdog` instance against its own applicable `StallPolicy` row, and the parent only reads that child's already-computed `assessment`.

Additive only — no existing `LivenessSnapshot`, `ChildRunDescriptor`, or `ChildRunRegistry` member changes shape or behavior; a run that never supplies `childRegistry` sees `worstChildAssessment` stay permanently absent.
